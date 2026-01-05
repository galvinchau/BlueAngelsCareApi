// ======================================================
//  src/mobile/mobile.service.ts
//  - Timezone: America/New_York (Altoona, PA)
//  - Save Daily Note into DailyNote table
//  - Compute template fields (TotalH/Units/Lost/Over/Under) at submit time
//  - Google Drive export is gated by env ENABLE_GOOGLE_REPORTS=1
// ======================================================

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

// Prisma error types (runtime)
import { Prisma } from '@prisma/client';

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
    individualMa: '',
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

/**
 * ✅ NEW Helper: map ScheduleShift -> MobileShift for Client Detail
 */
function mapShiftToMobileShiftForClientDetail(params: {
  shift: ScheduleShift & {
    individual: Individual;
    service: Service;
    visits: Visit[];
  };
  date: string; // YYYY-MM-DD (America/New_York)
  staffId?: string;
}): MobileShift {
  const { shift, date, staffId } = params;
  const individual = shift.individual;
  const service = shift.service;
  const visits = shift.visits ?? [];

  // Base status from shift
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

  const visitsFiltered = staffId
    ? visits.filter((v) => v.dspId === staffId)
    : visits;

  const visitsSameDay = visitsFiltered.filter((v) => {
    if (!v.checkInAt) return false;
    const localDateStr = DateTime.fromJSDate(v.checkInAt)
      .setZone(TZ)
      .toISODate();
    return localDateStr === date;
  });

  let visitStart: string | null = null;
  let visitEnd: string | null = null;

  if (visitsSameDay.length > 0) {
    const sorted = [...visitsSameDay].sort((a, b) =>
      a.checkInAt < b.checkInAt ? -1 : 1,
    );
    const earliest = sorted[0];

    const latest = visitsSameDay.reduce((max, v) => {
      const vEnd = v.checkOutAt ?? v.checkInAt;
      const maxEnd = max.checkOutAt ?? max.checkInAt;
      return vEnd > maxEnd ? v : max;
    });

    visitStart = formatTimeHHmmInTZ(earliest.checkInAt);
    visitEnd = formatTimeHHmmInTZ(latest.checkOutAt ?? latest.checkInAt);

    if (visitsSameDay.some((v) => !v.checkOutAt)) status = 'IN_PROGRESS';
    else status = 'COMPLETED';
  }

  const scheduleStart = formatTimeHHmmInTZ(shift.plannedStart) ?? '';
  const scheduleEnd = formatTimeHHmmInTZ(shift.plannedEnd) ?? '';

  return {
    id: shift.id,
    date,
    individualId: individual.id,
    individualName: `${individual.firstName} ${individual.lastName}`.trim(),
    individualDob: individual.dob ?? '',
    individualMa: '',
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

type StartUnknownVisitInput = {
  staffId: string;
  staffName?: string;
  staffEmail?: string;

  firstName: string;
  lastName: string;

  medicaidId?: string | null;
  clientId?: string | null;

  serviceCode?: string; // default COMP
  clientTime?: string; // ISO from phone optional
};

@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportsService: GoogleReportsService,
  ) {}

  // =====================================================
  // ✅ Start Unknown Visit (AD-HOC)
  // - Create ScheduleShift for today (plannedStart=now, plannedEnd=now+60m)
  // - Create Visit check-in immediately
  // - Mark shift notes as ADHOC
  // - IMPORTANT: ScheduleShift requires weekId (ScheduleWeek)
  // =====================================================
  async startUnknownVisit(
    input: StartUnknownVisitInput,
  ): Promise<{ shiftId: string }> {
    const rawStaff = String(input.staffId || '').trim();
    const firstName = String(input.firstName || '').trim();
    const lastName = String(input.lastName || '').trim();

    if (!rawStaff) {
      throw new BadRequestException('Missing staffId');
    }
    if (!firstName || !lastName) {
      throw new BadRequestException('Please enter First Name and Last Name');
    }

    // Resolve staffId (accept Employee.id cuid OR employeeCode)
    const staff = await this.resolveEmployee(rawStaff);
    if (!staff) {
      throw new BadRequestException(`Employee not found: ${rawStaff}`);
    }
    const staffId = staff.id;

    // 1) Find individual by name (best effort)
    const individual = await this.findIndividualByName(firstName, lastName);

    if (!individual) {
      throw new NotFoundException(
        `Individual not found: "${firstName} ${lastName}". Please check spelling or search client first.`,
      );
    }

    // 2) Choose service (default COMP)
    const serviceCode = String(input.serviceCode || 'COMP')
      .trim()
      .toUpperCase();

    const service = await this.prisma.service.findFirst({
      where: { serviceCode },
      select: { id: true, serviceCode: true, serviceName: true },
    });

    if (!service) {
      throw new BadRequestException(`Service not found: ${serviceCode}`);
    }

    // 3) Determine times (in TZ)
    const now = input.clientTime
      ? DateTime.fromISO(input.clientTime, { setZone: true }).setZone(TZ)
      : DateTime.now().setZone(TZ);

    const plannedStart = now.toJSDate();
    const plannedEnd = now.plus({ minutes: 60 }).toJSDate();
    const scheduleDate = now.startOf('day').toJSDate();

    // Compute week range (Sunday 00:00 -> Saturday 23:59:59.999)
    const { weekStart, weekEnd } = this.computeWeekRangeSunday(now);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Find scheduleWeek that contains scheduleDate
        let week = await tx.scheduleWeek.findFirst({
          where: {
            individualId: individual.id,
            weekStart: { lte: scheduleDate },
            weekEnd: { gte: scheduleDate },
          },
          select: { id: true, templateId: true },
        });

        // If not found, create scheduleWeek using a valid templateId
        if (!week) {
          const latestWeek = await tx.scheduleWeek.findFirst({
            where: { individualId: individual.id },
            orderBy: { weekStart: 'desc' },
            select: { templateId: true },
          });

          // Fallback: try to find any master template for this individual
          let templateId = latestWeek?.templateId ?? null;

          if (!templateId) {
            const tmpl = await tx.masterScheduleTemplate.findFirst({
              where: { individualId: individual.id },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            templateId = tmpl?.id ?? null;
          }

          if (!templateId) {
            throw new BadRequestException(
              'Unable to start Unknown Visit right now. Missing schedule template for this Individual.',
            );
          }

          week = await tx.scheduleWeek.create({
            data: {
              individualId: individual.id,
              templateId,
              weekStart: weekStart.toJSDate(),
              weekEnd: weekEnd.toJSDate(),
              generatedFromTemplate: false,
              notes: 'ADHOC_UNKNOWN_VISIT_WEEK',
              locked: false,
            } as any,
            select: { id: true, templateId: true },
          });
        }

        const shift = await tx.scheduleShift.create({
          data: {
            weekId: week.id, // ✅ REQUIRED by schema
            scheduleDate,
            individualId: individual.id,
            serviceId: service.id,

            plannedStart,
            plannedEnd,

            plannedDspId: staffId,
            actualDspId: staffId,

            status: ScheduleStatus.IN_PROGRESS,

            notes: `ADHOC_UNKNOWN_VISIT | Medicaid:${String(
              input.medicaidId ?? '',
            ).trim()} | ClientId:${String(input.clientId ?? '').trim()}`.trim(),
          } as any,
          select: { id: true },
        });

        await tx.visit.create({
          data: {
            scheduleShiftId: shift.id,
            individualId: individual.id,
            dspId: staffId,
            serviceId: service.id,
            checkInAt: plannedStart,
            source: VisitSource.MOBILE,
          } as any,
          select: highlightSelectId(),
        });

        return { shiftId: shift.id };
      });

      return { shiftId: created.shiftId };
    } catch (err: any) {
      // Map Prisma errors to 400 (never leak 500)
      throw this.mapPrismaErrorToHttp(err);
    }
  }

  /**
   * ✅ Helper: resolve employee by id or employeeCode
   */
  private async resolveEmployee(
    staffIdOrCode: string,
  ): Promise<{ id: string } | null> {
    const key = String(staffIdOrCode || '').trim();
    if (!key) return null;

    const emp = await this.prisma.employee.findFirst({
      where: {
        OR: [{ id: key }, { employeeCode: key }],
      },
      select: { id: true },
    });

    return emp ?? null;
  }

  /**
   * ✅ Helper: compute week range (Sunday-Saturday) in TZ
   */
  private computeWeekRangeSunday(dt: DateTime): {
    weekStart: DateTime;
    weekEnd: DateTime;
  } {
    // Luxon weekday: Mon=1 ... Sun=7
    const daysSinceSunday = dt.weekday % 7; // Sun -> 0, Mon -> 1, ... Sat -> 6
    const weekStart = dt
      .startOf('day')
      .minus({ days: daysSinceSunday })
      .setZone(TZ);

    const weekEnd = weekStart.plus({ days: 6 }).endOf('day');

    return { weekStart, weekEnd };
  }

  /**
   * ✅ Helper: turn Prisma errors into friendly 400 messages
   */
  private mapPrismaErrorToHttp(err: any): BadRequestException {
    // Already an HttpException -> pass through
    if (err instanceof BadRequestException) return err;

    // Prisma validation errors (missing required fields, wrong shape)
    if (err instanceof Prisma.PrismaClientValidationError) {
      return new BadRequestException(
        'Database validation error. Some required fields are missing or invalid.',
      );
    }

    // Prisma known request errors (constraints, FK, etc.)
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // Common cases:
      // P2003 = foreign key constraint failed
      // P2002 = unique constraint failed
      if (err.code === 'P2003') {
        return new BadRequestException(
          'Database constraint error. Please verify staff/service/individual exist.',
        );
      }
      if (err.code === 'P2002') {
        return new BadRequestException(
          'Database constraint error. Duplicate record detected.',
        );
      }
      return new BadRequestException(
        `Database error (${err.code}). Unable to start Unknown Visit right now.`,
      );
    }

    // Default safe error
    return new BadRequestException('Unable to start Unknown Visit right now.');
  }

  /**
   * ✅ Helper: find individual by name
   * Priority:
   * 1) exact match (case-insensitive)
   * 2) contains match
   */
  private async findIndividualByName(
    firstName: string,
    lastName: string,
  ): Promise<Individual | null> {
    const fn = firstName.trim();
    const ln = lastName.trim();

    const exact = await this.prisma.individual.findFirst({
      where: {
        AND: [
          { firstName: { equals: fn, mode: 'insensitive' as const } },
          { lastName: { equals: ln, mode: 'insensitive' as const } },
        ],
      },
    });
    if (exact) return exact as unknown as Individual;

    const contains = await this.prisma.individual.findFirst({
      where: {
        AND: [
          { firstName: { contains: fn, mode: 'insensitive' as const } },
          { lastName: { contains: ln, mode: 'insensitive' as const } },
        ],
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    return (contains as unknown as Individual) ?? null;
  }

  // =====================================================
  // ✅ Search Individuals for mobile Clients screen
  // =====================================================
  async searchIndividuals(search: string): Promise<MobileIndividualLite[]> {
    const q = normalizeQ(search);
    if (!q) return [];

    const tokens = q.split(' ').filter(Boolean);

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
        OR: [{ id: { equals: q } }, { id: { contains: q } }, nameWhere],
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
      },
    });

    return rows.map((ind) => {
      const fullName = `${ind.firstName ?? ''} ${ind.lastName ?? ''}`.trim();
      const addr = formatAddressLines(ind as unknown as Individual);

      return {
        id: ind.id,
        fullName,
        maNumber: null,
        address1: addr.address1,
        address2: addr.address2,
        phone: null,
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
    // Resolve staff id/code to employee.id (cuid)
    const staff = await this.resolveEmployee(String(staffId || '').trim());
    if (!staff) {
      throw new BadRequestException(`Employee not found: ${staffId}`);
    }
    const staffKey = staff.id;

    const dayStartLocal = DateTime.fromISO(date, { zone: TZ })
      .startOf('day')
      .toJSDate();
    const dayEndLocal = DateTime.fromISO(date, { zone: TZ })
      .endOf('day')
      .toJSDate();

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        scheduleDate: { gte: dayStartLocal, lte: dayEndLocal },
        OR: [{ plannedDspId: staffKey }, { actualDspId: staffKey }],
      },
      include: {
        individual: true,
        service: true,
        visits: {
          where: {
            dspId: staffKey,
            checkInAt: { gte: dayStartLocal, lte: dayEndLocal },
          },
          orderBy: { checkInAt: 'asc' },
        },
      },
      orderBy: { plannedStart: 'asc' },
    });

    return {
      shifts: shifts.map((s) =>
        mapShiftToMobileShift({ shift: s, staffId: staffKey, date }),
      ),
    };
  }

  // =====================================================
  // Today shifts for a specific Individual (Client detail)
  // =====================================================
  async getTodayShiftsForIndividual(
    individualId: string,
    date: string,
    staffId?: string,
  ): Promise<{ shifts: MobileShift[] }> {
    let staffKey: string | undefined = undefined;
    if (staffId) {
      const staff = await this.resolveEmployee(String(staffId || '').trim());
      if (!staff) {
        throw new BadRequestException(`Employee not found: ${staffId}`);
      }
      staffKey = staff.id;
    }

    const dayStartLocal = DateTime.fromISO(date, { zone: TZ })
      .startOf('day')
      .toJSDate();
    const dayEndLocal = DateTime.fromISO(date, { zone: TZ })
      .endOf('day')
      .toJSDate();

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        scheduleDate: { gte: dayStartLocal, lte: dayEndLocal },
        individualId,
      },
      include: {
        individual: true,
        service: true,
        visits: {
          where: {
            checkInAt: { gte: dayStartLocal, lte: dayEndLocal },
            ...(staffKey ? { dspId: staffKey } : {}),
          },
          orderBy: { checkInAt: 'asc' },
        },
      },
      orderBy: { plannedStart: 'asc' },
    });

    return {
      shifts: shifts.map((s) =>
        mapShiftToMobileShiftForClientDetail({
          shift: s,
          date,
          staffId: staffKey,
        }),
      ),
    };
  }

  // =====================================================
  // Save Daily Note from mobile
  // =====================================================
  async submitDailyNote(payload: MobileDailyNotePayload) {
    // Resolve staff
    const staff = await this.resolveEmployee(
      String(payload.staffId || '').trim(),
    );
    if (!staff) {
      throw new BadRequestException(`Employee not found: ${payload.staffId}`);
    }
    const staffId = staff.id;

    const {
      shiftId,
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
      staffId, // store resolved id
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

        isCanceled,
        cancelReason,

        payload: computedPayload as unknown as object,

        staffReportFileId: null,
        individualReportFileId: null,
      } as any,
    });

    const enableGoogle = process.env.ENABLE_GOOGLE_REPORTS === '1';
    if (enableGoogle) {
      try {
        const { staff: staffDoc, individual } =
          await this.reportsService.generateDailyNoteDocs(
            record.id,
            computedPayload,
          );

        await this.prisma.dailyNote.update({
          where: { id: record.id },
          data: {
            staffReportFileId: staffDoc?.pdfId ?? staffDoc?.docId ?? null,
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
    const staff = await this.resolveEmployee(String(staffId || '').trim());
    if (!staff) {
      throw new BadRequestException(`Employee not found: ${staffId}`);
    }
    const staffKey = staff.id;

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
        dspId: staffKey,
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
          actualDspId: shift.actualDspId ?? staffKey,
        },
      });
    }

    return {
      status: 'OK',
      mode: 'IN',
      shiftId,
      staffId: staffKey,
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
    const staff = await this.resolveEmployee(String(staffId || '').trim());
    if (!staff) {
      throw new BadRequestException(`Employee not found: ${staffId}`);
    }
    const staffKey = staff.id;

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
      where: { scheduleShiftId: shiftId, dspId: staffKey, checkOutAt: null },
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
          dspId: staffKey,
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
        actualDspId: shift?.actualDspId ?? staffKey,
      },
    });

    return {
      status: 'OK',
      mode: 'OUT',
      shiftId,
      staffId: staffKey,
      time: checkOutAt.toISOString(),
      timesheetId: visit.id,
    };
  }
}

/**
 * Tiny helper to keep select consistent without type noise.
 */
function highlightSelectId() {
  return { id: true } as const;
}
