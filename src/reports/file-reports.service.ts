// src/reports/file-reports.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs-extra';
import * as path from 'path';
import { spawn } from 'child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DateTime } from 'luxon';

// Template engine
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

const TZ = 'America/New_York';

@Injectable()
export class FileReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private localDateISO(d: Date): string {
    // Always treat DB Date as instant (UTC), then format for America/New_York
    return (
      DateTime.fromJSDate(d, { zone: 'utc' }).setZone(TZ).toISODate() ?? ''
    );
  }

  private buildBaseDir(dailyNote: { id: string; date: Date }) {
    const localDay = dailyNote.date
      ? this.localDateISO(dailyNote.date)
      : 'unknown-date';
    return path.join(
      process.cwd(),
      'uploads',
      'daily-notes',
      localDay,
      `dn_${dailyNote.id}`,
    );
  }

  private resolveTemplatePath() {
    const candidates = [
      process.env.DAILY_NOTE_TEMPLATE_PATH,
      path.join(
        process.cwd(),
        'src',
        'reports',
        'templates',
        'Daily Note – Template.docx',
      ),
      path.join(
        process.cwd(),
        'src',
        'reports',
        'templates',
        'Daily Note - Template.docx',
      ),
      path.join(process.cwd(), 'templates', 'Daily Note – Template.docx'),
      path.join(process.cwd(), 'templates', 'daily-note-template.docx'),
      path.join(
        process.cwd(),
        'dist',
        'reports',
        'templates',
        'Daily Note – Template.docx',
      ),
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }

    throw new Error(
      `Daily Note template not found. Set DAILY_NOTE_TEMPLATE_PATH or copy template to src/reports/templates/. Tried: ${candidates.join(
        ' | ',
      )}`,
    );
  }

  private safeStr(v: any) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  private buildTemplateData(dn: any) {
    const dateISO =
      dn.date instanceof Date
        ? this.localDateISO(dn.date)
        : dn.date
          ? this.localDateISO(new Date(dn.date))
          : '';

    const payload = dn.payload || {};
    const meals = payload.meals || payload.Meals || {};
    const plan = payload.plan || payload.todayPlan || payload.todaysPlan || {};
    const notes = payload.notes || payload.note || payload.progressNotes || {};

    return {
      ServiceType: this.safeStr(dn.serviceName || dn.serviceCode || ''),
      PatientName: this.safeStr(dn.individualName || ''),
      PatientMA: this.safeStr(payload.patientMA || payload.ma || ''),
      DateFull: dateISO,

      StaffNickname: this.safeStr(dn.staffName || ''),

      ScheduleStart: this.safeStr(dn.scheduleStart || ''),
      ScheduleEnd: this.safeStr(dn.scheduleEnd || ''),

      StartTime: this.safeStr(dn.visitStart || ''),
      EndTime: this.safeStr(dn.visitEnd || ''),

      TotalH: this.safeStr(payload.totalH || payload.totalHours || ''),
      BillableUnits: this.safeStr(payload.billableUnits || payload.units || ''),
      LostMinutes: this.safeStr(payload.lostMinutes || ''),
      LostUnits: this.safeStr(payload.lostUnits || ''),
      UnderHours: this.safeStr(payload.underHours || ''),
      // ✅ some templates use OverHours
      OverHours: this.safeStr(payload.overHours || payload.OverHours || ''),
      OverReason: this.safeStr(payload.overReason || ''),
      CancelReason: this.safeStr(dn.cancelReason || payload.cancelReason || ''),
      ShortReason: this.safeStr(payload.shortReason || ''),

      OutcomeText: this.safeStr(payload.outcomeText || payload.outcome || ''),
      PatientAddress1: this.safeStr(payload.patientAddress1 || ''),
      PatientAddress2: this.safeStr(payload.patientAddress2 || ''),

      SupportsDuringService: this.safeStr(
        plan.supportsDuringService || notes.supportsDuringService || '',
      ),
      CommunityInclusion: this.safeStr(
        plan.communityInclusion || notes.communityInclusion || '',
      ),
      PrefOpportunities: this.safeStr(
        plan.prefOpportunities || notes.prefOpportunities || '',
      ),

      BreakfastTime: this.safeStr(
        meals.breakfastTime || meals.BreakfastTime || '',
      ),
      BreakfastHad: this.safeStr(
        meals.breakfastHad || meals.BreakfastHad || '',
      ),
      BreakfastOffered: this.safeStr(
        meals.breakfastOffered || meals.BreakfastOffered || '',
      ),

      LunchTime: this.safeStr(meals.lunchTime || meals.LunchTime || ''),
      LunchHad: this.safeStr(meals.lunchHad || meals.LunchHad || ''),
      LunchOffered: this.safeStr(
        meals.lunchOffered || meals.LunchOffered || '',
      ),

      DinnerTime: this.safeStr(meals.dinnerTime || meals.DinnerTime || ''),
      DinnerHad: this.safeStr(meals.dinnerHad || meals.DinnerHad || ''),
      DinnerOffered: this.safeStr(
        meals.dinnerOffered || meals.DinnerOffered || '',
      ),

      STAFF_SIGNATURE: '',
      INDIVIDUAL_SIGNATURE: '',
    };
  }

  private async renderDocxFromTemplate(dn: any): Promise<Buffer> {
    const templatePath = this.resolveTemplatePath();
    const content = await fs.readFile(templatePath, 'binary');
    const zip = new PizZip(content);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{{', end: '}}' },
    });

    const data = this.buildTemplateData(dn);

    try {
      doc.render(data);
    } catch (e: any) {
      const msg =
        e?.message || (typeof e === 'string' ? e : JSON.stringify(e, null, 2));
      throw new Error(`Docx template render failed: ${msg}`);
    }

    return doc.getZip().generate({ type: 'nodebuffer' });
  }

  async generateStaffDocx(dailyNoteId: string): Promise<string> {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id: dailyNoteId },
    });
    if (!dn) throw new Error('DailyNote not found');

    const baseDir = this.buildBaseDir(dn);
    await fs.ensureDir(baseDir);

    const filePath = path.join(baseDir, 'staff.docx');
    const buffer = await this.renderDocxFromTemplate(dn);

    await fs.writeFile(filePath, buffer);

    await this.prisma.dailyNote.update({
      where: { id: dailyNoteId },
      data: { staffReportDocPath: filePath },
    });

    return filePath;
  }

  async generateIndividualDocx(dailyNoteId: string): Promise<string> {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id: dailyNoteId },
    });
    if (!dn) throw new Error('DailyNote not found');

    const baseDir = this.buildBaseDir(dn);
    await fs.ensureDir(baseDir);

    const filePath = path.join(baseDir, 'individual.docx');
    const buffer = await this.renderDocxFromTemplate(dn);

    await fs.writeFile(filePath, buffer);

    await this.prisma.dailyNote.update({
      where: { id: dailyNoteId },
      data: { individualReportDocPath: filePath },
    });

    return filePath;
  }

  /**
   * ✅ Resolve LibreOffice soffice command robustly (Windows-friendly)
   * Priority:
   * 1) process.env.SOFFICE_PATH
   * 2) common Windows install paths
   * 3) "soffice" (PATH) as a last resort (Linux/mac or if user added PATH)
   */
  private resolveSofficeCommand(): string {
    const envPath =
      process.env.SOFFICE_PATH ||
      process.env.LIBREOFFICE_PATH ||
      process.env.LIBRE_OFFICE_PATH;

    if (envPath && fs.existsSync(envPath)) return envPath;

    const winCandidates = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ];
    for (const p of winCandidates) {
      if (fs.existsSync(p)) return p;
    }

    return 'soffice';
  }

  private async tryConvertDocxToPdf(
    docxPath: string,
    outDir: string,
  ): Promise<string | null> {
    const outPdf = path.join(
      outDir,
      path.basename(docxPath, path.extname(docxPath)) + '.pdf',
    );

    const soffice = this.resolveSofficeCommand();

    return new Promise((resolve) => {
      const proc = spawn(soffice, [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        docxPath,
      ]);

      proc.on('error', (err) => {
        console.error('[PDF] LibreOffice spawn error:', err);
        console.error('[PDF] soffice command used:', soffice);
        resolve(null);
      });

      proc.on('exit', async (code) => {
        if (code === 0 && (await fs.pathExists(outPdf))) {
          resolve(outPdf);
        } else {
          console.error('[PDF] LibreOffice convert failed. exit code:', code);
          console.error('[PDF] soffice command used:', soffice);
          console.error('[PDF] expected pdf path:', outPdf);
          resolve(null);
        }
      });
    });
  }

  private async generateFallbackPdf(dn: any, title: string): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let y = 760;
    const line = (text: string, bold = false) => {
      page.drawText(text, {
        x: 50,
        y,
        size: bold ? 14 : 11,
        font: bold ? fontBold : font,
      });
      y -= bold ? 22 : 16;
    };

    const dateISO =
      dn.date instanceof Date
        ? this.localDateISO(dn.date)
        : dn.date
          ? this.localDateISO(new Date(dn.date))
          : '';

    line(title, true);
    line(`Individual: ${dn.individualName ?? ''}`);
    line(`DSP: ${dn.staffName ?? ''}`);
    line(`Service: ${dn.serviceName ?? ''}`);
    line(`Date: ${dateISO}`);
    line(`Schedule: ${dn.scheduleStart ?? ''} - ${dn.scheduleEnd ?? ''}`);
    line(`Visit: ${dn.visitStart ?? ''} - ${dn.visitEnd ?? ''}`);
    line(`Mileage: ${dn.mileage ?? 0}`);
    line(`Canceled: ${dn.isCanceled ? 'YES' : 'NO'}`);
    line(`Cancel Reason: ${dn.cancelReason ?? ''}`);

    const bytes = await pdfDoc.save();
    return Buffer.from(bytes);
  }

  async generateStaffPdf(dailyNoteId: string): Promise<string> {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id: dailyNoteId },
    });
    if (!dn) throw new Error('DailyNote not found');

    const baseDir = this.buildBaseDir(dn);
    await fs.ensureDir(baseDir);

    const filePath = path.join(baseDir, 'staff.pdf');

    let docxPath: string | null = dn.staffReportDocPath ?? null;
    try {
      if (!docxPath) docxPath = await this.generateStaffDocx(dailyNoteId);

      const converted = await this.tryConvertDocxToPdf(docxPath, baseDir);
      if (converted) {
        // ✅ avoid copying a file onto itself
        if (path.resolve(converted) !== path.resolve(filePath)) {
          await fs.copy(converted, filePath, { overwrite: true });
        }
      } else {
        const buf = await this.generateFallbackPdf(
          dn,
          'SERVICE NOTE – STAFF REPORT',
        );
        await fs.writeFile(filePath, buf);
      }
    } catch (e) {
      const buf = await this.generateFallbackPdf(
        dn,
        'SERVICE NOTE – STAFF REPORT',
      );
      await fs.writeFile(filePath, buf);
    }

    await this.prisma.dailyNote.update({
      where: { id: dailyNoteId },
      data: { staffReportPdfPath: filePath },
    });

    return filePath;
  }

  async generateIndividualPdf(dailyNoteId: string): Promise<string> {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id: dailyNoteId },
    });
    if (!dn) throw new Error('DailyNote not found');

    const baseDir = this.buildBaseDir(dn);
    await fs.ensureDir(baseDir);

    const filePath = path.join(baseDir, 'individual.pdf');

    let docxPath: string | null = dn.individualReportDocPath ?? null;
    try {
      if (!docxPath) docxPath = await this.generateIndividualDocx(dailyNoteId);

      const converted = await this.tryConvertDocxToPdf(docxPath, baseDir);
      if (converted) {
        if (path.resolve(converted) !== path.resolve(filePath)) {
          await fs.copy(converted, filePath, { overwrite: true });
        }
      } else {
        const buf = await this.generateFallbackPdf(
          dn,
          'SERVICE NOTE – INDIVIDUAL REPORT',
        );
        await fs.writeFile(filePath, buf);
      }
    } catch (e) {
      const buf = await this.generateFallbackPdf(
        dn,
        'SERVICE NOTE – INDIVIDUAL REPORT',
      );
      await fs.writeFile(filePath, buf);
    }

    await this.prisma.dailyNote.update({
      where: { id: dailyNoteId },
      data: { individualReportPdfPath: filePath },
    });

    return filePath;
  }
}
