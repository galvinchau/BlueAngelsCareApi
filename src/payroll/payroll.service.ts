// src/payroll/payroll.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DateTime } from 'luxon';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import { PrismaService } from '../prisma/prisma.service';
import type { PayrollExportDto } from './dto/payroll-export.dto';

const TZ = 'America/New_York';

// =========================
// Company header (customize via ENV)
// =========================
const COMPANY_NAME =
  process.env.PAYROLL_COMPANY_NAME || 'Blue Angels Care, LLC';
const COMPANY_ADDRESS =
  process.env.PAYROLL_COMPANY_ADDRESS || '202 Campbell Ave, Altoona, PA 16602';
const COMPANY_PHONE = process.env.PAYROLL_COMPANY_PHONE || '(814) 600-2313';

// Optional: absolute or relative path to a logo file (png/jpg)
// Example: PAYROLL_COMPANY_LOGO_PATH=uploads/assets/logo.png
const COMPANY_LOGO_PATH = (process.env.PAYROLL_COMPANY_LOGO_PATH || '')
  .toString()
  .trim();

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

// ✅ NEW: detect png/jpg from buffer (docx ImageRun requires "type")
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
    // docx Table borders are configured at TableCell/Row or global style;
    // easiest: rely on default and keep content compact.
    // (We already keep header tables minimal. If you want strict no-border,
    // we can add style or set borders per cell later.)
    return table;
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

    // These rows exist now (SQL created). Prisma client will work after prisma generate.
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
  // POST /payroll/generate
  // -------------------------
  async generate(from: string, to: string) {
    const fromDt = DateTime.fromISO(from, { zone: TZ }).startOf('day');
    const toDt = DateTime.fromISO(to, { zone: TZ }).endOf('day');

    if (!fromDt.isValid || !toDt.isValid) {
      throw new BadRequestException('Invalid period');
    }
    if (toDt < fromDt) {
      throw new BadRequestException('Invalid period: to < from');
    }

    const employees = await this.prisma.employee.findMany({
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true, // technical id (Visit.dspId)
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

    // DSP visits
    const dspVisits = await this.prisma.visit.findMany({
      where: {
        checkInAt: { gte: fromDt.toJSDate(), lte: toDt.toJSDate() },
        checkOutAt: { not: null },
      },
      select: {
        dspId: true,
        durationMinutes: true,
        checkInAt: true,
        checkOutAt: true,
      },
    });

    const dspMinutesByEmpId = new Map<string, number>();
    for (const v of dspVisits) {
      const minutes =
        typeof v.durationMinutes === 'number' &&
        Number.isFinite(v.durationMinutes)
          ? v.durationMinutes
          : Math.max(
              0,
              Math.round(
                (DateTime.fromJSDate(v.checkOutAt as Date, {
                  zone: TZ,
                }).toMillis() -
                  DateTime.fromJSDate(v.checkInAt as Date, {
                    zone: TZ,
                  }).toMillis()) /
                  60000,
              ),
            );

      dspMinutesByEmpId.set(
        v.dspId,
        (dspMinutesByEmpId.get(v.dspId) || 0) + minutes,
      );
    }

    // Office weekly approval:
    // We match by weekStart/weekEnd exact boundaries based on input dates.
    const officeApprovals = await this.prisma.officeWeeklyApproval.findMany({
      where: {
        weekStart: {
          gte: fromDt.toJSDate(),
          lte: fromDt.plus({ hours: 6 }).toJSDate(),
        },
        weekEnd: {
          gte: toDt.minus({ hours: 6 }).toJSDate(),
          lte: toDt.toJSDate(),
        },
        status: 'APPROVED',
      },
      select: {
        staffId: true, // employeeId
        computedMinutes: true,
        finalMinutes: true,
      },
    });

    const officeMinutesByStaffId = new Map<string, number>();
    for (const a of officeApprovals) {
      const mins =
        typeof a.finalMinutes === 'number' && a.finalMinutes > 0
          ? a.finalMinutes
          : a.computedMinutes || 0;
      officeMinutesByStaffId.set(a.staffId, mins);
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

      let minutes = 0;
      if (staffType === 'DSP') {
        minutes = dspMinutesByEmpId.get(e.id) || 0;
      } else {
        minutes = officeMinutesByStaffId.get(staffId) || 0;
      }

      const hours = minutes / 60;
      const regularHours = Math.min(40, hours);
      const otHours = Math.max(0, hours - 40);

      const regularPay = regularHours * rate;
      const otPay = otHours * rate * 1.5;
      const totalPay = regularPay + otPay;

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

    // Create run
    const runId = `run_${from}_${to}_${DateTime.now().toMillis()}`;

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

      return {
        r,
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

    // ✅ Use run.generatedAt for "Prepared Date"
    const generatedAt = run.generatedAt
      ? DateTime.fromJSDate(run.generatedAt as any, { zone: TZ })
      : DateTime.now().setZone(TZ);

    const headerLine = `Period: ${dto.periodFrom} → ${dto.periodTo}    |    Generated At: ${generatedAt.toFormat(
      'yyyy-LL-dd HH:mm',
    )} (${TZ})`;

    // Optional logo
    const logoBuf = await this.tryLoadLogoBuffer();

    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { orientation: 'landscape' },
              margin: { top: 720, right: 720, bottom: 720, left: 720 },
            },
          },
          children: [
            // =========================
            // Company Header Block
            // =========================
            this.buildCompanyHeader(logoBuf),

            // Title
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: 'Payroll Export (Details)',
                  bold: true,
                  size: 30,
                }),
              ],
            }),

            // Period line
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: headerLine, size: 20 })],
            }),

            new Paragraph({ text: '' }),

            // Main table
            this.buildTable(computed),

            new Paragraph({ text: '' }),

            // =========================
            // Footer / Approval
            // =========================
            this.buildFooterApproval(generatedAt),
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

  private buildCompanyHeader(logoBuf: Buffer | null) {
    // Two-column header table (logo | company info)
    const logoCell = new TableCell({
      width: { size: 18, type: WidthType.PERCENTAGE },
      children: [
        ...(logoBuf
          ? [
              new Paragraph({
                children: [
                  new ImageRun({
                    data: logoBuf,
                    transformation: { width: 140, height: 50 },
                    // ✅ FIX TS2345: docx ImageRun requires "type"
                    type: detectImageType(logoBuf),
                  }),
                ],
              }),
            ]
          : [
              new Paragraph({
                children: [
                  new TextRun({
                    text: '',
                    size: 1,
                  }),
                ],
              }),
            ]),
      ],
    });

    const infoCell = new TableCell({
      width: { size: 82, type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: COMPANY_NAME, bold: true, size: 28 })],
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
      width: { size: 50, type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: preparedText, size: 20 })],
        }),
      ],
    });

    const rightCell = new TableCell({
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

  private buildTable(items: Array<{ r: any; ex: any }>) {
    // ✅ Add "No." column first
    const headers = [
      'No.',
      'Employee',
      'SSN#',
      'Type',
      'Rate',
      'Hours',
      'OT Hours',
      'Training hour',
      'Sick hour',
      'Holiday hour',
      'PTO hour',
      'Mileage',
      'Regular Pay',
      'OT Pay',
      'Extras Pay',
      'Total',
    ];

    // Column width plan (percentage)
    // Make Employee wider, No small, numeric columns compact
    const colWidthsPct = [
      4, // No.
      18, // Employee
      8, // SSN#
      6, // Type
      7, // Rate
      6, // Hours
      7, // OT Hours
      7, // Training
      6, // Sick
      7, // Holiday
      6, // PTO
      6, // Mileage
      8, // Regular Pay
      7, // OT Pay
      7, // Extras Pay
      8, // Total
    ];

    const headerRow = new TableRow({
      tableHeader: true, // ✅ Repeat header on each page
      children: headers.map((h, idx) => {
        const w = colWidthsPct[idx] ?? 6;
        return new TableCell({
          width: { size: w, type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [new TextRun({ text: h, bold: true, size: 18 })],
            }),
          ],
        });
      }),
    });

    const bodyRows = items.map(({ r, ex }, i) => {
      const cells = [
        String(i + 1), // ✅ No.
        safeText(r.staffName),
        safeText(r.employeeSSN),
        safeText(r.staffType),
        money(r.rate),
        num2(r.hours),
        num2(r.otHours),
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
          return new TableCell({
            width: { size: w, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [new TextRun({ text: c, size: 18 })],
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
