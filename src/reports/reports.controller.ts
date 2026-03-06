// src/reports/reports.controller.ts
import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
  BadRequestException,
  Patch,
  Body,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

import {
  ReportsService,
  DailyNotesFilter,
  HealthIncidentFilter,
} from './reports.service';
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

  // =========================
  // DAILY NOTES (existing)
  // =========================

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

  @Get('daily-notes/:id')
  async getDailyNoteDetail(@Param('id') id: string) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const dn = await this.reportsService.getDailyNoteDetail(id);
    if (!dn) throw new NotFoundException('DailyNote not found');
    return dn;
  }

  @Get('daily-notes/:id/preview')
  async getDailyNotePreview(@Param('id') id: string) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    try {
      const data = await this.fileReportsService.getPreviewData(id);
      return data;
    } catch (e: any) {
      const msg = e?.message ?? String(e);

      if (msg.toLowerCase().includes('not found')) {
        throw new NotFoundException('DailyNote not found');
      }

      if (
        msg.toLowerCase().includes('missing id') ||
        msg.toLowerCase().includes('invalid id')
      ) {
        throw new BadRequestException(msg);
      }

      throw new BadRequestException(msg);
    }
  }

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

    const uploadsRoot = path.resolve(process.cwd(), 'uploads');

    const isWindowsAbsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p);

    const isSafeUploadsPath = (p: string) => {
      if (!p) return false;
      if (isWindowsAbsPath(p)) return false;

      const abs = path.resolve(p);
      return abs === uploadsRoot || abs.startsWith(uploadsRoot + path.sep);
    };

    let filePath: string | null = null;
    let contentType = 'application/octet-stream';
    let ext = 'bin';

    if (type === 'staff-doc') {
      contentType =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      ext = 'docx';

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

    const absPath = path.resolve(filePath);

    if (
      absPath !== uploadsRoot &&
      !absPath.startsWith(uploadsRoot + path.sep)
    ) {
      throw new BadRequestException('Invalid file path');
    }

    if (!fs.existsSync(absPath)) {
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

  // =========================
  // HEALTH & INCIDENT
  // =========================

  @Get('health-incident')
  async getHealthIncidentReports(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('staffId') staffId?: string,
    @Query('individualId') individualId?: string,
    @Query('status') status?: string,
  ) {
    const filter: HealthIncidentFilter = {
      from,
      to,
      staffId,
      individualId,
      status,
    };
    const items = await this.reportsService.getHealthIncidentReports(filter);
    return { items };
  }

  /**
   * Optional lightweight endpoint for unread summary.
   * Current meaning of "new" = status SUBMITTED.
   */
  @Get('health-incident/unread/summary')
  async getHealthIncidentUnreadSummary() {
    return this.reportsService.getHealthIncidentUnreadSummary();
  }

  @Get('health-incident/:id')
  async getHealthIncidentDetail(@Param('id') id: string) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }
    const rpt = await this.reportsService.getHealthIncidentReportDetail(id);
    if (!rpt) throw new NotFoundException('HealthIncidentReport not found');
    return rpt;
  }

  @Patch('health-incident/:id/review')
  async saveSupervisorReview(
    @Param('id') id: string,
    @Body()
    body: {
      status?: string;
      supervisorName?: string;
      supervisorDecision?: string;
      supervisorActionsTaken?: string;
    },
  ) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const updated = await this.reportsService.saveHealthIncidentReview(
      id,
      body ?? {},
    );
    if (!updated) throw new NotFoundException('HealthIncidentReport not found');
    return updated;
  }

  @Patch('health-incident/:id/close')
  async closeHealthIncident(
    @Param('id') id: string,
    @Body()
    body: {
      supervisorName?: string;
      supervisorDecision?: string;
      supervisorActionsTaken?: string;
    },
  ) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const updated = await this.reportsService.closeHealthIncidentReport(
      id,
      body ?? {},
    );
    if (!updated) throw new NotFoundException('HealthIncidentReport not found');
    return updated;
  }

  @Patch('health-incident/:id/assign')
  async assignCI(
    @Param('id') id: string,
    @Body()
    body: {
      ciName?: string;
      ciEmail?: string;
      ciPhone?: string;
      ciAssignedByUserId?: string;
      ciAssignedByName?: string;
    },
  ) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const updated = await this.reportsService.assignCI(id, body ?? {});
    if (!updated) throw new NotFoundException('HealthIncidentReport not found');
    return updated;
  }
}

function sanitizeName(input: string) {
  return input
    .replace(/[\\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}