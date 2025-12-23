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

// ✅ CloudConvert for production DOCX -> PDF (Render)
import CloudConvert from 'cloudconvert';

const TZ = 'America/New_York';

@Injectable()
export class FileReportsService {
  // ✅ only enabled when CLOUDCONVERT_API_KEY exists
  private cloudConvert: CloudConvert | null = null;

  constructor(private readonly prisma: PrismaService) {
    const key = process.env.CLOUDCONVERT_API_KEY;
    if (key && String(key).trim().length > 0) {
      this.cloudConvert = new CloudConvert(String(key).trim());
    }
  }

  private localDateISO(d: Date): string {
    return (
      DateTime.fromJSDate(d, { zone: 'utc' }).setZone(TZ).toISODate() ?? ''
    );
  }

  /**
   * We always store files under: <cwd>/uploads/daily-notes/<YYYY-MM-DD>/dn_<id>/
   * On Render/Linux: cwd is something like /opt/render/project/src
   */
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

  private isObviouslyWindowsPath(p?: string | null): boolean {
    if (!p) return false;
    // C:\..., D:\...
    if (/^[a-zA-Z]:\\/.test(p)) return true;
    // \\server\share
    if (/^\\\\/.test(p)) return true;
    return false;
  }

  /**
   * Store RELATIVE path in DB to avoid Windows absolute path leaking into production.
   * Example saved in DB: uploads/daily-notes/2025-12-19/dn_xxx/staff.docx
   */
  private toDbPath(absPath: string): string {
    const rel = path.relative(process.cwd(), absPath);
    // Normalize to forward slashes so it is stable across OS
    return rel.split(path.sep).join('/');
  }

  /**
   * Convert DB path to absolute path.
   * - If DB path is already absolute POSIX, keep it.
   * - If DB path is Windows absolute, treat as invalid (return null).
   * - If DB path is relative, resolve from process.cwd().
   */
  private fromDbPath(dbPath?: string | null): string | null {
    if (!dbPath) return null;
    if (this.isObviouslyWindowsPath(dbPath)) return null;

    // If it contains backslashes but not drive letter, normalize first
    const normalized = dbPath.replace(/\\/g, '/');

    // POSIX absolute
    if (normalized.startsWith('/')) return normalized;

    // Relative -> absolute
    return path.join(process.cwd(), normalized);
  }

  private resolveTemplatePath() {
    // Support both dash types: "–" (en dash) and "-" (hyphen)
    const nameCandidates = [
      'Daily Note – Template.docx',
      'Daily Note - Template.docx',
      'Service Note – Template.docx',
      'Service Note - Template.docx',
    ];

    const dirCandidates = [
      // Common when running from repo root
      path.join(process.cwd(), 'src', 'reports', 'templates'),
      // Some setups run with cwd already at "src"
      path.join(process.cwd(), 'reports', 'templates'),
      // If built assets are copied
      path.join(process.cwd(), 'dist', 'reports', 'templates'),
      // Optional external folder
      path.join(process.cwd(), 'templates'),
    ];

    // 1) explicit env path wins
    const envPath = process.env.DAILY_NOTE_TEMPLATE_PATH;
    if (envPath) {
      if (fs.existsSync(envPath)) return envPath;
    }

    // 2) search
    const tried: string[] = [];
    for (const dir of dirCandidates) {
      for (const nm of nameCandidates) {
        const p = path.join(dir, nm);
        tried.push(p);
        if (fs.existsSync(p)) return p;
      }
    }

    throw new Error(
      `Daily Note template not found. ` +
        `Set DAILY_NOTE_TEMPLATE_PATH or commit the template into repo. ` +
        `Tried: ${tried.join(' | ')}`,
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

    const absPath = path.join(baseDir, 'staff.docx');
    const buffer = await this.renderDocxFromTemplate(dn);
    await fs.writeFile(absPath, buffer);

    await this.prisma.dailyNote.update({
      where: { id: dailyNoteId },
      data: { staffReportDocPath: this.toDbPath(absPath) },
    });

    return absPath;
  }

  async generateIndividualDocx(dailyNoteId: string): Promise<string> {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id: dailyNoteId },
    });
    if (!dn) throw new Error('DailyNote not found');

    const baseDir = this.buildBaseDir(dn);
    await fs.ensureDir(baseDir);

    const absPath = path.join(baseDir, 'individual.docx');
    const buffer = await this.renderDocxFromTemplate(dn);
    await fs.writeFile(absPath, buffer);

    await this.prisma.dailyNote.update({
      where: { id: dailyNoteId },
      data: { individualReportDocPath: this.toDbPath(absPath) },
    });

    return absPath;
  }

  /**
   * Resolve LibreOffice soffice command.
   * On Render native environment, soffice usually does NOT exist => ENOENT.
   */
  private resolveSofficeCommand(): string {
    const envPath =
      process.env.SOFFICE_PATH ||
      process.env.LIBREOFFICE_PATH ||
      process.env.LIBRE_OFFICE_PATH;

    if (envPath && fs.existsSync(envPath)) return envPath;

    // Windows candidates (local dev)
    const winCandidates = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ];
    for (const p of winCandidates) {
      if (fs.existsSync(p)) return p;
    }

    // Linux/mac: rely on PATH
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

  // ==========================
  // ✅ CloudConvert DOCX -> PDF
  // ==========================
  private async convertDocxToPdfCloud(docxAbsPath: string): Promise<Buffer> {
    if (!this.cloudConvert) {
      throw new Error(
        'CloudConvert not configured (missing CLOUDCONVERT_API_KEY)',
      );
    }

    // Create job: upload -> convert -> export/url
    const job = await this.cloudConvert.jobs.create({
      tasks: {
        'import-1': { operation: 'import/upload' },
        'convert-1': {
          operation: 'convert',
          input: ['import-1'],
          input_format: 'docx',
          output_format: 'pdf',
        },
        'export-1': {
          operation: 'export/url',
          input: ['convert-1'],
          inline: false,
          archive_multiple_files: false,
        },
      },
    });

    const importTask: any = job.tasks.find((t: any) => t.name === 'import-1');
    if (!importTask) throw new Error('CloudConvert import task not found');

    // Upload file stream
    await this.cloudConvert.tasks.upload(
      importTask,
      fs.createReadStream(docxAbsPath),
      path.basename(docxAbsPath),
    );

    // Wait for completion
    const done = await this.cloudConvert.jobs.wait(job.id);
    const exportTask: any = done.tasks.find((t: any) => t.name === 'export-1');
    const fileUrl = exportTask?.result?.files?.[0]?.url;

    if (!fileUrl) {
      throw new Error('CloudConvert export URL not found');
    }

    // Download PDF bytes
    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`CloudConvert download failed: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
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

    const absPdfPath = path.join(baseDir, 'staff.pdf');

    // If DB has old Windows path, ignore it and regenerate
    let docxAbs: string | null = this.fromDbPath(dn.staffReportDocPath ?? null);

    try {
      if (!docxAbs || !(await fs.pathExists(docxAbs))) {
        docxAbs = await this.generateStaffDocx(dailyNoteId);
      }

      // ✅ Production: CloudConvert => PDF matches DOC exactly
      if (this.cloudConvert) {
        const pdfBuf = await this.convertDocxToPdfCloud(docxAbs);
        await fs.writeFile(absPdfPath, pdfBuf);
      } else {
        // ✅ Local/dev: LibreOffice if available; else fallback
        const converted = await this.tryConvertDocxToPdf(docxAbs, baseDir);
        if (converted) {
          if (path.resolve(converted) !== path.resolve(absPdfPath)) {
            await fs.copy(converted, absPdfPath, { overwrite: true });
          }
        } else {
          const buf = await this.generateFallbackPdf(
            dn,
            'SERVICE NOTE – STAFF REPORT',
          );
          await fs.writeFile(absPdfPath, buf);
        }
      }
    } catch (e) {
      console.error('[PDF] generateStaffPdf failed:', e);
      const buf = await this.generateFallbackPdf(
        dn,
        'SERVICE NOTE – STAFF REPORT',
      );
      await fs.writeFile(absPdfPath, buf);
    }

    await this.prisma.dailyNote.update({
      where: { id: dailyNoteId },
      data: { staffReportPdfPath: this.toDbPath(absPdfPath) },
    });

    return absPdfPath;
  }

  async generateIndividualPdf(dailyNoteId: string): Promise<string> {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id: dailyNoteId },
    });
    if (!dn) throw new Error('DailyNote not found');

    const baseDir = this.buildBaseDir(dn);
    await fs.ensureDir(baseDir);

    const absPdfPath = path.join(baseDir, 'individual.pdf');

    let docxAbs: string | null = this.fromDbPath(
      dn.individualReportDocPath ?? null,
    );

    try {
      if (!docxAbs || !(await fs.pathExists(docxAbs))) {
        docxAbs = await this.generateIndividualDocx(dailyNoteId);
      }

      // ✅ Production: CloudConvert => PDF matches DOC exactly
      if (this.cloudConvert) {
        const pdfBuf = await this.convertDocxToPdfCloud(docxAbs);
        await fs.writeFile(absPdfPath, pdfBuf);
      } else {
        // ✅ Local/dev: LibreOffice if available; else fallback
        const converted = await this.tryConvertDocxToPdf(docxAbs, baseDir);
        if (converted) {
          if (path.resolve(converted) !== path.resolve(absPdfPath)) {
            await fs.copy(converted, absPdfPath, { overwrite: true });
          }
        } else {
          const buf = await this.generateFallbackPdf(
            dn,
            'SERVICE NOTE – INDIVIDUAL REPORT',
          );
          await fs.writeFile(absPdfPath, buf);
        }
      }
    } catch (e) {
      console.error('[PDF] generateIndividualPdf failed:', e);
      const buf = await this.generateFallbackPdf(
        dn,
        'SERVICE NOTE – INDIVIDUAL REPORT',
      );
      await fs.writeFile(absPdfPath, buf);
    }

    await this.prisma.dailyNote.update({
      where: { id: dailyNoteId },
      data: { individualReportPdfPath: this.toDbPath(absPdfPath) },
    });

    return absPdfPath;
  }
}
