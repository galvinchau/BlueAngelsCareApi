// src/reports/reports.service.ts
import * as fs from 'fs';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateTime } from 'luxon';
import { MailService } from '../mail/mail.service';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const TZ = 'America/New_York';
const HEALTH_INCIDENT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const HEALTH_INCIDENT_ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.doc',
  '.docx',
]);

const HEALTH_INCIDENT_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const INCIDENT_TYPES_LEFT = [
  'Physical Abuse',
  'Mental Abuse',
  'Neglect',
  'Self-Neglect',
  'Extortion',
  'Misapplication/Unauthorized Use of Restraint (No Injury)',
  'Passive Neglect',
  'Suicide Attempt',
] as const;

const INCIDENT_TYPES_RIGHT = [
  'Misapplication/Unauthorized Use of Restraint (Injury)',
  'Death',
  'Exploitation',
  'Missing/Theft of Medication',
  'Misuse/Theft of Funds',
  'Unpaid Labor',
  'Right Violation',
  'Sexual Abuse',
] as const;

export type DailyNotesFilter = {
  from?: string;
  to?: string;
  staffId?: string;
  individualId?: string;
};

export type HealthIncidentFilter = {
  from?: string;
  to?: string;
  staffId?: string;
  individualId?: string;
  status?: string;
};

export type AwakeReportFilter = {
  from?: string;
  to?: string;
  staffId?: string;
  individualId?: string;
  status?: string;
};

export type HealthIncidentAttachmentInput = {
  category?: string;
  fileName?: string;
  filePath?: string;
  mimeType?: string;
  fileSize?: number;
  description?: string;
  uploadedByUserId?: string;
  uploadedByEmployeeId?: string;
  uploadedByName?: string;
  uploadedByRole?: string;
};

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) { }

  private toLocalISODate(d: Date): string {
    return (
      DateTime.fromJSDate(d, { zone: 'utc' }).setZone(TZ).toISODate() ?? ''
    );
  }

  private toLocalTimeHHmm(d?: Date | null): string {
    if (!d) return '';
    return (
      DateTime.fromJSDate(d, { zone: 'utc' }).setZone(TZ).toFormat('HH:mm') ??
      ''
    );
  }

  private toLocalDateTime(d?: Date | null): string {
    if (!d) return '';
    return (
      DateTime.fromJSDate(d, { zone: 'utc' })
        .setZone(TZ)
        .toFormat('yyyy-LL-dd hh:mm a') ?? ''
    );
  }

  private normalizeDateInput(v?: string): string | undefined {
    if (!v) return undefined;
    const s = String(v).trim();
    if (!s) return undefined;
    return s;
  }

  private safeStr(v: any): string {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  private toPdfSafeText(v: any): string {
    const s = this.safeStr(v);
    if (!s) return '';

    return s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[…]/g, '...')
      .replace(/[–—]/g, '-')
      .replace(/\u00A0/g, ' ')
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  }

  private asText(v: any): string {
    const s = this.safeStr(v).trim();
    return s ? s : '';
  }

  private asPdfText(v: any): string {
    return this.toPdfSafeText(v).trim();
  }

  private parsePayloadObject(payload: any): any {
    if (!payload) return {};
    if (typeof payload === 'string') {
      try {
        return JSON.parse(payload);
      } catch {
        return {};
      }
    }
    return payload;
  }

  private parseAnyDateToYYYYMMDD(value?: string | null): string {
    const s = this.safeStr(value).trim();
    if (!s) return '';

    const m1 = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;

    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }

    return '';
  }

  private joinWitnessesFromPayload(payload: any): string {
    const p = this.parsePayloadObject(payload);

    const witnessText = this.asText(p.witnesses || p.witness || '');
    if (witnessText) return witnessText;

    const rows: string[] = [];

    const w1n = this.asText(p.witness1Name);
    const w1c = this.asText(p.witness1Contact);
    if (w1n || w1c) {
      rows.push(
        [w1n || 'Witness 1', w1c ? `(${w1c})` : '']
          .filter(Boolean)
          .join(' '),
      );
    }

    const w2n = this.asText(p.witness2Name);
    const w2c = this.asText(p.witness2Contact);
    if (w2n || w2c) {
      rows.push(
        [w2n || 'Witness 2', w2c ? `(${w2c})` : '']
          .filter(Boolean)
          .join(' '),
      );
    }

    return rows.join('\n');
  }

  private extractIncidentType(payload: any): string | null {
    if (!payload) return null;

    let p: any = payload;
    if (typeof payload === 'string') {
      try {
        p = JSON.parse(payload);
      } catch {
        p = payload;
      }
    }

    if (Array.isArray((p as any)?.incidentTypes)) {
      const arr = (p as any).incidentTypes
        .map((x: any) => String(x ?? '').trim())
        .filter(Boolean);
      if (arr.length) return arr.join(', ');
    }

    const candidates: any[] = [];
    candidates.push((p as any)?.incidentType);
    candidates.push((p as any)?.incident_type);
    candidates.push((p as any)?.typeOfIncident);
    candidates.push((p as any)?.type_of_incident);
    candidates.push((p as any)?.incidentCategory);
    candidates.push((p as any)?.incident_category);

    candidates.push((p as any)?.incident?.incidentType);
    candidates.push((p as any)?.incident?.type);
    candidates.push((p as any)?.incident?.typeOfIncident);

    candidates.push((p as any)?.healthIncident?.incidentType);
    candidates.push((p as any)?.healthIncident?.typeOfIncident);

    candidates.push((p as any)?.report?.incidentType);
    candidates.push((p as any)?.report?.typeOfIncident);

    candidates.push((p as any)?.selectedIncidentType);
    candidates.push((p as any)?.incidentTypeSelected);

    for (const c of candidates) {
      if (c === null || c === undefined) continue;
      const s = String(c).trim();
      if (s) return s;
    }

    return null;
  }

  private extractIncidentTypeList(
    detailIncidentType: any,
    payload: any,
  ): string[] {
    const p = this.parsePayloadObject(payload);

    if (Array.isArray(p.incidentTypes)) {
      return p.incidentTypes
        .map((x: any) => this.safeStr(x).trim())
        .filter(Boolean);
    }

    const combined =
      this.safeStr(detailIncidentType).trim() ||
      this.safeStr(p.incidentType).trim() ||
      this.safeStr(p.typeOfIncident).trim() ||
      this.safeStr(p.type_of_incident).trim() ||
      this.safeStr(p.incidentCategory).trim() ||
      this.safeStr(p.incident_type).trim();

    if (!combined) return [];

    return combined
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }

  private isIncidentTypeChecked(selected: string[], item: string) {
    return selected.some(
      (x) => x.trim().toLowerCase() === item.trim().toLowerCase(),
    );
  }

  private buildHealthIncidentWebUrl(reportId: string): string | null {
    const base = String(process.env.WEB_BASE_URL || process.env.FRONTEND_URL || '')
      .trim()
      .replace(/\/+$/, '');
    if (!base) return null;

    return `${base}/reports/health-incident/${encodeURIComponent(reportId)}`;
  }

  private splitTextToLines(
    text: string,
    maxWidth: number,
    font: any,
    fontSize: number,
    maxLines?: number,
  ): string[] {
    const normalized = this.toPdfSafeText(text).replace(/\r/g, '');
    if (!normalized.trim()) return [];

    const out: string[] = [];
    const paragraphs = normalized.split('\n');

    for (const paragraph of paragraphs) {
      const words = paragraph.split(/\s+/).filter(Boolean);

      if (!words.length) {
        out.push('');
        continue;
      }

      let current = '';

      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        const candidateWidth = font.widthOfTextAtSize(candidate, fontSize);

        if (candidateWidth <= maxWidth) {
          current = candidate;
          continue;
        }

        if (current) {
          out.push(current);
          current = word;
        } else {
          out.push(this.toPdfSafeText(word));
          current = '';
        }

        if (maxLines && out.length >= maxLines) {
          return out.slice(0, maxLines);
        }
      }

      if (current) {
        out.push(current);
        if (maxLines && out.length >= maxLines) {
          return out.slice(0, maxLines);
        }
      }
    }

    return maxLines ? out.slice(0, maxLines) : out;
  }

  private computeAwakeFinalStatus(args: {
    reminderCount: number;
    confirmCount: number;
    hasAutoCheckoutFail: boolean;
    hasManualCheckout: boolean;
    autoCheckoutReason?: string | null;
    autoCheckedOutAt?: Date | null;
  }): 'PASSED' | 'FAILED' {
    if (args.hasAutoCheckoutFail) return 'FAILED';

    if (args.autoCheckedOutAt) return 'FAILED';

    if (String(args.autoCheckoutReason || '').trim() !== '') return 'FAILED';

    if (args.reminderCount > 0) {
      return args.confirmCount >= args.reminderCount ? 'PASSED' : 'FAILED';
    }

    if (args.hasManualCheckout) {
      return 'PASSED';
    }

    return 'FAILED';
  }

  private healthIncidentSelect() {
    return {
      id: true,
      caseNumber: true,
      date: true,
      createdAt: true as any,
      status: true,
      submittedAt: true,
      payload: true,

      staffId: true,
      staffName: true,
      staffEmail: true,

      individualId: true,
      individualName: true,

      shiftId: true,
      shift: {
        select: {
          id: true,
          scheduleDate: true,
          plannedStart: true,
          plannedEnd: true,
          service: { select: { serviceCode: true, serviceName: true } },
        },
      },

      supervisorName: true,
      supervisorDecision: true,
      supervisorActionsTaken: true,
      reviewedAt: true,

      ciName: true,
      ciEmail: true,
      ciPhone: true,
      ciAssignedAt: true,
      ciAssignedByUserId: true,
      ciAssignedByName: true,

      investigationFindings: true,
      rootCause: true,
      witnessNotes: true,
      correctiveActions: true,
      recommendation: true,
      investigatedAt: true,
      investigatedByStaffId: true,
      investigatedByName: true,

      allowDspViewOutcome: true,
      finalDecision: true,
      finalSummary: true,
      closedAt: true,
      closedByUserId: true,
      closedByName: true,

      staffReportDocPath: true,
      staffReportPdfPath: true,
    };
  }

  private async addHealthIncidentCaseLog(args: {
    reportId: string;
    actionType: string;
    actorUserId?: string | null;
    actorEmployeeId?: string | null;
    actorName?: string | null;
    actorRole?: string | null;
    note?: string | null;
    meta?: any;
  }) {
    try {
      await this.prisma.healthIncidentCaseLog.create({
        data: {
          reportId: args.reportId,
          actionType: this.safeStr(args.actionType).trim(),
          actorUserId: this.asText(args.actorUserId) || null,
          actorEmployeeId: this.asText(args.actorEmployeeId) || null,
          actorName: this.asText(args.actorName) || null,
          actorRole: this.asText(args.actorRole) || null,
          note: this.asText(args.note) || null,
          meta: args.meta ?? null,
        },
      });
    } catch (e: any) {
      console.error('[HealthIncidentCaseLog] failed', e?.message ?? e);
    }
  }

  private buildCaseClosedRecipients(updated: any): string[] {
    const emails = [
      this.asText(updated?.staffEmail),
      this.asText(updated?.ciEmail),
    ].filter(Boolean);

    return Array.from(new Set(emails.map((x) => x.toLowerCase())));
  }

  private async sendCiSubmittedEmailSafe(updated: any, mapped: any) {
    try {
      const supervisorEmailCandidate = this.asText(updated?.ciAssignedByUserId);
      const fallbackTo = '';

      const to =
        supervisorEmailCandidate && supervisorEmailCandidate.includes('@')
          ? supervisorEmailCandidate
          : fallbackTo;

      if (!to) return;

      const sendFn = (this.mailService as any)?.sendCiConclusionSubmittedEmail;
      if (typeof sendFn !== 'function') return;

      await sendFn.call(this.mailService, {
        to,
        supervisorName:
          updated?.supervisorName || updated?.ciAssignedByName || null,
        ciName: updated?.investigatedByName || updated?.ciName || null,
        individualName: updated?.individualName || null,
        incidentType: mapped?.incidentType || null,
        reportDateLocal: updated?.date ? this.toLocalISODate(updated.date) : null,
        link: this.buildHealthIncidentWebUrl(updated?.id),
      });
    } catch (e: any) {
      console.error('[sendCiSubmittedEmailSafe] failed', e?.message ?? e);
    }
  }

  private async sendCaseClosedSummaryEmailSafe(updated: any, mapped: any) {
    try {
      const to = this.buildCaseClosedRecipients(updated);
      if (!to.length) return;

      const sendFn = (this.mailService as any)?.sendCaseClosedSummaryEmail;
      if (typeof sendFn !== 'function') return;

      await sendFn.call(this.mailService, {
        to,
        individualName: updated?.individualName || null,
        dspName: updated?.staffName || null,
        ciName: updated?.ciName || updated?.investigatedByName || null,
        incidentType: mapped?.incidentType || null,
        reportDateLocal: updated?.date ? this.toLocalISODate(updated.date) : null,
        finalDecision:
          updated?.finalDecision || updated?.supervisorDecision || null,
        finalSummary: updated?.finalSummary || null,
        closedByName: updated?.closedByName || updated?.supervisorName || null,
        closedDateLocal: updated?.closedAt
          ? this.toLocalDateTime(updated.closedAt)
          : null,
        link: this.buildHealthIncidentWebUrl(updated?.id),
      });
    } catch (e: any) {
      console.error('[sendCaseClosedSummaryEmailSafe] failed', e?.message ?? e);
    }
  }

  private async buildHealthIncidentPdfBuffer(args: {
    reportId: string;
    dateLocal: string;
    status: string;
    incidentType: string | null;

    individualName: string;
    staffName: string;
    staffEmail: string;

    shiftStart: string | null;
    shiftEnd: string | null;
    serviceCode: string | null;
    serviceName: string | null;

    supervisorName: string;
    supervisorDecision: string;
    supervisorActionsTaken: string;
    reviewedAt?: Date | string | null;

    ciName?: string | null;
    ciEmail?: string | null;
    ciPhone?: string | null;
    ciAssignedAt?: Date | string | null;
    ciAssignedByName?: string | null;

    payload: any;
  }): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    const page1 = pdfDoc.addPage([612, 792]);
    const page2 = pdfDoc.addPage([612, 792]);

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const black = rgb(0, 0, 0);
    const gray = rgb(0.35, 0.35, 0.35);

    const margin = 36;
    const pageWidth = 612;
    const contentWidth = pageWidth - margin * 2;

    const drawWrappedText = (
      page: any,
      text: string,
      x: number,
      topY: number,
      width: number,
      height: number,
      size = 10,
      bold = false,
    ) => {
      const useFont = bold ? fontBold : font;
      const lineHeight = size + 2;
      const maxLines = Math.max(1, Math.floor(height / lineHeight));
      const lines = this.splitTextToLines(
        this.toPdfSafeText(text),
        width,
        useFont,
        size,
        maxLines,
      );

      let y = topY - size;
      for (const line of lines) {
        page.drawText(this.toPdfSafeText(line), {
          x,
          y,
          size,
          font: useFont,
          color: black,
        });
        y -= lineHeight;
      }
    };

    const drawFieldBox = (
      page: any,
      label: string,
      value: string,
      x: number,
      topY: number,
      width: number,
      height: number,
      options?: {
        labelSize?: number;
        valueSize?: number;
        boldValue?: boolean;
      },
    ) => {
      const labelSize = options?.labelSize ?? 9;
      const valueSize = options?.valueSize ?? 10;
      const boldValue = options?.boldValue ?? false;

      const y = topY - height;

      page.drawRectangle({
        x,
        y,
        width,
        height,
        borderWidth: 1,
        borderColor: black,
      });

      page.drawText(this.toPdfSafeText(label), {
        x: x + 6,
        y: topY - 14,
        size: labelSize,
        font: fontBold,
        color: black,
      });

      drawWrappedText(
        page,
        this.toPdfSafeText(value || ''),
        x + 6,
        topY - 22,
        width - 12,
        height - 26,
        valueSize,
        boldValue,
      );
    };

    const drawCheckboxCell = (
      page: any,
      x: number,
      topY: number,
      width: number,
      height: number,
      label: string,
      checked: boolean,
    ) => {
      const y = topY - height;

      page.drawRectangle({
        x,
        y,
        width,
        height,
        borderWidth: 1,
        borderColor: black,
      });

      const boxSize = 10;
      const boxX = x + 8;
      const boxY = topY - 16;

      page.drawRectangle({
        x: boxX,
        y: boxY,
        width: boxSize,
        height: boxSize,
        borderWidth: 1,
        borderColor: black,
      });

      if (checked) {
        page.drawLine({
          start: { x: boxX + 2, y: boxY + 5 },
          end: { x: boxX + 4.5, y: boxY + 2 },
          thickness: 1,
          color: black,
        });
        page.drawLine({
          start: { x: boxX + 4.5, y: boxY + 2 },
          end: { x: boxX + 8.5, y: boxY + 8 },
          thickness: 1,
          color: black,
        });
      }

      drawWrappedText(
        page,
        this.toPdfSafeText(label),
        x + 24,
        topY - 7,
        width - 30,
        height - 8,
        9,
        false,
      );
    };

    const drawHeader = (page: any, subtitleRight?: string) => {
      page.drawText('BLUE ANGELS CARE', {
        x: margin,
        y: 748,
        size: 16,
        font: fontBold,
        color: black,
      });

      page.drawText('HEALTH & INCIDENT REPORT', {
        x: margin,
        y: 728,
        size: 12,
        font: fontBold,
        color: black,
      });

      page.drawText(this.toPdfSafeText(`Report ID: ${args.reportId}`), {
        x: margin,
        y: 712,
        size: 9,
        font,
        color: gray,
      });

      if (subtitleRight) {
        const safeSubtitle = this.toPdfSafeText(subtitleRight);
        const w = fontBold.widthOfTextAtSize(safeSubtitle, 10);
        page.drawText(safeSubtitle, {
          x: pageWidth - margin - w,
          y: 732,
          size: 10,
          font: fontBold,
          color: black,
        });
      }

      page.drawLine({
        start: { x: margin, y: 702 },
        end: { x: pageWidth - margin, y: 702 },
        thickness: 1,
        color: black,
      });
    };

    const payload = this.parsePayloadObject(args.payload);

    const reportDate =
      this.asText(payload.reportDate) ||
      this.asText(args.dateLocal) ||
      this.parseAnyDateToYYYYMMDD(new Date().toISOString());

    const shiftText =
      args.shiftStart && args.shiftEnd
        ? `${args.shiftStart} - ${args.shiftEnd}`
        : '-';

    const incidentTypeList = this.extractIncidentTypeList(
      args.incidentType,
      payload,
    );

    const incidentDate =
      this.asText(payload.incidentDate) ||
      this.asText(args.dateLocal) ||
      reportDate;
    const incidentTime = this.asText(payload.incidentTime);
    const location =
      this.asText(payload.location) || this.asText(payload.incidentLocation);

    const description =
      this.asText(payload.description) ||
      this.asText(payload.details) ||
      this.asText(payload.incidentDescription);

    const reporterSignatureName =
      this.asText(payload.reportedByName) || this.asText(args.staffName) || '-';

    const reporterSignatureDate =
      this.asText(payload.reportDate) || reportDate || '-';

    const witnesses = this.joinWitnessesFromPayload(payload);
    const additionalNotes =
      this.asText(payload.additionalNotes) || this.asText(payload.attachments);

    const supervisorSignatureName =
      this.asText(args.ciAssignedByName) ||
      this.asText(args.supervisorName) ||
      '-';

    const supervisorSignatureDate =
      this.parseAnyDateToYYYYMMDD(
        this.safeStr(args.ciAssignedAt) || this.safeStr(args.reviewedAt),
      ) || '_____________';

    drawHeader(page1, `Status: ${this.safeStr(args.status || '-')}`);

    let y = 686;

    drawFieldBox(
      page1,
      'Individual',
      this.asPdfText(args.individualName) || '-',
      margin,
      y,
      contentWidth / 2,
      42,
      { valueSize: 11, boldValue: true },
    );

    drawFieldBox(
      page1,
      'DSP / Staff',
      this.asPdfText(args.staffName) || '-',
      margin + contentWidth / 2,
      y,
      contentWidth / 2,
      42,
      { valueSize: 11, boldValue: true },
    );

    y -= 42;

    drawFieldBox(
      page1,
      'Report Date',
      this.asPdfText(reportDate) || '-',
      margin,
      y,
      contentWidth / 2,
      42,
      {
        valueSize: 11,
        boldValue: true,
      },
    );

    drawFieldBox(
      page1,
      'Shift',
      this.asPdfText(shiftText) || '-',
      margin + contentWidth / 2,
      y,
      contentWidth / 2,
      42,
      {
        valueSize: 11,
        boldValue: true,
      },
    );

    y -= 42;

    const incidentBlockHeight = 182;
    drawFieldBox(
      page1,
      'Type of Incident',
      '',
      margin,
      y,
      contentWidth,
      incidentBlockHeight,
    );

    const cellTop = y - 22;
    const rows = Math.max(
      INCIDENT_TYPES_LEFT.length,
      INCIDENT_TYPES_RIGHT.length,
    );
    const cellHeight = 20;
    const leftX = margin + 1;
    const colWidth = contentWidth / 2 - 1;

    for (let idx = 0; idx < rows; idx++) {
      const left = INCIDENT_TYPES_LEFT[idx];
      const right = INCIDENT_TYPES_RIGHT[idx];
      const rowTop = cellTop - idx * cellHeight;

      if (left) {
        drawCheckboxCell(
          page1,
          leftX,
          rowTop,
          colWidth,
          cellHeight,
          left,
          this.isIncidentTypeChecked(incidentTypeList, left),
        );
      }

      if (right) {
        drawCheckboxCell(
          page1,
          leftX + colWidth,
          rowTop,
          colWidth,
          cellHeight,
          right,
          this.isIncidentTypeChecked(incidentTypeList, right),
        );
      }
    }

    y -= incidentBlockHeight;

    drawFieldBox(
      page1,
      'Incident Date',
      this.asPdfText(incidentDate) || '-',
      margin,
      y,
      contentWidth / 2,
      42,
      {
        valueSize: 11,
        boldValue: true,
      },
    );

    drawFieldBox(
      page1,
      'Incident Time',
      this.asPdfText(incidentTime) || '-',
      margin + contentWidth / 2,
      y,
      contentWidth / 2,
      42,
      {
        valueSize: 11,
        boldValue: true,
      },
    );

    y -= 42;

    drawFieldBox(
      page1,
      'Location',
      this.asPdfText(location) || '-',
      margin,
      y,
      contentWidth,
      50,
      {
        valueSize: 10,
        boldValue: true,
      },
    );

    y -= 50;

    drawFieldBox(
      page1,
      'Description of Incident',
      this.toPdfSafeText(description || ''),
      margin,
      y,
      contentWidth,
      120,
      {
        valueSize: 10,
      },
    );

    y -= 120;

    drawFieldBox(
      page1,
      'Signature of Reporter',
      this.asPdfText(reporterSignatureName) || '-',
      margin,
      y,
      contentWidth / 2,
      62,
      {
        valueSize: 10,
        boldValue: true,
      },
    );

    drawFieldBox(
      page1,
      'Date',
      this.asPdfText(reporterSignatureDate) || '-',
      margin + contentWidth / 2,
      y,
      contentWidth / 2,
      62,
      {
        valueSize: 10,
        boldValue: true,
      },
    );

    y -= 62;

    drawFieldBox(
      page1,
      'Witnesses',
      this.toPdfSafeText(witnesses || ''),
      margin,
      y,
      contentWidth,
      70,
      {
        valueSize: 10,
      },
    );

    y -= 70;

    drawFieldBox(
      page1,
      'Additional Notes',
      this.toPdfSafeText(additionalNotes || ''),
      margin,
      y,
      contentWidth,
      72,
      {
        valueSize: 10,
      },
    );

    drawHeader(page2);

    page2.drawText('Supervisor Review', {
      x: margin,
      y: 676,
      size: 12,
      font: fontBold,
      color: black,
    });

    let y2 = 656;

    drawFieldBox(
      page2,
      'Status',
      this.asPdfText(args.status) || '-',
      margin,
      y2,
      contentWidth / 3,
      42,
      {
        valueSize: 11,
        boldValue: true,
      },
    );

    drawFieldBox(
      page2,
      'Reviewed At',
      this.asPdfText(this.safeStr(args.reviewedAt) || '-') || '-',
      margin + contentWidth / 3,
      y2,
      (contentWidth / 3) * 2,
      42,
      {
        valueSize: 10,
        boldValue: true,
      },
    );

    y2 -= 42;

    const ciText = [
      `CI Name: ${this.asPdfText(args.ciName) || '-'}`,
      `CI Email: ${this.asPdfText(args.ciEmail) || '-'}`,
      `CI Phone: ${this.asPdfText(args.ciPhone) || '-'}`,
      `Assigned At: ${this.asPdfText(this.safeStr(args.ciAssignedAt) || '-')}${this.asPdfText(args.ciAssignedByName)
        ? `  By: ${this.asPdfText(args.ciAssignedByName)}`
        : ''
      }`,
    ].join('\n');

    drawFieldBox(page2, 'CI Assignment', ciText, margin, y2, contentWidth, 90, {
      valueSize: 10,
    });

    y2 -= 90;

    drawFieldBox(
      page2,
      'Supervisor Decision',
      this.toPdfSafeText(this.asText(args.supervisorDecision) || ''),
      margin,
      y2,
      contentWidth,
      140,
      {
        valueSize: 10,
      },
    );

    y2 -= 140;

    drawFieldBox(
      page2,
      'Actions Taken',
      this.toPdfSafeText(this.asText(args.supervisorActionsTaken) || ''),
      margin,
      y2,
      contentWidth,
      140,
      {
        valueSize: 10,
      },
    );

    page2.drawText('Supervisor Signature', {
      x: 236,
      y: 120,
      size: 10,
      font: fontBold,
      color: black,
    });

    page2.drawText(this.toPdfSafeText(supervisorSignatureName || '-'), {
      x: 220,
      y: 88,
      size: 11,
      font: fontBold,
      color: black,
    });

    page2.drawLine({
      start: { x: 150, y: 80 },
      end: { x: 462, y: 80 },
      thickness: 1,
      color: black,
    });

    page2.drawText(this.toPdfSafeText(`Date: ${supervisorSignatureDate}`), {
      x: 240,
      y: 60,
      size: 10,
      font,
      color: gray,
    });

    const bytes = await pdfDoc.save();
    return Buffer.from(bytes);
  }

  private mapHealthIncidentRow(r: any) {
    const shiftStart = r.shift?.plannedStart ?? null;
    const shiftEnd = r.shift?.plannedEnd ?? null;

    const shiftStartLocal = shiftStart ? this.toLocalTimeHHmm(shiftStart) : '';
    const shiftEndLocal = shiftEnd ? this.toLocalTimeHHmm(shiftEnd) : '';

    const incidentType = this.extractIncidentType(r.payload);

    return {
      ...r,
      dateLocal: r.date ? this.toLocalISODate(r.date) : '',
      incidentType,
      shiftStart: shiftStartLocal || null,
      shiftEnd: shiftEndLocal || null,
      shiftPlannedStartLocal: shiftStartLocal,
      shiftPlannedEndLocal: shiftEndLocal,
      shiftServiceCode: r.shift?.service?.serviceCode ?? null,
      shiftServiceName: r.shift?.service?.serviceName ?? null,
    };
  }

  async getDailyNotes(filter: DailyNotesFilter) {
    const from = this.normalizeDateInput(filter.from);
    const to = this.normalizeDateInput(filter.to);

    let gte: Date | undefined;
    let lt: Date | undefined;

    if (from) {
      const startLocal = DateTime.fromISO(from, { zone: TZ }).startOf('day');
      gte = startLocal.toUTC().toJSDate();
    }

    if (to) {
      const endLocalExclusive = DateTime.fromISO(to, { zone: TZ })
        .plus({ days: 1 })
        .startOf('day');
      lt = endLocalExclusive.toUTC().toJSDate();
    }

    const where: any = {};
    if (gte || lt) {
      where.date = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
    }
    if (filter.staffId) where.staffId = filter.staffId;
    if (filter.individualId) where.individualId = filter.individualId;

    const items = await this.prisma.dailyNote.findMany({
      where,
      orderBy: { date: 'desc' },
      select: {
        id: true,
        date: true,
        staffId: true,
        staffName: true,
        individualId: true,
        individualName: true,
        serviceCode: true,
        serviceName: true,
        scheduleStart: true,
        scheduleEnd: true,
        visitStart: true,
        visitEnd: true,
        mileage: true,
        isCanceled: true,
        cancelReason: true,
        staffReportDocPath: true,
        staffReportPdfPath: true,
        individualReportDocPath: true,
        individualReportPdfPath: true,
      },
    });

    return items.map((x) => ({
      ...x,
      dateLocal: x.date ? this.toLocalISODate(x.date) : '',
    }));
  }

  async getDailyNoteDetail(id: string) {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id },
      select: {
        id: true,
        date: true,
        staffId: true,
        staffName: true,
        individualId: true,
        individualName: true,
        serviceCode: true,
        serviceName: true,
        scheduleStart: true,
        scheduleEnd: true,
        visitStart: true,
        visitEnd: true,
        mileage: true,
        isCanceled: true,
        cancelReason: true,
        payload: true,
        staffReportDocPath: true,
        staffReportPdfPath: true,
        individualReportDocPath: true,
        individualReportPdfPath: true,
      },
    });

    if (!dn) return null;

    return {
      ...dn,
      dateLocal: dn.date ? this.toLocalISODate(dn.date) : '',
    };
  }

  async getDailyNoteForDownload(id: string) {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id },
      select: {
        id: true,
        date: true,
        staffId: true,
        staffName: true,
        individualId: true,
        individualName: true,
        serviceCode: true,
        serviceName: true,
        scheduleStart: true,
        scheduleEnd: true,
        visitStart: true,
        visitEnd: true,
        mileage: true,
        isCanceled: true,
        cancelReason: true,
        payload: true,
        staffReportDocPath: true,
        staffReportPdfPath: true,
        individualReportDocPath: true,
        individualReportPdfPath: true,
      },
    });

    if (!dn) return null;
    return dn;
  }

  async getAwakeReports(filter: AwakeReportFilter) {
    const from = this.normalizeDateInput(filter.from);
    const to = this.normalizeDateInput(filter.to);

    let gte: Date | undefined;
    let lt: Date | undefined;

    if (from) {
      const startLocal = DateTime.fromISO(from, { zone: TZ }).startOf('day');
      gte = startLocal.toUTC().toJSDate();
    }

    if (to) {
      const endLocalExclusive = DateTime.fromISO(to, { zone: TZ })
        .plus({ days: 1 })
        .startOf('day');
      lt = endLocalExclusive.toUTC().toJSDate();
    }

    const where: any = {
      awakeMonitoringEnabled: true,
    };

    if (gte || lt) {
      where.checkInAt = {
        ...(gte ? { gte } : {}),
        ...(lt ? { lt } : {}),
      };
    }

    if (filter.staffId) where.dspId = filter.staffId;
    if (filter.individualId) where.individualId = filter.individualId;

    const visits = await this.prisma.visit.findMany({
      where,
      orderBy: { checkInAt: 'desc' },
      select: {
        id: true,
        scheduleShiftId: true,
        individualId: true,
        dspId: true,
        serviceId: true,
        checkInAt: true,
        checkOutAt: true,
        autoCheckedOutAt: true,
        autoCheckoutReason: true,
        scheduleShift: {
          select: {
            id: true,
            scheduleDate: true,
            plannedStart: true,
            plannedEnd: true,
            service: {
              select: {
                serviceCode: true,
                serviceName: true,
              },
            },
          },
        },
        individual: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        dsp: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        service: {
          select: {
            serviceCode: true,
            serviceName: true,
          },
        },
        awakeEventLogs: {
          select: {
            eventType: true,
          },
        },
      },
    });

    const mapped = visits.map((v: any) => {
      const reminderCount = v.awakeEventLogs.filter(
        (x: any) => x.eventType === 'REMINDER_SENT',
      ).length;

      const confirmCount = v.awakeEventLogs.filter(
        (x: any) => x.eventType === 'CONFIRMED_AWAKE',
      ).length;

      const hasAutoCheckoutFail = v.awakeEventLogs.some(
        (x: any) => x.eventType === 'AUTO_CHECKOUT_FAIL_CONFIRM',
      );

      const hasManualCheckout = v.awakeEventLogs.some(
        (x: any) => x.eventType === 'MANUAL_CHECKOUT',
      );

      const status = this.computeAwakeFinalStatus({
        reminderCount,
        confirmCount,
        hasAutoCheckoutFail,
        hasManualCheckout,
        autoCheckoutReason: v.autoCheckoutReason ?? null,
        autoCheckedOutAt: v.autoCheckedOutAt ?? null,
      });

      const individualName = [
        this.safeStr(v.individual?.firstName).trim(),
        this.safeStr(v.individual?.lastName).trim(),
      ]
        .filter(Boolean)
        .join(' ');

      const staffName = [
        this.safeStr(v.dsp?.firstName).trim(),
        this.safeStr(v.dsp?.lastName).trim(),
      ]
        .filter(Boolean)
        .join(' ');

      const serviceCode =
        v.scheduleShift?.service?.serviceCode ?? v.service?.serviceCode ?? '';

      const serviceName =
        v.scheduleShift?.service?.serviceName ?? v.service?.serviceName ?? '';

      return {
        id: v.id,
        date: v.checkInAt,
        dateLocal: v.checkInAt ? this.toLocalISODate(v.checkInAt) : '',
        individualId: v.individualId,
        individualName: individualName || '—',
        staffId: v.dspId,
        staffName: staffName || '—',
        serviceCode,
        serviceName,
        scheduleStart: v.scheduleShift?.plannedStart
          ? this.toLocalTimeHHmm(v.scheduleShift.plannedStart)
          : '',
        scheduleEnd: v.scheduleShift?.plannedEnd
          ? this.toLocalTimeHHmm(v.scheduleShift.plannedEnd)
          : '',
        visitStart: v.checkInAt ? this.toLocalTimeHHmm(v.checkInAt) : '',
        visitEnd: v.checkOutAt ? this.toLocalTimeHHmm(v.checkOutAt) : '',
        reminderCount,
        confirmCount,
        status,
        autoCheckoutReason: v.autoCheckoutReason ?? null,
        autoCheckedOutAt: v.autoCheckedOutAt ?? null,
      };
    });

    if (filter.status && String(filter.status).trim() !== '') {
      const wanted = String(filter.status).trim().toUpperCase();
      return mapped.filter((x) => x.status === wanted);
    }

    return mapped;
  }

  async getAwakeReportDetail(id: string) {
    const v = await this.prisma.visit.findUnique({
      where: { id },
      select: {
        id: true,
        scheduleShiftId: true,
        individualId: true,
        dspId: true,
        serviceId: true,
        checkInAt: true,
        checkOutAt: true,
        autoCheckedOutAt: true,
        autoCheckoutReason: true,
        scheduleShift: {
          select: {
            id: true,
            scheduleDate: true,
            plannedStart: true,
            plannedEnd: true,
            service: {
              select: {
                serviceCode: true,
                serviceName: true,
              },
            },
          },
        },
        individual: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        dsp: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        service: {
          select: {
            serviceCode: true,
            serviceName: true,
          },
        },
        awakeEventLogs: {
          select: {
            eventType: true,
          },
        },
      },
    });

    if (!v) return null;

    const reminderCount = v.awakeEventLogs.filter(
      (x: any) => x.eventType === 'REMINDER_SENT',
    ).length;

    const confirmCount = v.awakeEventLogs.filter(
      (x: any) => x.eventType === 'CONFIRMED_AWAKE',
    ).length;

    const hasAutoCheckoutFail = v.awakeEventLogs.some(
      (x: any) => x.eventType === 'AUTO_CHECKOUT_FAIL_CONFIRM',
    );

    const hasManualCheckout = v.awakeEventLogs.some(
      (x: any) => x.eventType === 'MANUAL_CHECKOUT',
    );

    const status = this.computeAwakeFinalStatus({
      reminderCount,
      confirmCount,
      hasAutoCheckoutFail,
      hasManualCheckout,
      autoCheckoutReason: v.autoCheckoutReason ?? null,
      autoCheckedOutAt: v.autoCheckedOutAt ?? null,
    });

    const individualName = [
      this.safeStr(v.individual?.firstName).trim(),
      this.safeStr(v.individual?.lastName).trim(),
    ]
      .filter(Boolean)
      .join(' ');

    const staffName = [
      this.safeStr(v.dsp?.firstName).trim(),
      this.safeStr(v.dsp?.lastName).trim(),
    ]
      .filter(Boolean)
      .join(' ');

    const serviceCode =
      v.scheduleShift?.service?.serviceCode ?? v.service?.serviceCode ?? '';

    const serviceName =
      v.scheduleShift?.service?.serviceName ?? v.service?.serviceName ?? '';

    return {
      id: v.id,
      date: v.checkInAt,
      dateLocal: v.checkInAt ? this.toLocalISODate(v.checkInAt) : '',
      individualId: v.individualId,
      individualName: individualName || '—',
      staffId: v.dspId,
      staffName: staffName || '—',
      serviceCode,
      serviceName,
      scheduleStart: v.scheduleShift?.plannedStart
        ? this.toLocalTimeHHmm(v.scheduleShift.plannedStart)
        : '',
      scheduleEnd: v.scheduleShift?.plannedEnd
        ? this.toLocalTimeHHmm(v.scheduleShift.plannedEnd)
        : '',
      visitStart: v.checkInAt ? this.toLocalTimeHHmm(v.checkInAt) : '',
      visitEnd: v.checkOutAt ? this.toLocalTimeHHmm(v.checkOutAt) : '',
      reminderCount,
      confirmCount,
      status,
      autoCheckoutReason: v.autoCheckoutReason ?? null,
      autoCheckedOutAt: v.autoCheckedOutAt ?? null,
    };
  }

  async getAwakeTimeline(id: string) {
    const exists = await this.prisma.visit.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) return null;

    const rows = await (this.prisma as any).awakeEventLog.findMany({
      where: { visitId: id },
      orderBy: { eventTime: 'asc' },
      select: {
        id: true,
        eventType: true,
        eventTime: true,
        note: true,
        meta: true,
        createdAt: true,
      },
    });

    return rows.map((x: any) => ({
      ...x,
      eventTimeLocal: x.eventTime ? this.toLocalDateTime(x.eventTime) : '',
      createdAtLocal: x.createdAt ? this.toLocalDateTime(x.createdAt) : '',
    }));
  }

  async getHealthIncidentReports(filter: HealthIncidentFilter) {
    const from = this.normalizeDateInput(filter.from);
    const to = this.normalizeDateInput(filter.to);

    let gte: Date | undefined;
    let lt: Date | undefined;

    if (from) {
      const startLocal = DateTime.fromISO(from, { zone: TZ }).startOf('day');
      gte = startLocal.toUTC().toJSDate();
    }

    if (to) {
      const endLocalExclusive = DateTime.fromISO(to, { zone: TZ })
        .plus({ days: 1 })
        .startOf('day');
      lt = endLocalExclusive.toUTC().toJSDate();
    }

    const where: any = {};
    if (gte || lt) {
      where.date = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
    }
    if (filter.staffId) where.staffId = filter.staffId;
    if (filter.individualId) where.individualId = filter.individualId;
    if (filter.status && String(filter.status).trim() !== '') {
      where.status = String(filter.status).trim();
    }

    const rows = await this.prisma.healthIncidentReport.findMany({
      where,
      orderBy: { date: 'desc' },
      select: this.healthIncidentSelect(),
    });

    return rows.map((r: any) => this.mapHealthIncidentRow(r));
  }

  async getHealthIncidentUnreadSummary() {
    const rows = await this.prisma.healthIncidentReport.findMany({
      where: { status: 'SUBMITTED' },
      orderBy: { date: 'desc' },
      select: {
        id: true,
        caseNumber: true,
        date: true,
        createdAt: true as any,
        staffName: true,
        individualName: true,
      },
    });

    return {
      total: rows.length,
      ids: rows.map((r: any) => r.id),
      items: rows.map((r: any) => ({
        id: r.id,
        caseNumber: r.caseNumber ?? null,
        dateLocal: r.date ? this.toLocalISODate(r.date) : '',
        createdAt: r.createdAt ?? null,
        staffName: r.staffName ?? null,
        individualName: r.individualName ?? null,
      })),
    };
  }

  async getHealthIncidentReportDetail(id: string) {
    const rpt = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: this.healthIncidentSelect(),
    });

    if (!rpt) return null;
    return this.mapHealthIncidentRow(rpt as any);
  }

  async getHealthIncidentTimeline(id: string) {
    const exists = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) return null;

    const rows = await this.prisma.healthIncidentCaseLog.findMany({
      where: { reportId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        actionType: true,
        actorUserId: true,
        actorEmployeeId: true,
        actorName: true,
        actorRole: true,
        note: true,
        meta: true,
        createdAt: true,
      },
    });

    return rows.map((x: any) => ({
      ...x,
      createdAtLocal: x.createdAt ? this.toLocalDateTime(x.createdAt) : '',
    }));
  }

  async getHealthIncidentAttachments(id: string) {
    const exists = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) return null;

    const rows = await this.prisma.healthIncidentAttachment.findMany({
      where: { reportId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        category: true,
        fileName: true,
        filePath: true,
        mimeType: true,
        fileSize: true,
        description: true,
        uploadedByUserId: true,
        uploadedByEmployeeId: true,
        uploadedByName: true,
        uploadedByRole: true,
        createdAt: true,
      },
    });

    return rows.map((x: any) => ({
      ...x,
      createdAtLocal: x.createdAt ? this.toLocalDateTime(x.createdAt) : '',
    }));
  }

  async getHealthIncidentAttachmentForDownload(
    reportId: string,
    attachmentId: string,
  ) {
    const report = await this.prisma.healthIncidentReport.findUnique({
      where: { id: reportId },
      select: { id: true },
    });
    if (!report) return null;

    const attachment = await this.prisma.healthIncidentAttachment.findFirst({
      where: {
        id: attachmentId,
        reportId,
      },
      select: {
        id: true,
        reportId: true,
        category: true,
        fileName: true,
        filePath: true,
        mimeType: true,
        fileSize: true,
        description: true,
        createdAt: true,
      },
    });

    if (!attachment) return null;
    return attachment;
  }

  getHealthIncidentAttachmentAbsolutePath(filePath: string): string {
    const safeRelative = this.asText(filePath).replace(/\\/g, '/');
    if (!safeRelative) {
      throw new Error('Missing file path');
    }

    const uploadsRoot = path.resolve(process.cwd(), 'uploads');
    const absPath = path.resolve(process.cwd(), safeRelative);

    if (
      absPath !== uploadsRoot &&
      !absPath.startsWith(uploadsRoot + path.sep)
    ) {
      throw new Error('Invalid file path');
    }

    if (!fs.existsSync(absPath)) {
      throw new Error('Attachment file not found on server');
    }

    return absPath;
  }

  async addHealthIncidentAttachment(
    id: string,
    body: HealthIncidentAttachmentInput,
  ) {
    const exists = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) return null;

    const category = this.asText(body.category) || 'CI_EVIDENCE';
    const fileName = this.asText(body.fileName);
    const filePath = this.asText(body.filePath);

    if (!fileName || !filePath) {
      throw new Error('Missing fileName or filePath');
    }

    const created = await this.prisma.healthIncidentAttachment.create({
      data: {
        reportId: id,
        category,
        fileName,
        filePath,
        mimeType: this.asText(body.mimeType) || null,
        fileSize:
          typeof body.fileSize === 'number' && Number.isFinite(body.fileSize)
            ? Math.trunc(body.fileSize)
            : null,
        description: this.asText(body.description) || null,
        uploadedByUserId: this.asText(body.uploadedByUserId) || null,
        uploadedByEmployeeId: this.asText(body.uploadedByEmployeeId) || null,
        uploadedByName: this.asText(body.uploadedByName) || null,
        uploadedByRole: this.asText(body.uploadedByRole) || null,
      },
      select: {
        id: true,
        category: true,
        fileName: true,
        filePath: true,
        mimeType: true,
        fileSize: true,
        description: true,
        uploadedByUserId: true,
        uploadedByEmployeeId: true,
        uploadedByName: true,
        uploadedByRole: true,
        createdAt: true,
      },
    });

    await this.addHealthIncidentCaseLog({
      reportId: id,
      actionType: 'ATTACHMENT_UPLOADED',
      actorUserId: body.uploadedByUserId || null,
      actorEmployeeId: body.uploadedByEmployeeId || null,
      actorName: body.uploadedByName || null,
      actorRole: body.uploadedByRole || null,
      note: `${category}: ${fileName}`,
      meta: {
        category,
        fileName,
        filePath,
        mimeType: body.mimeType || null,
        fileSize: body.fileSize ?? null,
      },
    });

    return {
      ...created,
      createdAtLocal: created.createdAt
        ? this.toLocalDateTime(created.createdAt)
        : '',
    };
  }

  private sanitizeUploadFileName(fileName: string): string {
    const base = this.safeStr(fileName).trim() || 'attachment';
    return base
      .replace(/[\\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 180);
  }

  private ensureDirectoryExists(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private validateHealthIncidentUploadFile(file: any) {
    if (!file) {
      throw new Error('Missing upload file');
    }

    const originalName = this.safeStr(file.originalname).trim();
    const ext = path.extname(originalName).toLowerCase();
    const mimeType = this.safeStr(file.mimetype).trim().toLowerCase();

    if (!originalName) {
      throw new Error('Invalid file name');
    }

    if (!HEALTH_INCIDENT_ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(
        'Invalid file type. Allowed: pdf, jpg, jpeg, png, doc, docx',
      );
    }

    if (mimeType && !HEALTH_INCIDENT_ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(
        'Invalid mime type. Allowed: pdf, jpg, jpeg, png, doc, docx',
      );
    }

    const fileSize = Number(file.size || 0);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      throw new Error('Invalid file size');
    }

    if (fileSize > HEALTH_INCIDENT_UPLOAD_MAX_BYTES) {
      throw new Error('File size exceeds 10MB limit');
    }
  }

  private buildHealthIncidentUploadRelativePath(
    reportId: string,
    originalFileName: string,
  ): string {
    const safeReportId = this.safeStr(reportId).trim();
    const safeFileName = this.sanitizeUploadFileName(originalFileName);
    const timestamp = Date.now();

    return path.join(
      'uploads',
      'health-incident',
      safeReportId,
      `${timestamp}_${safeFileName}`,
    );
  }

  async uploadHealthIncidentAttachment(
    id: string,
    file: any,
    body: {
      category?: string;
      description?: string;
      uploadedByUserId?: string;
      uploadedByEmployeeId?: string;
      uploadedByName?: string;
      uploadedByRole?: string;
    },
  ) {
    const exists = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) return null;

    this.validateHealthIncidentUploadFile(file);

    const relativeFilePath = this.buildHealthIncidentUploadRelativePath(
      id,
      file.originalname,
    );
    const absoluteFilePath = path.resolve(process.cwd(), relativeFilePath);
    const absoluteDir = path.dirname(absoluteFilePath);

    this.ensureDirectoryExists(absoluteDir);

    fs.writeFileSync(absoluteFilePath, file.buffer);

    const category = this.asText(body.category) || 'CI_EVIDENCE';
    const fileName =
      this.sanitizeUploadFileName(file.originalname) || 'attachment';
    const mimeType = this.asText(file.mimetype) || null;
    const fileSize =
      typeof file.size === 'number' && Number.isFinite(file.size)
        ? Math.trunc(file.size)
        : null;

    const created = await this.prisma.healthIncidentAttachment.create({
      data: {
        reportId: id,
        category,
        fileName,
        filePath: relativeFilePath.replace(/\\/g, '/'),
        mimeType,
        fileSize,
        description: this.asText(body.description) || null,
        uploadedByUserId: this.asText(body.uploadedByUserId) || null,
        uploadedByEmployeeId: this.asText(body.uploadedByEmployeeId) || null,
        uploadedByName: this.asText(body.uploadedByName) || null,
        uploadedByRole: this.asText(body.uploadedByRole) || null,
      },
      select: {
        id: true,
        category: true,
        fileName: true,
        filePath: true,
        mimeType: true,
        fileSize: true,
        description: true,
        uploadedByUserId: true,
        uploadedByEmployeeId: true,
        uploadedByName: true,
        uploadedByRole: true,
        createdAt: true,
      },
    });

    await this.addHealthIncidentCaseLog({
      reportId: id,
      actionType: 'ATTACHMENT_UPLOADED',
      actorUserId: body.uploadedByUserId || null,
      actorEmployeeId: body.uploadedByEmployeeId || null,
      actorName: body.uploadedByName || null,
      actorRole: body.uploadedByRole || null,
      note: `${category}: ${fileName}`,
      meta: {
        category,
        fileName,
        filePath: created.filePath,
        mimeType,
        fileSize,
      },
    });

    return {
      ...created,
      createdAtLocal: created.createdAt
        ? this.toLocalDateTime(created.createdAt)
        : '',
    };
  }

  async saveHealthIncidentReview(
    id: string,
    body: {
      status?: string;
      supervisorName?: string;
      supervisorDecision?: string;
      supervisorActionsTaken?: string;
      actorUserId?: string;
      actorName?: string;
    },
  ) {
    const exists = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        supervisorName: true,
        supervisorDecision: true,
        supervisorActionsTaken: true,
      },
    });
    if (!exists) return null;

    const data: any = {};

    if (body.status && String(body.status).trim() !== '') {
      data.status = String(body.status).trim();
    }

    if (body.supervisorName !== undefined)
      data.supervisorName = body.supervisorName;
    if (body.supervisorDecision !== undefined)
      data.supervisorDecision = body.supervisorDecision;
    if (body.supervisorActionsTaken !== undefined)
      data.supervisorActionsTaken = body.supervisorActionsTaken;

    if (
      data.status !== undefined ||
      data.supervisorName !== undefined ||
      data.supervisorDecision !== undefined ||
      data.supervisorActionsTaken !== undefined
    ) {
      data.reviewedAt = new Date();
    }

    const updated = await this.prisma.healthIncidentReport.update({
      where: { id },
      data,
      select: this.healthIncidentSelect(),
    });

    const mapped = this.mapHealthIncidentRow(updated as any);

    await this.addHealthIncidentCaseLog({
      reportId: id,
      actionType: 'REVIEW_SAVED',
      actorUserId: body.actorUserId || null,
      actorName: body.actorName || body.supervisorName || null,
      actorRole: 'SUPERVISOR',
      note: 'Supervisor review updated',
      meta: {
        previous: {
          status: exists.status,
          supervisorName: exists.supervisorName,
          supervisorDecision: exists.supervisorDecision,
          supervisorActionsTaken: exists.supervisorActionsTaken,
        },
        current: {
          status: updated.status,
          supervisorName: updated.supervisorName,
          supervisorDecision: updated.supervisorDecision,
          supervisorActionsTaken: updated.supervisorActionsTaken,
        },
      },
    });

    return mapped;
  }

  async saveHealthIncidentInvestigation(
    id: string,
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
    const exists = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        investigationFindings: true,
        rootCause: true,
        witnessNotes: true,
        correctiveActions: true,
        recommendation: true,
        investigatedByStaffId: true,
        investigatedByName: true,
      },
    });
    if (!exists) return null;

    const data: any = {
      status: 'INVESTIGATED',
      investigatedAt: new Date(),
    };

    if (body.investigationFindings !== undefined)
      data.investigationFindings = body.investigationFindings;
    if (body.rootCause !== undefined) data.rootCause = body.rootCause;
    if (body.witnessNotes !== undefined) data.witnessNotes = body.witnessNotes;
    if (body.correctiveActions !== undefined)
      data.correctiveActions = body.correctiveActions;
    if (body.recommendation !== undefined)
      data.recommendation = body.recommendation;
    if (body.investigatedByStaffId !== undefined)
      data.investigatedByStaffId = body.investigatedByStaffId;
    if (body.investigatedByName !== undefined)
      data.investigatedByName = body.investigatedByName;

    const updated = await this.prisma.healthIncidentReport.update({
      where: { id },
      data,
      select: this.healthIncidentSelect(),
    });

    const mapped = this.mapHealthIncidentRow(updated as any);

    await this.addHealthIncidentCaseLog({
      reportId: id,
      actionType: 'CI_SUBMITTED',
      actorUserId: body.actorUserId || null,
      actorEmployeeId: body.investigatedByStaffId || null,
      actorName: body.actorName || body.investigatedByName || null,
      actorRole: 'CI',
      note: 'Investigation submitted',
      meta: {
        previous: {
          status: exists.status,
          investigationFindings: exists.investigationFindings,
          rootCause: exists.rootCause,
          witnessNotes: exists.witnessNotes,
          correctiveActions: exists.correctiveActions,
          recommendation: exists.recommendation,
          investigatedByStaffId: exists.investigatedByStaffId,
          investigatedByName: exists.investigatedByName,
        },
        current: {
          status: updated.status,
          investigationFindings: updated.investigationFindings,
          rootCause: updated.rootCause,
          witnessNotes: updated.witnessNotes,
          correctiveActions: updated.correctiveActions,
          recommendation: updated.recommendation,
          investigatedByStaffId: updated.investigatedByStaffId,
          investigatedByName: updated.investigatedByName,
          investigatedAt: updated.investigatedAt,
        },
      },
    });

    await this.sendCiSubmittedEmailSafe(updated, mapped);

    return mapped;
  }

  async closeHealthIncidentReport(
    id: string,
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
    const exists = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        supervisorName: true,
        supervisorDecision: true,
        supervisorActionsTaken: true,
        finalDecision: true,
        finalSummary: true,
        allowDspViewOutcome: true,
        closedAt: true,
        closedByUserId: true,
        closedByName: true,
      },
    });
    if (!exists) return null;

    const data: any = {
      status: 'CLOSED',
      reviewedAt: new Date(),
      closedAt: new Date(),
    };

    if (body.supervisorName !== undefined)
      data.supervisorName = body.supervisorName;
    if (body.supervisorDecision !== undefined)
      data.supervisorDecision = body.supervisorDecision;
    if (body.supervisorActionsTaken !== undefined)
      data.supervisorActionsTaken = body.supervisorActionsTaken;
    if (body.finalDecision !== undefined)
      data.finalDecision = body.finalDecision;
    if (body.finalSummary !== undefined) data.finalSummary = body.finalSummary;
    if (typeof body.allowDspViewOutcome === 'boolean') {
      data.allowDspViewOutcome = body.allowDspViewOutcome;
    }
    if (body.closedByUserId !== undefined)
      data.closedByUserId = body.closedByUserId;
    if (body.closedByName !== undefined) data.closedByName = body.closedByName;

    const updated = await this.prisma.healthIncidentReport.update({
      where: { id },
      data,
      select: this.healthIncidentSelect(),
    });

    const mapped = this.mapHealthIncidentRow(updated as any);

    await this.addHealthIncidentCaseLog({
      reportId: id,
      actionType: 'CASE_CLOSED',
      actorUserId: body.actorUserId || body.closedByUserId || null,
      actorName:
        body.actorName ||
        body.closedByName ||
        body.supervisorName ||
        updated.supervisorName ||
        null,
      actorRole: 'SUPERVISOR',
      note: 'Case closed',
      meta: {
        previous: {
          status: exists.status,
          supervisorName: exists.supervisorName,
          supervisorDecision: exists.supervisorDecision,
          supervisorActionsTaken: exists.supervisorActionsTaken,
          finalDecision: exists.finalDecision,
          finalSummary: exists.finalSummary,
          allowDspViewOutcome: exists.allowDspViewOutcome,
          closedAt: exists.closedAt,
          closedByUserId: exists.closedByUserId,
          closedByName: exists.closedByName,
        },
        current: {
          status: updated.status,
          supervisorName: updated.supervisorName,
          supervisorDecision: updated.supervisorDecision,
          supervisorActionsTaken: updated.supervisorActionsTaken,
          finalDecision: updated.finalDecision,
          finalSummary: updated.finalSummary,
          allowDspViewOutcome: updated.allowDspViewOutcome,
          closedAt: updated.closedAt,
          closedByUserId: updated.closedByUserId,
          closedByName: updated.closedByName,
        },
      },
    });

    await this.sendCaseClosedSummaryEmailSafe(updated, mapped);

    return mapped;
  }

  async assignCI(
    id: string,
    body: {
      ciName?: string;
      ciEmail?: string;
      ciPhone?: string;
      ciAssignedByUserId?: string;
      ciAssignedByName?: string;
    },
  ) {
    const exists = await this.prisma.healthIncidentReport.findUnique({
      where: { id },
      select: {
        id: true,
        ciName: true,
        ciEmail: true,
        ciPhone: true,
        ciAssignedAt: true,
        ciAssignedByUserId: true,
        ciAssignedByName: true,
      },
    });
    if (!exists) return null;

    const data: any = {
      status: 'ASSIGNED',
      ciAssignedAt: new Date(),
    };

    if (body.ciName !== undefined) data.ciName = body.ciName;
    if (body.ciEmail !== undefined) data.ciEmail = body.ciEmail;
    if (body.ciPhone !== undefined) data.ciPhone = body.ciPhone;

    if (
      body.ciAssignedByUserId &&
      String(body.ciAssignedByUserId).trim() !== ''
    ) {
      data.ciAssignedByUserId = String(body.ciAssignedByUserId).trim();
    }
    if (body.ciAssignedByName !== undefined)
      data.ciAssignedByName = body.ciAssignedByName;

    const updated = await this.prisma.healthIncidentReport.update({
      where: { id },
      data,
      select: this.healthIncidentSelect(),
    });

    const mapped = this.mapHealthIncidentRow(updated as any);
    const ciEmail = String((updated as any).ciEmail || '').trim();
    const webUrl = this.buildHealthIncidentWebUrl(id);

    const previousCi = [exists.ciName, exists.ciEmail, exists.ciPhone]
      .map((x) => this.asText(x))
      .filter(Boolean)
      .join(' | ');
    const currentCi = [updated.ciName, updated.ciEmail, updated.ciPhone]
      .map((x: any) => this.asText(x))
      .filter(Boolean)
      .join(' | ');

    await this.addHealthIncidentCaseLog({
      reportId: id,
      actionType: previousCi ? 'CI_REASSIGNED' : 'CI_ASSIGNED',
      actorUserId: body.ciAssignedByUserId || null,
      actorName: body.ciAssignedByName || null,
      actorRole: 'SUPERVISOR',
      note: previousCi ? 'CI reassigned' : 'CI assigned',
      meta: {
        previous: {
          ciName: exists.ciName,
          ciEmail: exists.ciEmail,
          ciPhone: exists.ciPhone,
          ciAssignedAt: exists.ciAssignedAt,
          ciAssignedByUserId: exists.ciAssignedByUserId,
          ciAssignedByName: exists.ciAssignedByName,
        },
        current: {
          ciName: updated.ciName,
          ciEmail: updated.ciEmail,
          ciPhone: updated.ciPhone,
          ciAssignedAt: updated.ciAssignedAt,
          ciAssignedByUserId: updated.ciAssignedByUserId,
          ciAssignedByName: updated.ciAssignedByName,
        },
        previousCi,
        currentCi,
      },
    });

    console.log('[assignCI] start mail flow', {
      reportId: id,
      ciEmail,
      status: (updated as any).status,
      individualName: (updated as any).individualName,
      staffName: (updated as any).staffName,
      hasPayload: !!(updated as any).payload,
    });

    if (!ciEmail) {
      console.error('[assignCI] missing ciEmail, email skipped');
      return mapped;
    }

    try {
      const dateLocal = (updated as any).date
        ? this.toLocalISODate((updated as any).date)
        : '';

      console.log('[assignCI] building PDF...');

      const pdfBuf = await this.buildHealthIncidentPdfBuffer({
        reportId: id,
        dateLocal,
        status: this.safeStr((updated as any).status || ''),
        incidentType: mapped.incidentType,

        individualName: this.safeStr((updated as any).individualName || ''),
        staffName: this.safeStr((updated as any).staffName || ''),
        staffEmail: this.safeStr((updated as any).staffEmail || ''),

        shiftStart: mapped.shiftStart || null,
        shiftEnd: mapped.shiftEnd || null,
        serviceCode: (updated as any).shift?.service?.serviceCode ?? null,
        serviceName: (updated as any).shift?.service?.serviceName ?? null,

        supervisorName: this.safeStr((updated as any).supervisorName || ''),
        supervisorDecision: this.safeStr(
          (updated as any).supervisorDecision || '',
        ),
        supervisorActionsTaken: this.safeStr(
          (updated as any).supervisorActionsTaken || '',
        ),
        reviewedAt: (updated as any).reviewedAt ?? null,

        ciName: this.safeStr((updated as any).ciName || ''),
        ciEmail: this.safeStr((updated as any).ciEmail || ''),
        ciPhone: this.safeStr((updated as any).ciPhone || ''),
        ciAssignedAt: (updated as any).ciAssignedAt ?? null,
        ciAssignedByName: this.safeStr((updated as any).ciAssignedByName || ''),

        payload: (updated as any).payload,
      });

      console.log('[assignCI] PDF built OK', {
        bytes: pdfBuf.length,
      });

      const filename = `HealthIncident_${dateLocal || 'report'}_${id}.pdf`;

      console.log('[assignCI] sending email...', {
        to: ciEmail,
        filename,
        webUrl,
      });

      await this.mailService.sendCiAssignmentEmail({
        to: ciEmail,
        ciName: (updated as any).ciName || null,
        individualName: (updated as any).individualName || null,
        dspName: (updated as any).staffName || null,
        incidentType: mapped.incidentType,
        reportDateLocal: dateLocal || null,
        link: webUrl,
        attachments: [
          {
            filename,
            content: pdfBuf,
            contentType: 'application/pdf',
          },
        ],
      });

      console.log('[assignCI] email sent OK', {
        to: ciEmail,
        reportId: id,
      });
    } catch (e: any) {
      console.error('[assignCI] send email with PDF failed');
      console.error('[assignCI] error message:', e?.message ?? e);
      console.error('[assignCI] error stack:', e?.stack ?? 'no-stack');
    }

    return mapped;
  }
}