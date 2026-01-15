// src/payroll/payroll.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DateTime } from 'luxon';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  AlignmentType,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  ShadingType,
  BorderStyle,
} from 'docx';

import { PrismaService } from '../prisma/prisma.service';
import type { PayrollExportDto } from './dto/payroll-export.dto';

// ✅ NEW: only count visits that belong to a COMPLETED ScheduleShift
import { ScheduleStatus } from '@prisma/client';

const TZ = 'America/New_York';

// =========================
// Company header (customize via ENV)
// =========================
const COMPANY_NAME =
  process.env.PAYROLL_COMPANY_NAME || 'Blue Angels Care , LLC';
const COMPANY_ADDRESS =
  process.env.PAYROLL_COMPANY_ADDRESS || '3107 Beale Avenue, Altoona, PA 16601';
const COMPANY_PHONE = process.env.PAYROLL_COMPANY_PHONE || '(814) 600-2313';

// Optional: absolute or relative path to a logo file (png/jpg)
// Example: PAYROLL_COMPANY_LOGO_PATH=uploads/assets/logo.png
const COMPANY_LOGO_PATH = (process.env.PAYROLL_COMPANY_LOGO_PATH || '')
  .toString()
  .trim();

// Dark blue (company name)
const COMPANY_NAME_COLOR = '1F4E79';

function clampNonNeg(n: any) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return x;
}

function money(n: number) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function num2(n: number) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toFixed(2);
}

function safeText(s: any) {
  const t = (s ?? '').toString().trim();
  return t ? t : '-';
}

function inferStaffType(role?: string | null): 'DSP' | 'OFFICE' {
  const r = (role || '').toLowerCase();
  if (r.includes('dsp')) return 'DSP';
  return 'OFFICE';
}

// ✅ HH:mm formatter from minutes (prevents ".08" confusion)
function fmtHHmm(totalMinutes: number) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ✅ detect png/jpg from buffer (docx ImageRun requires "type")
function detectImageType(buf: Buffer): 'png' | 'jpg' {
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf &&
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }

  // JPG magic: FF D8
  if (buf && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return 'jpg';
  }

  // default safe
  return 'png';
}

type Interval = { startMs: number; endMs: number };

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);

  const out: Interval[] = [];
  let cur = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n.startMs <= cur.endMs) {
      cur.endMs = Math.max(cur.endMs, n.endMs);
    } else {
      out.push(cur);
      cur = { ...n };
    }
  }
  out.push(cur);
  return out;
}

function sumIntervalsMinutes(intervals: Interval[]): number {
  let totalMs = 0;
  for (const it of intervals) {
    totalMs += Math.max(0, it.endMs - it.startMs);
  }
  return Math.max(0, Math.round(totalMs / 60000));
}

@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------
  // Helpers
  // -------------------------
  getBaseUrl(req: Request) {
    const proto =
      (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
    return `${proto}://${host}`;
  }

  private exportsDir() {
    return path.join(process.cwd(), 'uploads', 'exports');
  }

  private async ensureExportsDir() {
    await fs.ensureDir(this.exportsDir());
  }

  private resolveLogoPath() {
    if (!COMPANY_LOGO_PATH) return null;
    const p = path.isAbsolute(COMPANY_LOGO_PATH)
      ? COMPANY_LOGO_PATH
      : path.join(process.cwd(), COMPANY_LOGO_PATH);
    return p;
  }

  private async tryLoadLogoBuffer(): Promise<Buffer | null> {
    try {
      const p = this.resolveLogoPath();
      if (!p) return null;
      const exists = await fs.pathExists(p);
      if (!exists) return null;
      const buf = await fs.readFile(p);
      return buf && buf.length ? buf : null;
    } catch {
      return null;
    }
  }

  private noBorderTable(table: Table) {
    return table;
  }

  /**
   * ✅ NEW: Build dspId alias map to normalize Visit.dspId.
   * In DB, Visit.dspId may contain:
   * - Employee.id (internal cuid)
   * - Employee.employeeId (human code like "BAC-E-2025-008") [legacy]
   *
   * We normalize both to Employee.id so payroll is consistent.
   */
  private async buildDspAliasToTechIdMap(): Promise<Map<string, string>> {
    const emps = await this.prisma.employee.findMany({
      select: { id: true, employeeId: true },
    });

    const map = new Map<string, string>();
    for (const e of emps) {
      if (e?.id) map.set(e.id, e.id);
      if (e?.employeeId) map.set(e.employeeId, e.id);
    }
    return map;
  }

  // -------------------------
  // GET /payroll/employees
  // -------------------------
  async getEmployeesLite() {
    const employees = await this.prisma.employee.findMany({
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        employeeId: true,
        firstName: true,
        lastName: true,
        role: true,
        dob: true,
        ssn: true,
        address1: true,
        address2: true,
        city: true,
        state: true,
        zip: true,
        phone: true,
        email: true,
        status: true,
      },
    });

    const rates = await this.prisma.payrollRate.findMany({
      select: {
        employeeId: true,
        rate: true,
        trainingRate: true,
        mileageRate: true,
      },
    });

    const rateMap = new Map(
      rates.map((r) => [
        r.employeeId,
        {
          rate: r.rate,
          trainingRate: r.trainingRate,
          mileageRate: r.mileageRate,
        },
      ]),
    );

    return employees.map((e) => {
      const rr = rateMap.get(e.employeeId);
      const staffType = inferStaffType(e.role);

      return {
        employeeId: e.employeeId,
        firstName: e.firstName,
        lastName: e.lastName,
        role: e.role,

        dob: e.dob ?? null,
        ssn: e.ssn ?? null,

        address1: e.address1 ?? null,
        address2: e.address2 ?? null,
        city: e.city ?? null,
        state: e.state ?? null,
        zip: e.zip ?? null,

        phone: e.phone ?? null,
        email: e.email ?? null,

        rate: rr?.rate ?? null,
        trainingRate:
          typeof rr?.trainingRate === 'number' ? rr!.trainingRate : 10,
        mileageRate:
          typeof rr?.mileageRate === 'number' ? rr!.mileageRate : 0.3,

        staffType,
      };
    });
  }

  // -------------------------
  // POST /payroll/rates/upsert
  // -------------------------
  async upsertRates(
    items: Array<{
      employeeId: string;
      rate: number | null;
      trainingRate: number | null;
      mileageRate: number | null;
    }>,
  ) {
    for (const it of items) {
      const employeeId = (it.employeeId || '').trim();
      if (!employeeId) continue;

      await this.prisma.payrollRate.upsert({
        where: { employeeId },
        create: {
          id: `rate_${employeeId}_${DateTime.now().toMillis()}`,
          employeeId,
          rate: it.rate ?? null,
          trainingRate: it.trainingRate ?? null,
          mileageRate: it.mileageRate ?? null,
        },
        update: {
          rate: it.rate ?? null,
          trainingRate: it.trainingRate ?? null,
          mileageRate: it.mileageRate ?? null,
        },
      });
    }

    return { ok: true };
  }

  // -------------------------
  // compute payroll period as [from, toExclusive)
  // -------------------------
  private computePeriod(from: string, to: string) {
    const fromDt = DateTime.fromISO(from, { zone: TZ }).startOf('day');
    const toDt = DateTime.fromISO(to, { zone: TZ }).startOf('day');
    if (!fromDt.isValid || !toDt.isValid) {
      throw new BadRequestException('Invalid period');
    }
    const toExclusive = toDt.plus({ days: 1 });
    if (toExclusive <= fromDt) {
      throw new BadRequestException('Invalid period: to < from');
    }
    return { fromDt, toExclusive };
  }

  // -------------------------
  // VISIT minutes (dedup + merge overlap)
  // - normalize Visit.dspId to Employee.id (tech id)
  // - ✅ ONLY count visits whose ScheduleShift is COMPLETED
  // -------------------------
  private async getVisitMinutesByEmployeeTechId(
    fromDt: DateTime,
    toExclusive: DateTime,
    dspAliasToTechId: Map<string, string>,
  ) {
    const visits = await this.prisma.visit.findMany({
      where: {
        checkInAt: { gte: fromDt.toJSDate(), lt: toExclusive.toJSDate() },
        checkOutAt: { not: null }, // ✅ ONLY closed visits count for payroll

        // ✅ NEW RULE: must be linked to a ScheduleShift
        scheduleShiftId: { not: null },

        // ✅ NEW RULE: and shift must be COMPLETED
        scheduleShift: {
          is: { status: ScheduleStatus.COMPLETED },
        },
      },
      select: {
        id: true,
        dspId: true,
        individualId: true,
        scheduleShiftId: true, // ✅ for debugging / auditing
        checkInAt: true,
        checkOutAt: true,
        durationMinutes: true,
      },
    });

    const rawByDsp = new Map<
      string,
      Array<{
        visitId: string;
        originalDspId: string;
        individualId: string | null;
        startMs: number;
        endMs: number;
        minutes: number;
      }>
    >();

    for (const v of visits) {
      if (!v.checkOutAt) continue;

      const start = DateTime.fromJSDate(v.checkInAt as any, { zone: TZ });
      const end = DateTime.fromJSDate(v.checkOutAt as any, { zone: TZ });

      if (!start.isValid || !end.isValid) continue;
      const startMs = start.toMillis();
      const endMs = end.toMillis();
      if (endMs <= startMs) continue;

      const minutes =
        typeof v.durationMinutes === 'number' &&
        Number.isFinite(v.durationMinutes)
          ? Math.max(0, Math.round(v.durationMinutes))
          : Math.max(0, Math.round((endMs - startMs) / 60000));

      if (minutes <= 0) continue;

      // ✅ Normalize dspId to techId (Employee.id)
      const canonicalTechId = dspAliasToTechId.get(v.dspId) || v.dspId;

      const arr = rawByDsp.get(canonicalTechId) || [];
      arr.push({
        visitId: v.id,
        originalDspId: v.dspId,
        individualId: v.individualId ?? null,
        startMs,
        endMs,
        minutes,
      });
      rawByDsp.set(canonicalTechId, arr);
    }

    const minutesByDsp = new Map<string, number>();
    const debugVisitsByDsp = new Map<
      string,
      Array<{
        visitId: string;
        originalDspId: string;
        checkInAt: string;
        checkOutAt: string;
        minutes: number;
        individualId: string | null;
      }>
    >();

    for (const [dspTechId, arr] of rawByDsp.entries()) {
      const seen = new Set<string>();
      const dedup: Interval[] = [];
      const dbg: Array<{
        visitId: string;
        originalDspId: string;
        checkInAt: string;
        checkOutAt: string;
        minutes: number;
        individualId: string | null;
      }> = [];

      for (const it of arr) {
        // ✅ Dedup by (techId + individual + interval)
        const key = `${dspTechId}|${it.individualId || ''}|${it.startMs}|${it.endMs}`;
        if (seen.has(key)) continue;
        seen.add(key);

        dedup.push({ startMs: it.startMs, endMs: it.endMs });

        dbg.push({
          visitId: it.visitId,
          originalDspId: it.originalDspId,
          checkInAt:
            DateTime.fromMillis(it.startMs, { zone: TZ }).toISO() || '',
          checkOutAt: DateTime.fromMillis(it.endMs, { zone: TZ }).toISO() || '',
          minutes: it.minutes,
          individualId: it.individualId,
        });
      }

      const merged = mergeIntervals(dedup);
      const totalMinutes = sumIntervalsMinutes(merged);

      minutesByDsp.set(dspTechId, totalMinutes);
      debugVisitsByDsp.set(dspTechId, dbg);
    }

    return { minutesByDsp, debugVisitsByDsp };
  }

  // -------------------------
// POST /payroll/generate
// -------------------------
async generate(from: string, to: string) {
  const { fromDt, toExclusive } = this.computePeriod(from, to);

  const employees = await this.prisma.employee.findMany({
    where: {
      status: 'Active', // ✅ ONLY Active employees appear in payroll
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: {
      id: true,
      employeeId: true,
      firstName: true,
      lastName: true,
      role: true,
      ssn: true,
      status: true,
    },
  });

    const rates = await this.prisma.payrollRate.findMany({
      select: {
        employeeId: true,
        rate: true,
        trainingRate: true,
        mileageRate: true,
      },
    });
    const rateMap = new Map(rates.map((r) => [r.employeeId, r]));

    // ✅ NEW: normalize Visit.dspId (legacy employeeId vs new techId)
    const dspAliasToTechId = await this.buildDspAliasToTechIdMap();

    const { minutesByDsp, debugVisitsByDsp } =
      await this.getVisitMinutesByEmployeeTechId(
        fromDt,
        toExclusive,
        dspAliasToTechId,
      );

    const officeApprovals = await this.prisma.officeWeeklyApproval.findMany({
      where: {
        weekStart: {
          gte: fromDt.toJSDate(),
          lt: toExclusive.toJSDate(),
        },
        status: 'APPROVED',
      },
      select: {
        staffId: true,
        computedMinutes: true,
        finalMinutes: true,
      },
    });

    const officeMinutesByStaffId = new Map<string, number>();
    for (const a of officeApprovals) {
      const mins =
        typeof a.finalMinutes === 'number' && a.finalMinutes >= 0
          ? a.finalMinutes
          : a.computedMinutes || 0;
      officeMinutesByStaffId.set(a.staffId, Math.max(0, Math.round(mins)));
    }

    const rows = employees.map((e) => {
      const staffId = e.employeeId;
      const staffName = `${e.firstName} ${e.lastName}`.trim();
      const staffType = inferStaffType(e.role);

      const rr = rateMap.get(staffId);
      const rate = clampNonNeg(rr?.rate ?? 0);

      const trainingRate =
        typeof rr?.trainingRate === 'number' && Number.isFinite(rr.trainingRate)
          ? rr.trainingRate
          : 10;

      const mileageRate =
        typeof rr?.mileageRate === 'number' && Number.isFinite(rr.mileageRate)
          ? rr.mileageRate
          : 0.3;

      const officeFinalMinutes = officeMinutesByStaffId.get(staffId) || 0;

      // ✅ Visit minutes keyed by Employee.id (tech) after normalization
      const visitMinutes = minutesByDsp.get(e.id) || 0;

      let minutes = 0;
      if (staffType === 'DSP') minutes = visitMinutes;
      else minutes = officeFinalMinutes + visitMinutes;

      const otMinutes = Math.max(0, minutes - 40 * 60);
      const regularMinutes = minutes - otMinutes;

      const hours = minutes / 60;
      const regularHours = regularMinutes / 60;
      const otHours = otMinutes / 60;

      const regularPay = regularHours * rate;
      const otPay = otHours * rate * 1.5;
      const totalPay = regularPay + otPay;

      if (staffId === 'BAC-E-2025-008') {
        const dbg = {
          periodFrom: fromDt.toISO(),
          periodToExclusive: toExclusive.toISO(),
          employeeId: staffId,
          employeeTechId: e.id,
          officeFinalMinutes,
          visitMinutes,
          visitCount: (debugVisitsByDsp.get(e.id) || []).length,
          visitHHmm: fmtHHmm(visitMinutes),
          officeHHmm: fmtHHmm(officeFinalMinutes),
          totalHHmm: fmtHHmm(officeFinalMinutes + visitMinutes),
          visitHours: Number((visitMinutes / 60).toFixed(2)),
          officeHours: Number((officeFinalMinutes / 60).toFixed(2)),
          totalHours: Number(
            ((officeFinalMinutes + visitMinutes) / 60).toFixed(2),
          ),
        };
        // eslint-disable-next-line no-console
        console.log('[PAYROLL DEBUG]', dbg);
        // eslint-disable-next-line no-console
        console.log('[PAYROLL DEBUG VISITS]', debugVisitsByDsp.get(e.id) || []);
      }

      return {
        staffId,
        staffName,
        staffType,
        employeeSSN: e.ssn ?? null,

        rate,
        trainingRate,
        mileageRate,

        hours: Number(hours.toFixed(2)),
        otHours: Number(otHours.toFixed(2)),
        regularPay: Number(regularPay.toFixed(2)),
        otPay: Number(otPay.toFixed(2)),
        totalPay: Number(totalPay.toFixed(2)),

        officeFinalMinutes,
        visitMinutes,
        totalMinutes: minutes,
        regularMinutes,
        otMinutes,
        officeHHmm: fmtHHmm(officeFinalMinutes),
        visitHHmm: fmtHHmm(visitMinutes),
        hoursHHmm: fmtHHmm(minutes),
        regularHHmm: fmtHHmm(regularMinutes),
        otHHmm: fmtHHmm(otMinutes),
      };
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.totalHours += r.hours;
        acc.totalOtHours += r.otHours;
        acc.totalPay += r.totalPay;
        return acc;
      },
      { totalHours: 0, totalOtHours: 0, totalPay: 0 },
    );

    const runId = `run_${fromDt.toFormat('yyyyLLdd')}_${toExclusive
      .minus({ days: 1 })
      .toFormat('yyyyLLdd')}_${DateTime.now().toMillis()}`;

    await this.prisma.payrollRun.create({
      data: {
        id: runId,
        periodFrom: from,
        periodTo: to,
        generatedAt: DateTime.now().setZone(TZ).toJSDate(),
        totalsTotalHours: totals.totalHours,
        totalsTotalOtHours: totals.totalOtHours,
        totalsTotalPay: totals.totalPay,
      },
    });

    for (const r of rows) {
      await this.prisma.payrollRow.create({
        data: {
          id: `row_${runId}_${r.staffId}`,
          runId,
          staffId: r.staffId,
          staffName: r.staffName,
          staffType: r.staffType,
          employeeSSN: r.employeeSSN,
          rate: r.rate,
          trainingRate: r.trainingRate,
          mileageRate: r.mileageRate,
          hours: r.hours,
          otHours: r.otHours,
          regularPay: r.regularPay,
          otPay: r.otPay,
          totalPay: r.totalPay,
        },
      });
    }

    return {
      id: runId,
      periodFrom: from,
      periodTo: to,
      generatedAt: DateTime.now().setZone(TZ).toISO(),
      totals: {
        totalHours: Number(totals.totalHours.toFixed(2)),
        totalOtHours: Number(totals.totalOtHours.toFixed(2)),
        totalPay: Number(totals.totalPay.toFixed(2)),
      },
      rows,
      exports: { docUrl: null, pdfUrl: null },
    };
  }

  // -------------------------
  // POST /payroll/export/doc
  // -------------------------
  async exportDoc(dto: PayrollExportDto, baseUrl: string) {
    await this.ensureExportsDir();

    const run = await this.prisma.payrollRun.findUnique({
      where: { id: dto.runId },
    });
    if (!run) throw new BadRequestException(`Run not found: ${dto.runId}`);

    const runRows = await this.prisma.payrollRow.findMany({
      where: { runId: dto.runId },
      orderBy: [{ staffName: 'asc' }],
    });

    const filtered = runRows.filter((r) => {
      if (dto.staffTypeFilter === 'ALL') return true;
      return r.staffType === dto.staffTypeFilter;
    });

    const weeklyExtras = dto.weeklyExtras || {};

    const computed = filtered.map((r) => {
      const ex0 = weeklyExtras[r.staffId] || {};
      const rate = clampNonNeg(r.rate);

      const trainingHours = clampNonNeg(ex0.trainingHours ?? 0);
      const sickHours = clampNonNeg(ex0.sickHours ?? 0);
      const holidayHours = clampNonNeg(ex0.holidayHours ?? 0);
      const ptoHours = clampNonNeg(ex0.ptoHours ?? 0);
      const mileage = clampNonNeg(ex0.mileage ?? 0);

      const trainingRate =
        typeof r.trainingRate === 'number' && Number.isFinite(r.trainingRate)
          ? r.trainingRate
          : 10;

      const mileageRate =
        typeof r.mileageRate === 'number' && Number.isFinite(r.mileageRate)
          ? r.mileageRate
          : 0.3;

      const trainingPay = trainingHours * trainingRate;
      const sickPay = sickHours * rate * 1.0;
      const holidayPay = holidayHours * rate * 2.0;
      const ptoPay = ptoHours * rate * 1.0;
      const mileagePay = mileage * mileageRate;

      const extrasPay =
        trainingPay + sickPay + holidayPay + ptoPay + mileagePay;
      const totalWithExtras = clampNonNeg(r.totalPay) + extrasPay;

      const totalMinutes = Math.max(0, Math.round((Number(r.hours) || 0) * 60));
      const otMinutes = Math.max(0, Math.round((Number(r.otHours) || 0) * 60));

      return {
        r: {
          ...r,
          hoursHHmm: fmtHHmm(totalMinutes),
          otHHmm: fmtHHmm(otMinutes),
        },
        ex: {
          trainingHours,
          sickHours,
          holidayHours,
          ptoHours,
          mileage,
          extrasPay,
          totalWithExtras,
        },
      };
    });

    const generatedAt = run.generatedAt
      ? DateTime.fromJSDate(run.generatedAt as any, { zone: TZ })
      : DateTime.now().setZone(TZ);

    // ✅ Format period like image #2 (MM/dd/yyyy)
    const periodFrom = DateTime.fromISO(dto.periodFrom, { zone: TZ }).toFormat(
      'LL/dd/yyyy',
    );
    const periodTo = DateTime.fromISO(dto.periodTo, { zone: TZ }).toFormat(
      'LL/dd/yyyy',
    );

    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { orientation: 'landscape' }, // ✅ match image #2
              margin: { top: 720, right: 720, bottom: 720, left: 720 },
            },
          },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: COMPANY_NAME,
                  bold: true,
                  size: 34,
                  color: COMPANY_NAME_COLOR,
                }),
              ],
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: COMPANY_ADDRESS, size: 22 })],
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: `Phone: ${COMPANY_PHONE}`, size: 22 }),
              ],
            }),
            new Paragraph({ text: '' }),

            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: 'Payroll ', bold: true, size: 28 }),
                new TextRun({
                  text: 'Export',
                  bold: true,
                  size: 28,
                  underline: {},
                }),
                new TextRun({ text: ' : ', bold: true, size: 28 }),
                new TextRun({
                  text: `Period:  ${periodFrom} - ${periodTo}`,
                  size: 28,
                }),
              ],
            }),

            new Paragraph({ text: '' }),

            this.buildTable(computed),

            new Paragraph({ text: '' }),

            this.buildFooterApprovalLikeImage2(generatedAt),
          ],
        },
      ],
    });

    const buf = await Packer.toBuffer(doc);

    const stamp = generatedAt.toFormat('yyyyLLdd_HHmmss');
    const fileName = `payroll_${dto.periodFrom}_${dto.periodTo}_${dto.staffTypeFilter}_${stamp}.docx`;
    const filePath = path.join(this.exportsDir(), fileName);

    await fs.writeFile(filePath, buf);

    return `${baseUrl}/exports/${fileName}`;
  }

  // =====================================================
  // OLD header/footer methods (kept, not removed)
  // =====================================================
  private buildCompanyHeader(logoBuf: Buffer | null) {
    const logoCell = new TableCell({
      verticalAlign: VerticalAlign.CENTER,
      width: { size: 18, type: WidthType.PERCENTAGE },
      children: [
        ...(logoBuf
          ? [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new ImageRun({
                    data: logoBuf,
                    transformation: { width: 160, height: 55 },
                    type: detectImageType(logoBuf),
                  }),
                ],
              }),
            ]
          : [
              new Paragraph({
                children: [new TextRun({ text: '', size: 1 })],
              }),
            ]),
      ],
    });

    const infoCell = new TableCell({
      verticalAlign: VerticalAlign.CENTER,
      width: { size: 82, type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [
            new TextRun({
              text: COMPANY_NAME,
              bold: true,
              size: 28,
              color: COMPANY_NAME_COLOR,
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: COMPANY_ADDRESS, size: 20 })],
        }),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [
            new TextRun({ text: `Phone: ${COMPANY_PHONE}`, size: 20 }),
          ],
        }),
      ],
    });

    const t = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [logoCell, infoCell],
        }),
      ],
    });

    return this.noBorderTable(t);
  }

  private buildFooterApproval(generatedAt: DateTime) {
    const preparedText = `Prepared Date: ${generatedAt.toFormat('yyyy-LL-dd')}`;
    const approvedText = `Approved by: HR Department (Signed)`;

    const leftCell = new TableCell({
      verticalAlign: VerticalAlign.CENTER,
      width: { size: 50, type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: preparedText, size: 20 })],
        }),
      ],
    });

    const rightCell = new TableCell({
      verticalAlign: VerticalAlign.CENTER,
      width: { size: 50, type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: approvedText, size: 20 })],
        }),
      ],
    });

    const t = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [leftCell, rightCell],
        }),
      ],
    });

    return this.noBorderTable(t);
  }

  // =====================================================
  // NEW footer like image #2
  // =====================================================
  private buildFooterApprovalLikeImage2(generatedAt: DateTime) {
    const dateText = `Date: ${generatedAt.toFormat('LL/dd/yyyy')}`;

    const noBorders = {
      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    };

    const mkP = (text: string, bold = false, italics = false) =>
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold, italics, size: 22 })],
      });

    const leftCell = new TableCell({
      width: { size: 50, type: WidthType.PERCENTAGE },
      verticalAlign: VerticalAlign.CENTER,
      borders: noBorders,
      children: [
        mkP(dateText, true),
        mkP('', false),
        mkP('Approved by:', true),
        mkP('CEO', true),
        mkP('(Signed)', false, true),
        mkP('', false),
        mkP('Van Duong Chau', true),
      ],
    });

    const rightCell = new TableCell({
      width: { size: 50, type: WidthType.PERCENTAGE },
      verticalAlign: VerticalAlign.CENTER,
      borders: noBorders,
      children: [
        mkP(dateText, true),
        mkP('', false),
        mkP('Reviewed by:', true),
        mkP('HR Department', true),
        mkP('(Signed)', false, true),
        mkP('', false),
        mkP('Chanh Trung Nguyen', true),
      ],
    });

    const t = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [leftCell, rightCell],
        }),
      ],
    });

    return this.noBorderTable(t);
  }

  // =====================================================
  // TABLE formatting (header shading + wrap headers + align rules)
  // =====================================================
  private headerRuns(label: string) {
    const parts = (label || '').split('\n');
    const runs: TextRun[] = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      if (i === 0) {
        runs.push(new TextRun({ text, bold: true, size: 18 }));
      } else {
        runs.push(new TextRun({ text, bold: true, size: 18, break: 1 }));
      }
    }
    return runs;
  }

  private buildTable(items: Array<{ r: any; ex: any }>) {
    const headers = [
      'No.',
      'Employee',
      'SSN#',
      'Type',
      'Rate',
      'Hours\n(HH:mm)',
      'OT\n(HH:mm)',
      'Training\nhour',
      'Sick\nhour',
      'Holiday\nhour',
      'PTO\nhour',
      'Mileage',
      'Regular\nPay',
      'OT\nPay',
      'Extras',
      'Total',
    ];

    const colWidthsPct = [
      4, // No.
      12, // Employee
      7, // SSN#
      5, // Type
      5, // Rate
      5, // Hours
      5, // OT
      5, // Training
      5, // Sick
      5, // Holiday
      5, // PTO
      5, // Mileage
      6, // Regular Pay
      5, // OT Pay
      5, // Extras
      7, // Total
    ];

    const headerFill = 'C6E0B4';

    const headerRow = new TableRow({
      tableHeader: true,
      children: headers.map((h, idx) => {
        const w = colWidthsPct[idx] ?? 6;
        return new TableCell({
          verticalAlign: VerticalAlign.CENTER,
          width: { size: w, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: headerFill },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: this.headerRuns(h),
            }),
          ],
        });
      }),
    });

    const isCenterCol = (colIndex: number) =>
      colIndex === 0 || colIndex === 2 || colIndex === 3;

    const bodyRows = items.map(({ r, ex }, i) => {
      const hoursHM =
        (r.hoursHHmm ?? '').toString().trim() ||
        fmtHHmm(Math.round((Number(r.hours) || 0) * 60));
      const otHM =
        (r.otHHmm ?? '').toString().trim() ||
        fmtHHmm(Math.round((Number(r.otHours) || 0) * 60));

      const cells = [
        String(i + 1),
        safeText(r.staffName),
        safeText(r.employeeSSN),
        safeText(r.staffType),
        money(r.rate),
        safeText(hoursHM),
        safeText(otHM),
        num2(ex.trainingHours),
        num2(ex.sickHours),
        num2(ex.holidayHours),
        num2(ex.ptoHours),
        num2(ex.mileage),
        money(r.regularPay),
        money(r.otPay),
        money(ex.extrasPay),
        money(ex.totalWithExtras),
      ];

      return new TableRow({
        children: cells.map((c, idx) => {
          const w = colWidthsPct[idx] ?? 6;

          let align: (typeof AlignmentType)[keyof typeof AlignmentType] =
            AlignmentType.RIGHT;
          if (isCenterCol(idx)) align = AlignmentType.CENTER;
          if (idx === 1) align = AlignmentType.LEFT; // Employee body left

          const isTotalCol = idx === cells.length - 1;

          return new TableCell({
            verticalAlign: VerticalAlign.CENTER,
            width: { size: w, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                alignment: align,
                children: [
                  new TextRun({ text: c, size: 18, bold: isTotalCol }),
                ],
              }),
            ],
          });
        }),
      });
    });

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow, ...bodyRows],
    });
  }
}
