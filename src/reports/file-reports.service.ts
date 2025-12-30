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

type ReportType = 'staff' | 'individual';

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
    if (/^[a-zA-Z]:\\/.test(p)) return true;
    if (/^\\\\/.test(p)) return true;
    return false;
  }

  /**
   * Store RELATIVE path in DB
   */
  private toDbPath(absPath: string): string {
    const rel = path.relative(process.cwd(), absPath);
    return rel.split(path.sep).join('/');
  }

  /**
   * Convert DB path to absolute path.
   */
  private fromDbPath(dbPath?: string | null): string | null {
    if (!dbPath) return null;
    if (this.isObviouslyWindowsPath(dbPath)) return null;

    const normalized = dbPath.replace(/\\/g, '/');
    if (normalized.startsWith('/')) return normalized;

    return path.join(process.cwd(), normalized);
  }

  private resolveTemplatePath() {
    const nameCandidates = [
      'Daily Note – Template.docx',
      'Daily Note - Template.docx',
      'Service Note – Template.docx',
      'Service Note - Template.docx',
    ];

    const dirCandidates = [
      path.join(process.cwd(), 'src', 'reports', 'templates'),
      path.join(process.cwd(), 'reports', 'templates'),
      path.join(process.cwd(), 'dist', 'reports', 'templates'),
      path.join(process.cwd(), 'templates'),
    ];

    const envPath = process.env.DAILY_NOTE_TEMPLATE_PATH;
    if (envPath) {
      if (fs.existsSync(envPath)) return envPath;
    }

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

  // -----------------------------
  // Time helpers (HH:mm)
  // -----------------------------
  private parseHHmmToMinutes(v?: string | null): number | null {
    if (!v) return null;
    const s = String(v).trim();
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  private diffMinutesAllowOvernight(startMin: number, endMin: number): number {
    // allow overnight (e.g., 22:00 -> 06:00)
    if (endMin >= startMin) return endMin - startMin;
    return 24 * 60 - startMin + endMin;
  }

  private formatHours2(mins: number): string {
    return (mins / 60).toFixed(2);
  }

  private calcUnits15(mins: number): number {
    // safer: floor to 15-min blocks
    return Math.floor(mins / 15);
  }

  // -----------------------------
  // Signature helpers
  // -----------------------------
  private isDataUrlImage(s?: string | null): boolean {
    if (!s) return false;
    return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(String(s));
  }

  private extractSignatureDataUrls(payload: any): {
    staffSigDataUrl: string;
    individualSigDataUrl: string;
  } {
    const p = payload || {};

    // Mobile payload keys we saw:
    // - dspSignature: "data:image/png;base64,..."
    // - individualSignature: "data:image/png;base64,..."
    const staff =
      p.dspSignature ||
      p.staffSignature ||
      p.StaffSignature ||
      p.dsp_signature ||
      '';

    const ind =
      p.individualSignature ||
      p.clientSignature ||
      p.IndividualSignature ||
      p.individual_signature ||
      '';

    return {
      staffSigDataUrl: this.isDataUrlImage(staff) ? String(staff) : '',
      individualSigDataUrl: this.isDataUrlImage(ind) ? String(ind) : '',
    };
  }

  private dataUrlToPngBuffer(dataUrl: string): Buffer | null {
    if (!this.isDataUrlImage(dataUrl)) return null;
    const idx = dataUrl.indexOf('base64,');
    if (idx < 0) return null;
    const b64 = dataUrl.slice(idx + 'base64,'.length);
    try {
      return Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
  }

  private ensurePngContentType(ctXml: string): string {
    if (
      ctXml.includes('Extension="png"') ||
      ctXml.includes("Extension='png'")
    ) {
      return ctXml;
    }

    // Add before closing </Types>
    const insert = '<Default Extension="png" ContentType="image/png"/>';
    if (ctXml.includes('</Types>')) {
      return ctXml.replace('</Types>', `${insert}</Types>`);
    }
    return ctXml;
  }

  private nextRelId(relsXml: string): number {
    const ids = Array.from(relsXml.matchAll(/Id="rId(\d+)"/g)).map((m) =>
      Number(m[1]),
    );
    const max = ids.length ? Math.max(...ids) : 0;
    return max + 1;
  }

  // Fixed display size (px -> EMU)
  // 1 px @96dpi = 9525 EMU
  private pxToEmu(px: number): number {
    return Math.round(px * 9525);
  }

  private buildDrawingXml(
    rId: string,
    filename: string,
    cxEmu: number,
    cyEmu: number,
  ): string {
    // Minimal WordprocessingML inline image
    // Note: keep it in one run context replacement
    const docPrId = Math.floor(Math.random() * 100000) + 1;
    const picId = Math.floor(Math.random() * 100000) + 1;

    return (
      `<w:drawing>` +
      `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cxEmu}" cy="${cyEmu}"/>` +
      `<wp:docPr id="${docPrId}" name="${this.safeStr(filename)}"/>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr>` +
      `<pic:cNvPr id="${picId}" name="${this.safeStr(filename)}"/>` +
      `<pic:cNvPicPr/>` +
      `</pic:nvPicPr>` +
      `<pic:blipFill>` +
      `<a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
      `<a:stretch><a:fillRect/></a:stretch>` +
      `</pic:blipFill>` +
      `<pic:spPr>` +
      `<a:xfrm>` +
      `<a:off x="0" y="0"/>` +
      `<a:ext cx="${cxEmu}" cy="${cyEmu}"/>` +
      `</a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `</pic:spPr>` +
      `</pic:pic>` +
      `</a:graphicData>` +
      `</a:graphic>` +
      `</wp:inline>` +
      `</w:drawing>`
    );
  }

  private escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Compute rels path for any word xml part:
   * - word/document.xml -> word/_rels/document.xml.rels
   * - word/header1.xml  -> word/_rels/header1.xml.rels
   * - word/drawings/drawing1.xml -> word/drawings/_rels/drawing1.xml.rels
   */
  private relsPathForXml(xmlPath: string): string {
    const lastSlash = xmlPath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? xmlPath.slice(0, lastSlash) : 'word';
    const base = lastSlash >= 0 ? xmlPath.slice(lastSlash + 1) : xmlPath;
    return `${dir}/_rels/${base}.rels`;
  }

  private ensureRelsXml(zip: any, relsPath: string): string {
    const f = zip.file(relsPath);
    if (f) return f.asText();
    // Minimal Relationships part
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    );
  }

  /**
   * Replace split token stored by Word as:
   *   <w:t>{%</w:t> ... <w:t>NAME</w:t> ... <w:t>%}</w:t>
   * Allow arbitrary tags between pieces (proofErr, runs, etc).
   */
  private replaceSplitToken(
    xml: string,
    name: string,
    replacement: string,
  ): string {
    const n = this.escapeRegExp(name);
    const re = new RegExp(
      `<w:t[^>]*>\\{\\%<\\/w:t>[\\s\\S]*?<w:t[^>]*>${n}<\\/w:t>[\\s\\S]*?<w:t[^>]*>\\%\\}<\\/w:t>`,
      'g',
    );
    return xml.replace(re, replacement);
  }

  // ✅ NEW: Replace split mustache token "{{Name}}" even if Word splits across runs.
  private replaceSplitMustacheToken(
    xml: string,
    name: string,
    replacement: string,
  ): string {
    const n = this.escapeRegExp(name);
    // Matches: <w:t>{{</w:t> ... <w:t>Name</w:t> ... <w:t>}}</w:t>
    const re = new RegExp(
      `<w:t[^>]*>\\{\\{<\\/w:t>[\\s\\S]*?<w:t[^>]*>${n}<\\/w:t>[\\s\\S]*?<w:t[^>]*>\\}\\}<\\/w:t>`,
      'g',
    );
    return xml.replace(re, replacement);
  }

  // ✅ NEW: Patch {{OverReason}} / {{ShortReason}} across ALL xml parts (document, headers, drawings, textboxes).
  private patchMustacheTokensIntoDocx(
    docxBuf: Buffer,
    replacements: Record<string, string>,
  ): Buffer {
    const zip: any = new (PizZip as any)(docxBuf);

    const xmlNames = Object.keys(zip.files || {}).filter(
      (n) => n.startsWith('word/') && n.endsWith('.xml') && !!zip.file(n),
    );

    for (const xmlPath of xmlNames) {
      const xmlFile = zip.file(xmlPath);
      if (!xmlFile) continue;

      let xml = xmlFile.asText();
      let changed = false;

      for (const [key, valueRaw] of Object.entries(replacements)) {
        const value = this.safeStr(valueRaw ?? '');
        const token = `{{${key}}}`;

        const before = xml;

        // contiguous token
        if (xml.includes(token)) {
          xml = xml.split(token).join(value);
        }

        // split token across runs
        xml = this.replaceSplitMustacheToken(xml, key, value);

        if (xml !== before) changed = true;
      }

      if (changed) {
        zip.file(xmlPath, xml);
      }
    }

    return zip.generate({ type: 'nodebuffer' }) as Buffer;
  }

  /**
   * Inject signature PNG images into DOCX by replacing placeholders:
   * - {%StaffSignatureImage%} or split as "{%" + "StaffSignatureImage" + "%}"
   * - {%IndividualSignatureImage%} or split similarly
   *
   * This avoids dumping base64 text into the document.
   */
  private injectSignatureImagesIntoDocx(
    docxBuf: Buffer,
    staffSigDataUrl: string,
    individualSigDataUrl: string,
  ): Buffer {
    const staffPng = this.dataUrlToPngBuffer(staffSigDataUrl);
    const indPng = this.dataUrlToPngBuffer(individualSigDataUrl);

    // NOTE: avoid TS "PizZip as a type" by not typing it
    const zip: any = new (PizZip as any)(docxBuf);

    const ctFile = zip.file('[Content_Types].xml');
    if (ctFile && (staffPng || indPng)) {
      let ctXml = ctFile.asText();
      ctXml = this.ensurePngContentType(ctXml);
      zip.file('[Content_Types].xml', ctXml);
    }

    // Compute sizes
    const cx = this.pxToEmu(220);
    const cy = this.pxToEmu(70);

    const replacements: Array<{
      name: string; // token name without wrappers
      png: Buffer | null;
      filename: string;
    }> = [
      { name: 'StaffSignatureImage', png: staffPng, filename: 'sig_staff.png' },
      {
        name: 'IndividualSignatureImage',
        png: indPng,
        filename: 'sig_individual.png',
      },
    ];

    // Scan ALL word/*.xml parts (Word may store content in various xmls)
    const xmlNames = Object.keys(zip.files || {}).filter(
      (n) => n.startsWith('word/') && n.endsWith('.xml') && !!zip.file(n),
    );

    // Add images (once) into /word/media/
    if (staffPng) zip.file(`word/media/sig_staff.png`, staffPng);
    if (indPng) zip.file(`word/media/sig_individual.png`, indPng);

    for (const xmlPath of xmlNames) {
      const xmlFile = zip.file(xmlPath);
      if (!xmlFile) continue;

      let xml = xmlFile.asText();
      const relsPath = this.relsPathForXml(xmlPath);
      let relsXml = this.ensureRelsXml(zip, relsPath);

      let relsChanged = false;
      let xmlChanged = false;

      for (const r of replacements) {
        const fullToken = `{%${r.name}%}`;

        // If no png, remove token (both contiguous and split) to avoid printing tags
        if (!r.png) {
          const before = xml;
          xml = xml.replaceAll(fullToken, '');
          xml = this.replaceSplitToken(xml, r.name, '');
          if (xml !== before) xmlChanged = true;
          continue;
        }

        // Quick gate: if xml doesn't contain any of the pieces, skip
        if (
          !xml.includes(r.name) &&
          !xml.includes('{%') &&
          !xml.includes('%}')
        ) {
          continue;
        }

        // Add relationship
        const next = this.nextRelId(relsXml);
        const rId = `rId${next}`;
        const relTag = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${r.filename}"/>`;

        if (!relsXml.includes('</Relationships>')) {
          // malformed rels: don't break doc, just remove tokens so they don't show
          const before = xml;
          xml = xml.replaceAll(fullToken, '');
          xml = this.replaceSplitToken(xml, r.name, '');
          if (xml !== before) xmlChanged = true;
          continue;
        }

        // Ensure we don't add duplicate relationship repeatedly if token not present
        const tokenPresent =
          xml.includes(fullToken) ||
          (xml.includes(r.name) && xml.includes('{%') && xml.includes('%}'));

        if (!tokenPresent) continue;

        // Append relationship
        relsXml = relsXml.replace(
          '</Relationships>',
          `${relTag}</Relationships>`,
        );
        relsChanged = true;

        // Build drawing xml and replace tokens
        const drawing = this.buildDrawingXml(rId, r.filename, cx, cy);
        const runXml = `<w:r>${drawing}</w:r>`;

        const before = xml;

        // Case 1: contiguous token
        xml = xml.replaceAll(fullToken, runXml);

        // Case 2: split token: "{%" + name + "%}"
        xml = this.replaceSplitToken(xml, r.name, runXml);

        if (xml !== before) xmlChanged = true;
      }

      if (xmlChanged) {
        zip.file(xmlPath, xml);
      }
      if (relsChanged) {
        zip.file(relsPath, relsXml);
      }
    }

    const out: Buffer = zip.generate({ type: 'nodebuffer' });
    return out;
  }

  // -----------------------------
  // DB autofill: Individual & MA
  // -----------------------------
  private async getIndividualAutofill(individualId?: string | null): Promise<{
    address1: string;
    address2Line: string;
    ma: string;
  }> {
    if (!individualId) return { address1: '', address2Line: '', ma: '' };

    const ind = await this.prisma.individual.findUnique({
      where: { id: individualId },
      select: {
        address1: true,
        address2: true,
        city: true,
        state: true,
        zip: true,
        payers: {
          select: { type: true, memberId: true },
        },
      },
    });

    if (!ind) return { address1: '', address2Line: '', ma: '' };

    const address1 = this.safeStr(ind.address1 ?? '');

    const city = this.safeStr(ind.city ?? '');
    const state = this.safeStr(ind.state ?? '');
    const zip = this.safeStr(ind.zip ?? '');
    const addr2 = this.safeStr(ind.address2 ?? '');

    // Address2Line: prefer address2, else City/State/Zip; or combine nicely
    const cityLine = [city, state, zip]
      .filter(Boolean)
      .join(', ')
      .replace(', ,', ',')
      .trim();

    const address2Line = addr2
      ? cityLine
        ? `${addr2} • ${cityLine}`
        : addr2
      : cityLine;

    // MA: try Primary payer memberId first; else any payer memberId
    const primary = (ind.payers ?? []).find(
      (p) => String(p.type).toLowerCase() === 'primary',
    );
    const anyPayer = (ind.payers ?? [])[0];
    const ma = this.safeStr(primary?.memberId ?? anyPayer?.memberId ?? '');

    return { address1, address2Line, ma };
  }

  // -----------------------------
  // DB autofill: Outcome from ISP & BSP (IspBspForm.formData)
  // -----------------------------
  private async getOutcomeAutofill(
    individualId?: string | null,
  ): Promise<string> {
    if (!individualId) return '';

    const row = await this.prisma.ispBspForm.findUnique({
      where: { individualId },
      select: { formData: true },
    });

    const fd: any = row?.formData ?? {};
    const outcome =
      fd.outcomeStatement || fd.outcomeText || fd.outcome || fd.outcomes || '';

    if (Array.isArray(outcome)) return outcome.filter(Boolean).join('\n');
    if (typeof outcome === 'object' && outcome) return JSON.stringify(outcome);
    return this.safeStr(outcome);
  }

  // -----------------------------
  // Build template data (AUTO)
  // -----------------------------
  private async buildTemplateData(dn: any, reportType: ReportType) {
    const dateISO =
      dn.date instanceof Date
        ? this.localDateISO(dn.date)
        : dn.date
          ? this.localDateISO(new Date(dn.date))
          : '';

    const payload = dn.payload || {};

    // ✅ DB autofill (Address + MA)
    const auto = await this.getIndividualAutofill(dn.individualId ?? null);

    // ✅ DB autofill (Outcome from ISP/BSP)
    const outcomeAuto = await this.getOutcomeAutofill(dn.individualId ?? null);

    // ✅ Signature dataUrls (for WEB Preview + DOCX injection)
    const sig = this.extractSignatureDataUrls(payload);

    // ✅ Meals
    const meals = payload.meals || payload.Meals || {};
    const breakfast = meals.breakfast || meals.Breakfast || {};
    const lunch = meals.lunch || meals.Lunch || {};
    const dinner = meals.dinner || meals.Dinner || {};

    // ✅ Service note text
    const todayPlan =
      payload.todayPlan || payload.todaysPlan || payload.plan || '';
    const whatWeWorkedOn =
      payload.whatWeWorkedOn ||
      payload.communityInclusion ||
      payload.workedOn ||
      '';
    const opportunities =
      payload.opportunities ||
      payload.prefOpportunities ||
      payload.prefOpportunity ||
      '';

    // legacy objects
    const notes = payload.notes || payload.note || payload.progressNotes || {};
    const planObj =
      typeof payload.plan === 'object' && payload.plan ? payload.plan : {};
    const todayPlanObj =
      typeof payload.todayPlan === 'object' && payload.todayPlan
        ? payload.todayPlan
        : {};

    const supportsDuringServiceLegacy =
      todayPlanObj.supportsDuringService ??
      planObj.supportsDuringService ??
      notes.supportsDuringService ??
      '';

    const communityInclusionLegacy =
      todayPlanObj.communityInclusion ??
      planObj.communityInclusion ??
      notes.communityInclusion ??
      '';

    const prefOpportunitiesLegacy =
      todayPlanObj.prefOpportunities ??
      planObj.prefOpportunities ??
      notes.prefOpportunities ??
      '';

    // ✅ Compute totals if payload does NOT provide them
    const schedStartStr = this.safeStr(
      dn.scheduleStart || payload.scheduleStart || '',
    );
    const schedEndStr = this.safeStr(
      dn.scheduleEnd || payload.scheduleEnd || '',
    );
    const visitStartStr = this.safeStr(
      dn.visitStart || payload.visitStart || '',
    );
    const visitEndStr = this.safeStr(dn.visitEnd || payload.visitEnd || '');

    const schedStartMin = this.parseHHmmToMinutes(schedStartStr);
    const schedEndMin = this.parseHHmmToMinutes(schedEndStr);
    const visitStartMin = this.parseHHmmToMinutes(visitStartStr);
    const visitEndMin = this.parseHHmmToMinutes(visitEndStr);

    let plannedMinutes: number | null = null;
    if (schedStartMin !== null && schedEndMin !== null) {
      plannedMinutes = this.diffMinutesAllowOvernight(
        schedStartMin,
        schedEndMin,
      );
    }

    let actualMinutes: number | null = null;
    if (visitStartMin !== null && visitEndMin !== null) {
      actualMinutes = this.diffMinutesAllowOvernight(
        visitStartMin,
        visitEndMin,
      );
    }

    const totalH =
      payload.totalH ||
      payload.totalHours ||
      (actualMinutes !== null ? this.formatHours2(actualMinutes) : '');

    const billableUnits =
      payload.billableUnits ||
      payload.units ||
      (actualMinutes !== null ? String(this.calcUnits15(actualMinutes)) : '');

    const lostMinutes =
      payload.lostMinutes ??
      (plannedMinutes !== null &&
      actualMinutes !== null &&
      plannedMinutes > actualMinutes
        ? String(plannedMinutes - actualMinutes)
        : '');

    const lostUnits =
      payload.lostUnits ??
      (typeof lostMinutes === 'string' && lostMinutes !== ''
        ? String(this.calcUnits15(Number(lostMinutes)))
        : '');

    const underHours =
      payload.underHours ??
      (plannedMinutes !== null &&
      actualMinutes !== null &&
      plannedMinutes > actualMinutes
        ? this.formatHours2(plannedMinutes - actualMinutes)
        : '');

    const overHours =
      payload.overHours ||
      payload.OverHours ||
      (plannedMinutes !== null &&
      actualMinutes !== null &&
      actualMinutes > plannedMinutes
        ? this.formatHours2(actualMinutes - plannedMinutes)
        : '');

    // ✅ Mileage: template needs {{Mileage}}
    const mileage = dn.mileage ?? payload.mileage ?? payload.totalMileage ?? '';

    // ✅ IMPORTANT FIX:
    // Address MUST prefer DB autofill first (avoid payload accidentally storing company address)
    const address1DbFirst =
      auto.address1 ||
      payload.patientAddress1 ||
      payload.individualAddress1 ||
      payload.individualAddress ||
      '';

    const address2DbFirst =
      auto.address2Line ||
      payload.patientAddress2 ||
      payload.individualAddress2 ||
      '';

    // ✅ MA prefer payload, fallback DB
    const ma = this.safeStr(
      payload.patientMA || payload.ma || payload.individualMa || auto.ma || '',
    );

    // ✅ Keep old "Signed" markers (not used for image, but keep for compatibility)
    const staffSigned = sig.staffSigDataUrl ? 'Signed' : '';
    const individualSigned = sig.individualSigDataUrl ? 'Signed' : '';

    // keep for future branching without breaking API
    const _rt = reportType;

    return {
      ServiceType: this.safeStr(dn.serviceName || dn.serviceCode || ''),
      PatientName: this.safeStr(dn.individualName || ''),
      PatientMA: ma,
      DateFull: dateISO,

      StaffNickname: this.safeStr(dn.staffName || payload.staffName || ''),

      ScheduleStart: this.safeStr(schedStartStr),
      ScheduleEnd: this.safeStr(schedEndStr),

      StartTime: this.safeStr(visitStartStr),
      EndTime: this.safeStr(visitEndStr),

      // ✅ totals
      TotalH: this.safeStr(totalH),
      BillableUnits: this.safeStr(billableUnits),
      LostMinutes: this.safeStr(lostMinutes),
      LostUnits: this.safeStr(lostUnits),
      UnderHours: this.safeStr(underHours),
      OverHours: this.safeStr(overHours),

      // ✅ Mileage
      Mileage: this.safeStr(mileage),

      OverReason: this.safeStr(
        payload.overReason ??
          payload.overReasonText ??
          payload.varianceReason ?? // ✅ support mobile field
          '',
      ),
      CancelReason: this.safeStr(dn.cancelReason ?? payload.cancelReason ?? ''),
      ShortReason: this.safeStr(
        payload.shortReason ?? payload.varianceReason ?? '',
      ),

      // ✅ Outcome (payload first, fallback to ISP/BSP)
      OutcomeText: this.safeStr(
        payload.outcomeText ||
          payload.outcome ||
          payload.outcomeName ||
          outcomeAuto ||
          '',
      ),

      // ✅ Address from DB first (stable)
      PatientAddress1: this.safeStr(address1DbFirst),
      PatientAddress2: this.safeStr(address2DbFirst),

      // ✅ Page 2
      SupportsDuringService: this.safeStr(
        typeof todayPlan === 'string' ? todayPlan : supportsDuringServiceLegacy,
      ),
      CommunityInclusion: this.safeStr(
        typeof whatWeWorkedOn === 'string'
          ? whatWeWorkedOn
          : communityInclusionLegacy,
      ),
      PrefOpportunities: this.safeStr(
        typeof opportunities === 'string'
          ? opportunities
          : prefOpportunitiesLegacy,
      ),

      // ✅ Meals
      BreakfastTime: this.safeStr(
        breakfast.time ||
          breakfast.Time ||
          meals.breakfastTime ||
          meals.BreakfastTime ||
          '',
      ),
      BreakfastHad: this.safeStr(
        breakfast.had ||
          breakfast.Had ||
          meals.breakfastHad ||
          meals.BreakfastHad ||
          '',
      ),
      BreakfastOffered: this.safeStr(
        breakfast.offered ||
          breakfast.Offered ||
          meals.breakfastOffered ||
          meals.BreakfastOffered ||
          '',
      ),

      LunchTime: this.safeStr(
        lunch.time || lunch.Time || meals.lunchTime || meals.LunchTime || '',
      ),
      LunchHad: this.safeStr(
        lunch.had || lunch.Had || meals.lunchHad || meals.LunchHad || '',
      ),
      LunchOffered: this.safeStr(
        lunch.offered ||
          lunch.Offered ||
          meals.lunchOffered ||
          meals.LunchOffered ||
          '',
      ),

      DinnerTime: this.safeStr(
        dinner.time ||
          dinner.Time ||
          meals.dinnerTime ||
          meals.DinnerTime ||
          '',
      ),
      DinnerHad: this.safeStr(
        dinner.had || dinner.Had || meals.dinnerHad || meals.DinnerHad || '',
      ),
      DinnerOffered: this.safeStr(
        dinner.offered ||
          dinner.Offered ||
          meals.dinnerOffered ||
          meals.DinnerOffered ||
          '',
      ),

      // Old compatibility markers
      STAFF_SIGNATURE: this.safeStr(staffSigned),
      INDIVIDUAL_SIGNATURE: this.safeStr(individualSigned),

      // ✅ NEW: used by WEB Preview <img/> and DOCX injection
      StaffSignatureDataUrl: this.safeStr(sig.staffSigDataUrl),
      IndividualSignatureDataUrl: this.safeStr(sig.individualSigDataUrl),
    };
  }

  /**
   * ✅ PREVIEW DATA
   * MUST match DOC/PDF autofill exactly (Outcome from ISP/BSP included)
   *
   * GET /reports/daily-notes/:id/preview?type=staff|individual
   */
  async getPreviewData(dailyNoteId: string, reportType: ReportType = 'staff') {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id: dailyNoteId },
    });
    if (!dn) throw new Error('DailyNote not found');

    return this.buildTemplateData(dn, reportType);
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

    // DOC/PDF generation uses same mapping as preview (staff keys)
    const data: any = await this.buildTemplateData(dn, 'staff');

    try {
      doc.render(data);
    } catch (e: any) {
      const msg =
        e?.message || (typeof e === 'string' ? e : JSON.stringify(e, null, 2));
      throw new Error(`Docx template render failed: ${msg}`);
    }

    // 1) Generate base docx
    let out = doc.getZip().generate({ type: 'nodebuffer' }) as Buffer;

    // ✅ NEW: patch mustache tokens across ALL xml parts (textboxes/shapes)
    out = this.patchMustacheTokensIntoDocx(out, {
      OverReason: this.safeStr(data?.OverReason || ''),
      ShortReason: this.safeStr(data?.ShortReason || ''),
    });

    // 2) Inject signatures into placeholders inside docx (supports split tokens)
    out = this.injectSignatureImagesIntoDocx(
      out,
      this.safeStr(data?.StaffSignatureDataUrl || ''),
      this.safeStr(data?.IndividualSignatureDataUrl || ''),
    );

    return out;
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

  private async convertDocxToPdfCloud(docxAbsPath: string): Promise<Buffer> {
    if (!this.cloudConvert) {
      throw new Error(
        'CloudConvert not configured (missing CLOUDCONVERT_API_KEY)',
      );
    }

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

    await this.cloudConvert.tasks.upload(
      importTask,
      fs.createReadStream(docxAbsPath),
      path.basename(docxAbsPath),
    );

    const done = await this.cloudConvert.jobs.wait(job.id);
    const exportTask: any = done.tasks.find((t: any) => t.name === 'export-1');
    const fileUrl = exportTask?.result?.files?.[0]?.url;

    if (!fileUrl) throw new Error('CloudConvert export URL not found');

    const res = await fetch(fileUrl);
    if (!res.ok)
      throw new Error(`CloudConvert download failed: HTTP ${res.status}`);
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
    let docxAbs: string | null = this.fromDbPath(dn.staffReportDocPath ?? null);

    try {
      if (!docxAbs || !(await fs.pathExists(docxAbs))) {
        docxAbs = await this.generateStaffDocx(dailyNoteId);
      }

      if (this.cloudConvert) {
        const pdfBuf = await this.convertDocxToPdfCloud(docxAbs);
        await fs.writeFile(absPdfPath, pdfBuf);
      } else {
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

      if (this.cloudConvert) {
        const pdfBuf = await this.convertDocxToPdfCloud(docxAbs);
        await fs.writeFile(absPdfPath, pdfBuf);
      } else {
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
