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
   * ✅ PREVIEW
   * GET /reports/daily-notes/:id/preview
   * Returns SAME data used by DOC/PDF (Outcome from ISP/BSP included)
   */
  @Get('daily-notes/:id/preview')
  async previewDailyNote(@Param('id') id: string) {
    try {
      return await this.fileReportsService.getPreviewData(id);
    } catch (e: any) {
      throw new NotFoundException(e?.message || 'Preview not available');
    }
  }

  /**
   * Direct download DOC/PDF (no Google Drive)
   * GET /reports/daily-notes/:id/download/:type
   */
  @Get('daily-notes/:id/download/:type')
  async downloadDailyNoteReport(
    @Param('id') id: string,
    @Param('type') type: DownloadType,
    @Res() res: Response,
    @Query('regen') regen?: string,
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

    // normalize & security root
    const uploadsRoot = path.resolve(process.cwd(), 'uploads');

    const isWindowsAbsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p);

    const isSafeUploadsPath = (p: string) => {
      if (!p) return false;
      // reject obvious Windows path on Linux/Render (or mixed env)
      if (isWindowsAbsPath(p)) return false;

      const abs = path.resolve(p);
      return abs === uploadsRoot || abs.startsWith(uploadsRoot + path.sep);
    };

    // pick path + maybe auto-generate
    let filePath: string | null = null;
    let contentType = 'application/octet-stream';
    let ext = 'bin';

    // DOCX: generate if missing OR invalid OR ?regen=1
    if (type === 'staff-doc') {
      contentType =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      ext = 'docx';

      // If DB path exists but is NOT safe for this server => treat as missing
      const existing = dn.staffReportDocPath ?? null;
      const usable = existing && isSafeUploadsPath(existing) ? existing : null;

      filePath = usable;
      if (forceRegen || !filePath) {
        filePath = await this.fileReportsService.generateStaffDocx(id);
      }
    }

    if (type === 'individual-doc') {
      contentType =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      ext = 'docx';

      const existing = dn.individualReportDocPath ?? null;
      const usable = existing && isSafeUploadsPath(existing) ? existing : null;

      filePath = usable;
      if (forceRegen || !filePath) {
        filePath = await this.fileReportsService.generateIndividualDocx(id);
      }
    }

    /**
     * PDF: ALWAYS regenerate
     * (On Render, if LibreOffice missing => fallback PDF)
     */
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

    // final security check (must be under uploads)
    const absPath = path.resolve(filePath);

    if (
      absPath !== uploadsRoot &&
      !absPath.startsWith(uploadsRoot + path.sep)
    ) {
      throw new BadRequestException('Invalid file path');
    }

    if (!fs.existsSync(absPath)) {
      // if file missing on disk, try regenerate for doc types once
      if (type === 'staff-doc') {
        const regenerated = await this.fileReportsService.generateStaffDocx(id);
        const regenAbs = path.resolve(regenerated);
        if (
          regenAbs === uploadsRoot ||
          regenAbs.startsWith(uploadsRoot + path.sep)
        ) {
          filePath = regenerated;
        }
      } else if (type === 'individual-doc') {
        const regenerated =
          await this.fileReportsService.generateIndividualDocx(id);
        const regenAbs = path.resolve(regenerated);
        if (
          regenAbs === uploadsRoot ||
          regenAbs.startsWith(uploadsRoot + path.sep)
        ) {
          filePath = regenerated;
        }
      }

      const abs2 = path.resolve(filePath);
      if (!fs.existsSync(abs2)) {
        throw new NotFoundException('Report file not found on server');
      }
    }

    // build filename: YYYY-MM-DD - Individual - Service - DSP.ext
    const date = dn.date.toISOString().slice(0, 10);
    const individual = sanitizeName(dn.individualName || 'Individual');
    const service = sanitizeName(dn.serviceName || 'Service');
    const dsp = sanitizeName(dn.staffName || 'DSP');

    const downloadName = `${date} - ${individual} - ${service} - ${dsp}.${ext}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadName}"`,
    );

    const stream = fs.createReadStream(path.resolve(filePath));
    stream.pipe(res);
  }
}

function sanitizeName(input: string) {
  return input
    .replace(/[\\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
