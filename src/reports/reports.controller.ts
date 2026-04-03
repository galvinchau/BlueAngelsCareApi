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
  Post,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

import { ReportsService } from './reports.service';
import type {
  DailyNotesFilter,
  HealthIncidentFilter,
  HealthIncidentAttachmentInput,
  AwakeReportFilter,
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
  ) { }
  @Get('awake/:id/download/:type')
  async downloadAwakeReport(
    @Param('id') id: string,
    @Param('type') type: string,
    @Res() res: Response,
  ) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    return this.fileReportsService.downloadAwakeReport(id, type, res);
  }
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
  // AWAKE REPORT
  // =========================

  @Get('awake')
  async getAwakeReports(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('staffId') staffId?: string,
    @Query('individualId') individualId?: string,
    @Query('status') status?: string,
  ) {
    const filter: AwakeReportFilter = {
      from,
      to,
      staffId,
      individualId,
      status,
    };
    const items = await this.reportsService.getAwakeReports(filter);
    return { items };
  }

  @Get('awake/:id')
  async getAwakeReportDetail(@Param('id') id: string) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const rpt = await this.reportsService.getAwakeReportDetail(id);
    if (!rpt) throw new NotFoundException('Awake report not found');
    return rpt;
  }

  @Get('awake/:id/timeline')
  async getAwakeTimeline(@Param('id') id: string) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const items = await this.reportsService.getAwakeTimeline(id);
    if (!items) throw new NotFoundException('Awake report not found');
    return { items };
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

  @Get('health-incident/:id/timeline')
  async getHealthIncidentTimeline(@Param('id') id: string) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const items = await this.reportsService.getHealthIncidentTimeline(id);
    if (!items) throw new NotFoundException('HealthIncidentReport not found');
    return { items };
  }

  @Get('health-incident/:id/attachments')
  async getHealthIncidentAttachments(@Param('id') id: string) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const items = await this.reportsService.getHealthIncidentAttachments(id);
    if (!items) throw new NotFoundException('HealthIncidentReport not found');
    return { items };
  }

  @Get('health-incident/:id/attachments/:attachmentId/download')
  async downloadHealthIncidentAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    if (!attachmentId || String(attachmentId).trim() === '') {
      throw new BadRequestException('Missing attachmentId');
    }

    try {
      const attachment =
        await this.reportsService.getHealthIncidentAttachmentForDownload(
          id,
          attachmentId,
        );

      if (!attachment) {
        throw new NotFoundException('Attachment not found');
      }

      const absPath =
        this.reportsService.getHealthIncidentAttachmentAbsolutePath(
          attachment.filePath,
        );

      const contentType =
        attachment.mimeType?.trim() || 'application/octet-stream';

      const downloadName = sanitizeName(
        attachment.fileName || `attachment-${attachment.id}`,
      );

      res.setHeader('Content-Type', contentType);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${downloadName}"`,
      );

      const stream = fs.createReadStream(absPath);
      stream.pipe(res);
    } catch (e: any) {
      const msg = e?.message ?? String(e);

      if (msg.toLowerCase().includes('not found')) {
        throw new NotFoundException(msg);
      }

      throw new BadRequestException(msg);
    }
  }

  @Post('health-incident/:id/attachments')
  async addHealthIncidentAttachment(
    @Param('id') id: string,
    @Body() body: HealthIncidentAttachmentInput,
  ) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    try {
      const created = await this.reportsService.addHealthIncidentAttachment(
        id,
        body ?? {},
      );
      if (!created) {
        throw new NotFoundException('HealthIncidentReport not found');
      }
      return created;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.toLowerCase().includes('not found')) {
        throw new NotFoundException('HealthIncidentReport not found');
      }
      throw new BadRequestException(msg);
    }
  }

  @Post('health-incident/:id/attachments/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadHealthIncidentAttachment(
    @Param('id') id: string,
    @UploadedFile() file?: any,
    @Body()
    body?: {
      category?: string;
      description?: string;
      uploadedByUserId?: string;
      uploadedByEmployeeId?: string;
      uploadedByName?: string;
      uploadedByRole?: string;
    },
  ) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    if (!file) {
      throw new BadRequestException('Missing upload file');
    }

    try {
      const created = await this.reportsService.uploadHealthIncidentAttachment(
        id,
        file,
        body ?? {},
      );

      if (!created) {
        throw new NotFoundException('HealthIncidentReport not found');
      }

      return created;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.toLowerCase().includes('not found')) {
        throw new NotFoundException('HealthIncidentReport not found');
      }
      throw new BadRequestException(msg);
    }
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
      actorUserId?: string;
      actorName?: string;
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

  @Patch('health-incident/:id/investigation')
  async saveHealthIncidentInvestigation(
    @Param('id') id: string,
    @Body()
    body: {
      investigationFindings?: string;
      rootCause?: string;
      witnessNotes?: string;
      correctiveActions?: string;
      recommendation?: string;
      investigatedByStaffId?: string;
      investigatedByName?: string;
      actorUserId?: string;
      actorName?: string;
    },
  ) {
    if (!id || String(id).trim() === '') {
      throw new BadRequestException('Missing id');
    }

    const updated = await this.reportsService.saveHealthIncidentInvestigation(
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
      finalDecision?: string;
      finalSummary?: string;
      allowDspViewOutcome?: boolean;
      closedByUserId?: string;
      closedByName?: string;
      actorUserId?: string;
      actorName?: string;
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