// src/reports/reports.controller.ts
import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

import { ReportsService, DailyNotesFilter } from './reports.service';
import { FileReportsService } from './file-reports.service';

type DownloadType =
  | 'staff-doc'
  | 'staff-pdf'
  | 'individual-doc'
  | 'individual-pdf';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly fileReportsService: FileReportsService,
  ) {}

  @Get('daily-notes')
  async getDailyNotes(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('staffId') staffId?: string,
    @Query('individualId') individualId?: string,
  ) {
    const filter: DailyNotesFilter = { from, to, staffId, individualId };
    const notes = await this.reportsService.getDailyNotes(filter);
    return { items: notes };
  }

  /**
   * GET /reports/daily-notes/:id
   */
  @Get('daily-notes/:id')
  async getDailyNoteDetail(@Param('id') id: string) {
    const dn = await this.reportsService.getDailyNoteDetail(id);
    if (!dn) throw new NotFoundException('DailyNote not found');
    return dn;
  }

  /**
   * Direct download DOC/PDF (no Google Drive)
   * GET /reports/daily-notes/:id/download/:type
   */
  @Get('daily-notes/:id/download/:type')
  async downloadDailyNoteReport(
    @Param('id') id: string,
    @Param('type') type: DownloadType,
    @Res() res: Response, // required param
    @Query('regen') regen?: string, // optional: ?regen=1
  ) {
    const allowed: DownloadType[] = [
      'staff-doc',
      'staff-pdf',
      'individual-doc',
      'individual-pdf',
    ];
    if (!allowed.includes(type)) {
      throw new BadRequestException('Invalid download type');
    }

    const dn = await this.reportsService.getDailyNoteForDownload(id);
    if (!dn) throw new NotFoundException('DailyNote not found');

    const forceRegen =
      regen === '1' || regen === 'true' || regen === 'yes' ? true : false;

    let filePath: string | null = null;
    let contentType = 'application/octet-stream';
    let ext = 'bin';

    // DOCX
    if (type === 'staff-doc') {
      contentType =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      ext = 'docx';
      filePath = dn.staffReportDocPath;

      if (forceRegen || !filePath) {
        filePath = await this.fileReportsService.generateStaffDocx(id);
      }
    }

    if (type === 'individual-doc') {
      contentType =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      ext = 'docx';
      filePath = dn.individualReportDocPath;

      if (forceRegen || !filePath) {
        filePath = await this.fileReportsService.generateIndividualDocx(id);
      }
    }

    // PDF (always regenerate to avoid stale fallback PDFs)
    if (type === 'staff-pdf') {
      contentType = 'application/pdf';
      ext = 'pdf';
      filePath = await this.fileReportsService.generateStaffPdf(id);
    }

    if (type === 'individual-pdf') {
      contentType = 'application/pdf';
      ext = 'pdf';
      filePath = await this.fileReportsService.generateIndividualPdf(id);
    }

    if (!filePath) {
      throw new NotFoundException('Report file path not available yet');
    }

    // Security: only allow serving files inside ./uploads
    const uploadsRoot = path.resolve(process.cwd(), 'uploads');
    const absPath = path.resolve(filePath);

    if (
      !absPath.startsWith(uploadsRoot + path.sep) &&
      absPath !== uploadsRoot
    ) {
      throw new BadRequestException('Invalid file path');
    }

    if (!fs.existsSync(absPath)) {
      throw new NotFoundException('Report file not found on server');
    }

    // Filename: YYYY-MM-DD - Individual - Service - DSP.ext
    const date = new Date(dn.date).toISOString().slice(0, 10);
    const individual = sanitizeName(dn.individualName || 'Individual');
    const service = sanitizeName(dn.serviceName || 'Service');
    const dsp = sanitizeName(dn.staffName || 'DSP');

    const downloadName = `${date} - ${individual} - ${service} - ${dsp}.${ext}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadName}"`,
    );

    const stream = fs.createReadStream(absPath);
    stream.pipe(res);
  }
}

function sanitizeName(input: string) {
  return input
    .replace(/[\\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
