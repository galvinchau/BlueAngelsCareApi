// ======================================================
//  src/mobile/mobile.service.ts
//  - Timezone: America/New_York (Altoona, PA)
//  - Save Daily Note into DailyNote table
//  - Compute template fields (TotalH/Units/Lost/Over/Under) at submit time
//  - Google Drive export is gated by env ENABLE_GOOGLE_REPORTS=1
// ======================================================

import { Injectable } from '@nestjs/common';
import {
  ScheduleStatus,
  VisitSource,
  type Individual,
  type ScheduleShift,
  type Service,
  type Visit,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleReportsService } from '../reports/google-reports.service';

/**
 * Mobile shift status
 */
export type ShiftStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

/**
 * ✅ Mobile Individual Lite DTO (for Clients screen)
 * NOTE: Schema currently doesn't expose Medicaid field in Individual, so maNumber is null for now.
 */
export interface MobileIndividualLite {
  id: string;
  fullName: string;
  maNumber?: string | null;
  address1?: string | null;
  address2?: string | null;
  phone?: string | null;
}

/**
 * Mobile shift DTO
 */
export interface MobileShift {
  id: string;
  date: string;
  individualId: string;
  individualName: string;
  individualDob: string;
  individualMa: string;
  individualAddress: string;
  serviceCode: string;
  serviceName: string;
  location: string;
  scheduleStart: string;
  scheduleEnd: string;
  status: ShiftStatus;
  visitStart?: string | null;
  visitEnd?: string | null;
  outcomeText?: string | null;
}

/**
 * Payload from mobile
 */
export interface MobileDailyNotePayload {
  shiftId: string;
  staffId: string;
  individualId: string;

  date: string; // YYYY-MM-DD

  individualName: string;
  individualDob?: string;
  individualMa?: string;
  individualAddress?: string;

  serviceCode: string;
  serviceName: string;
  scheduleStart: string; // "HH:mm"
  scheduleEnd: string; // "HH:mm"
  outcomeText?: string;

  visitStart?: string; // "HH:mm"
  visitEnd?: string; // "HH:mm"

  todayPlan?: string;
  whatWeWorkedOn?: string;
  opportunities?: string;
  notes?: string;

  meals?: {
    breakfast?: { time?: string; had?: string; offered?: string };
    lunch?: { time?: string; had?: string; offered?: string };
    dinner?: { time?: string; had?: string; offered?: string };
  };

  healthNotes?: string;
  incidentNotes?: string;

  staffName?: string;
  staffEmail?: string;

  mileage?: number;

  // NEW (mobile already sends these at runtime)
  isCanceled?: boolean;
  cancelReason?: string;

  // Signatures are included in payload JSON (file reports service reads these)
  dspSignature?: string;
  individualSignature?: string;

  // Optional (if you want to store/compute)
  overReason?: string;
}

export type CheckMode = 'IN' | 'OUT';

export interface CheckInOutResponse {
  status: 'OK';
  mode: CheckMode;
  shiftId: string;
  staffId: string;
  time: string;
  timesheetId: string;
}

const TZ = 'America/New_York';

/**
 * IMPORTANT:
 * Never use JS Date.getHours()/getMinutes() because it depends on server timezone.
 * Always format using Luxon with explicit time zone (America/New_York).
 */
function formatTimeHHmmInTZ(dt: Date | null | undefined): string | null {
  if (!dt) return null;
  return DateTime.fromJSDate(dt, { zone: 'utc' }).setZone(TZ).toFormat('HH:mm');
}

/**
 * Parse "HH:mm" into minutes from 00:00.
 */
function hhmmToMinutes(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

/**
 * Compute duration minutes with overnight support.
 */
function computeDurationMinutes(
  startHHmm?: string | null,
  endHHmm?: string | null,
): number | null {
  const s = hhmmToMinutes(startHHmm);
  const e = hhmmToMinutes(endHHmm);
  if (s === null || e === null) return null;
  let diff = e - s;
  if (diff < 0) diff += 1440; // overnight
  return diff;
}

/**
 * Convert minutes to hours string (2 decimals).
 */
function minutesToHoursStr(mins: number): string {
  const hrs = mins / 60;
  return hrs.toFixed(2);
}

/**
 * Convert minutes to 15-min units (ceil).
 */
function minutesToUnits(mins: number): number {
  return Math.ceil(mins / 15);
}

/**
 * Helper: format address (full line used in shifts)
 */
function formatAddress(ind: Individual): string {
  const parts = [
    ind.address1 ?? '',
    ind.city ?? '',
    ind.state ?? '',
    ind.zip ?? '',
  ]
    .map((p) => p?.trim())
    .filter((p) => !!p);

  return parts.join(', ');
}

/**
 * ✅ Helper: for Clients screen (address1 + address2)
 */
function formatAddressLines(ind: Individual): {
  address1: string | null;
  address2: string | null;
} {
  const a1 = (ind.address1 ?? '').trim();
  const city = (ind.city ?? '').trim();
  const state = (ind.state ?? '').trim();
  const zip = (ind.zip ?? '').trim();

  const a2Parts = [city, state].filter(Boolean);
  let a2 = a2Parts.join(', ');
  if (zip) a2 = a2 ? `${a2} ${zip}` : zip;

  return {
    address1: a1 || null,
    address2: a2 || null,
  };
}

/**
 * ✅ Helper: normalize query
 */
function normalizeQ(q: string): string {
  return String(q || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Helper: map ScheduleShift -> MobileShift
 */
function mapShiftToMobileShift(params: {
  shift: ScheduleShift & {
    individual: Individual;
    service: Service;
    visits: Visit[];
  };
  staffId: string;
  date: string; // YYYY-MM-DD (America/New_York)
}): MobileShift {
  const { shift, staffId, date } = params;
  const individual = shift.individual;
  const service = shift.service;
  const visits = shift.visits ?? [];

  // Status
  let status: ShiftStatus = 'NOT_STARTED';
  switch (shift.status) {
    case ScheduleStatus.IN_PROGRESS:
      status = 'IN_PROGRESS';
      break;
    case ScheduleStatus.COMPLETED:
    case ScheduleStatus.NOT_COMPLETED:
      status = 'COMPLETED';
      break;
  }

  // Visits for DSP on the same local day (America/New_York)
  const visitsForDsp = visits.filter((v) => {
    if (v.dspId !== staffId || !v.checkInAt) return false;
    const localDateStr = DateTime.fromJSDate(v.checkInAt)
      .setZone(TZ)
      .toISODate();
    return localDateStr === date;
  });

  let visitStart: string | null = null;
  let visitEnd: string | null = null;

  if (visitsForDsp.length > 0) {
    const sorted = [...visitsForDsp].sort((a, b) =>
      a.checkInAt < b.checkInAt ? -1 : 1,
    );
    const earliest = sorted[0];

    const latest = visitsForDsp.reduce((max, v) => {
      const vEnd = v.checkOutAt ?? v.checkInAt;
      const maxEnd = max.checkOutAt ?? max.checkInAt;
      return vEnd > maxEnd ? v : max;
    });

    // Format times in America/New_York (stable on any server timezone)
    visitStart = formatTimeHHmmInTZ(earliest.checkInAt);
    visitEnd = formatTimeHHmmInTZ(latest.checkOutAt ?? latest.checkInAt);

    if (visitsForDsp.some((v) => !v.checkOutAt)) status = 'IN_PROGRESS';
    else status = 'COMPLETED';
  }

  // Planned start/end format in America/New_York
  const scheduleStart = formatTimeHHmmInTZ(shift.plannedStart) ?? '';
  const scheduleEnd = formatTimeHHmmInTZ(shift.plannedEnd) ?? '';

  return {
    id: shift.id,
    date,
    individualId: individual.id,
    individualName: `${individual.firstName} ${individual.lastName}`.trim(),
    individualDob: individual.dob ?? '',
    individualMa: '', // (optional: later map from Payer/memberId if you want)
    individualAddress: formatAddress(individual),
    serviceCode: service.serviceCode,
    serviceName: service.serviceName,
    location: individual.location ?? '',
    scheduleStart,
    scheduleEnd,
    status,
    visitStart,
    visitEnd,
    outcomeText: null,
  };
}

@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportsService: GoogleReportsService,
  ) {}

  // =====================================================
  // ✅ NEW: Search Individuals for mobile Clients screen
  // =====================================================
  async searchIndividuals(search: string): Promise<MobileIndividualLite[]> {
    const q = normalizeQ(search);
    if (!q) return [];

    const tokens = q.split(' ').filter(Boolean);

    // Name matching:
    // - 1 token: firstName OR lastName contains token
    // - 2+ tokens: AND across tokens, each token can match firstName OR lastName (order independent)
    const nameWhere =
      tokens.length >= 2
        ? {
            AND: tokens.slice(0, 3).map((t) => ({
              OR: [
                { firstName: { contains: t, mode: 'insensitive' as const } },
                { lastName: { contains: t, mode: 'insensitive' as const } },
              ],
            })),
          }
        : {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' as const } },
              { lastName: { contains: q, mode: 'insensitive' as const } },
            ],
          };

    const rows = await this.prisma.individual.findMany({
      where: {
        OR: [
          // ID exact/contains
          { id: { equals: q } },
          { id: { contains: q } },

          // Name logic
          nameWhere,
        ],
      },
      take: 25,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        address1: true,
        city: true,
        state: true,
        zip: true,
        // NOTE: Do NOT select non-existing fields to avoid Prisma/TS errors.
      },
    });

    return rows.map((ind) => {
      const fullName = `${ind.firstName ?? ''} ${ind.lastName ?? ''}`.trim();
      const addr = formatAddressLines(ind as unknown as Individual);

      return {
        id: ind.id,
        fullName,
        maNumber: null, // ✅ will map when schema has Medicaid field
        address1: addr.address1,
        address2: addr.address2,
        phone: null, // ✅ will map when schema has phone field
      };
    });
  }

  // =====================================================
  // Today shifts for mobile
  // =====================================================
  async getTodayShifts(
    staffId: string,
    date: string,
  ): Promise<{ shifts: MobileShift[] }> {
    const dayStartLocal = DateTime.fromISO(date, { zone: TZ })
      .startOf('day')
      .toJSDate();
    const dayEndLocal = DateTime.fromISO(date, { zone: TZ })
      .endOf('day')
      .toJSDate();

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        scheduleDate: { gte: dayStartLocal, lte: dayEndLocal },
        OR: [{ plannedDspId: staffId }, { actualDspId: staffId }],
      },
      include: {
        individual: true,
        service: true,
        visits: {
          where: {
            dspId: staffId,
            checkInAt: { gte: dayStartLocal, lte: dayEndLocal },
          },
          orderBy: { checkInAt: 'asc' },
        },
      },
      orderBy: { plannedStart: 'asc' },
    });

    return {
      shifts: shifts.map((s) =>
        mapShiftToMobileShift({ shift: s, staffId, date }),
      ),
    };
  }

  // =====================================================
  // Save Daily Note from mobile
  // =====================================================
  async submitDailyNote(payload: MobileDailyNotePayload) {
    const {
      shiftId,
      staffId,
      individualId,
      date,
      serviceCode,
      scheduleStart,
      scheduleEnd,
      visitStart,
      visitEnd,
      staffName,
      mileage,
    } = payload;

    const serviceDate = DateTime.fromISO(date, { zone: TZ })
      .startOf('day')
      .toJSDate();

    const visit = await this.prisma.visit.findFirst({
      where: { scheduleShiftId: shiftId, dspId: staffId },
      orderBy: { checkInAt: 'asc' },
    });

    const service = await this.prisma.service.findFirst({
      where: { serviceCode },
      select: { id: true },
    });

    // =====================================================
    // Compute template fields for DOCX/PDF autofill
    // =====================================================
    const plannedMins = computeDurationMinutes(scheduleStart, scheduleEnd);
    const visitedMins = computeDurationMinutes(
      visitStart ?? null,
      visitEnd ?? null,
    );

    const totalH = visitedMins !== null ? minutesToHoursStr(visitedMins) : '';
    const billableUnits =
      visitedMins !== null ? String(minutesToUnits(visitedMins)) : '';

    const lostMinutes =
      plannedMins !== null && visitedMins !== null && visitedMins < plannedMins
        ? plannedMins - visitedMins
        : 0;

    const overMinutes =
      plannedMins !== null && visitedMins !== null && visitedMins > plannedMins
        ? visitedMins - plannedMins
        : 0;

    const underHours = lostMinutes > 0 ? minutesToHoursStr(lostMinutes) : '';

    const overHours = overMinutes > 0 ? minutesToHoursStr(overMinutes) : '';

    const computedPayload: any = {
      ...payload,
      totalH,
      billableUnits,
      lostMinutes: lostMinutes > 0 ? String(lostMinutes) : '',
      lostUnits: lostMinutes > 0 ? String(minutesToUnits(lostMinutes)) : '',
      underHours,
      overHours,
    };

    const isCanceled = payload.isCanceled === true;
    const cancelReason = isCanceled
      ? String(payload.cancelReason ?? '').trim()
      : null;

    // 1) Save DailyNote
    const record = await this.prisma.dailyNote.create({
      data: {
        shiftId,
        individualId,
        staffId,
        serviceId: service?.id ?? null,
        visitId: visit?.id ?? null,
        date: serviceDate,

        individualName: payload.individualName,
        staffName: staffName ?? null,
        serviceCode,
        serviceName: payload.serviceName,
        scheduleStart,
        scheduleEnd,
        visitStart: visitStart ?? null,
        visitEnd: visitEnd ?? null,

        mileage: typeof mileage === 'number' ? mileage : null,

        // ✅ FIX: respect cancel from mobile
        isCanceled,
        cancelReason,

        // ✅ Save full payload (includes computed fields + meals + signatures)
        payload: computedPayload as unknown as object,

        // legacy fields
        staffReportFileId: null,
        individualReportFileId: null,
      } as any,
    });

    // 2) Google export
    const enableGoogle = process.env.ENABLE_GOOGLE_REPORTS === '1';
    if (enableGoogle) {
      try {
        const { staff, individual } =
          await this.reportsService.generateDailyNoteDocs(
            record.id,
            computedPayload,
          );

        // Save BOTH doc+pdf IDs so Web Reports can show links
        await this.prisma.dailyNote.update({
          where: { id: record.id },
          data: {
            // legacy fields (keep for compatibility; prefer pdf)
            staffReportFileId: staff?.pdfId ?? staff?.docId ?? null,
            individualReportFileId:
              individual?.pdfId ?? individual?.docId ?? null,
          } as any,
        });
      } catch (err) {
        console.error(
          '[MobileService] Failed to generate Google Docs/PDF',
          err,
        );
      }
    }

    return { status: 'OK', id: record.id };
  }

  // =====================================================
  // Check-in
  // =====================================================
  async checkInShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): Promise<CheckInOutResponse> {
    const checkInAt = clientTime
      ? DateTime.fromISO(clientTime, { setZone: true }).setZone(TZ).toJSDate()
      : DateTime.now().setZone(TZ).toJSDate();

    const shift = await this.prisma.scheduleShift.findUnique({
      where: { id: shiftId },
      select: {
        id: true,
        individualId: true,
        serviceId: true,
        actualDspId: true,
      },
    });

    const visit = await this.prisma.visit.create({
      data: {
        scheduleShiftId: shiftId,
        individualId: shift?.individualId ?? '',
        dspId: staffId,
        serviceId: shift?.serviceId ?? null,
        checkInAt,
        source: VisitSource.MOBILE,
      },
    });

    if (shift) {
      await this.prisma.scheduleShift.update({
        where: { id: shiftId },
        data: {
          status: ScheduleStatus.IN_PROGRESS,
          actualDspId: shift.actualDspId ?? staffId,
        },
      });
    }

    return {
      status: 'OK',
      mode: 'IN',
      shiftId,
      staffId,
      time: checkInAt.toISOString(),
      timesheetId: visit.id,
    };
  }

  // =====================================================
  // Check-out
  // =====================================================
  async checkOutShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): Promise<CheckInOutResponse> {
    const checkOutAt = clientTime
      ? DateTime.fromISO(clientTime, { setZone: true }).setZone(TZ).toJSDate()
      : DateTime.now().setZone(TZ).toJSDate();

    const shift = await this.prisma.scheduleShift.findUnique({
      where: { id: shiftId },
      select: {
        id: true,
        individualId: true,
        serviceId: true,
        actualDspId: true,
      },
    });

    let visit = await this.prisma.visit.findFirst({
      where: { scheduleShiftId: shiftId, dspId: staffId, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
    });

    if (visit) {
      visit = await this.prisma.visit.update({
        where: { id: visit.id },
        data: { checkOutAt },
      });
    } else {
      visit = await this.prisma.visit.create({
        data: {
          scheduleShiftId: shiftId,
          individualId: shift?.individualId ?? '',
          dspId: staffId,
          serviceId: shift?.serviceId ?? null,
          checkInAt: checkOutAt,
          checkOutAt,
          source: VisitSource.MOBILE,
        },
      });
    }

    await this.prisma.scheduleShift.update({
      where: { id: shiftId },
      data: {
        status: ScheduleStatus.COMPLETED,
        actualDspId: shift?.actualDspId ?? staffId,
      },
    });

    return {
      status: 'OK',
      mode: 'OUT',
      shiftId,
      staffId,
      time: checkOutAt.toISOString(),
      timesheetId: visit.id,
    };
  }
}
