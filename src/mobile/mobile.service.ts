// ======================================================
//  src/mobile/mobile.service.ts
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

export type ShiftStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

export interface MobileIndividualLite {
  id: string;
  fullName: string;
  maNumber?: string | null;
  address1?: string | null;
  address2?: string | null;
  phone?: string | null;
}

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

  isCanceled?: boolean;
  cancelReason?: string;

  dspSignature?: string;
  individualSignature?: string;

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

function formatTimeHHmmInTZ(dt: Date | null | undefined): string | null {
  if (!dt) return null;
  return DateTime.fromJSDate(dt, { zone: 'utc' }).setZone(TZ).toFormat('HH:mm');
}

function hhmmToMinutes(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function computeDurationMinutes(
  startHHmm?: string | null,
  endHHmm?: string | null,
): number | null {
  const s = hhmmToMinutes(startHHmm);
  const e = hhmmToMinutes(endHHmm);
  if (s === null || e === null) return null;
  let diff = e - s;
  if (diff < 0) diff += 1440;
  return diff;
}

function minutesToHoursStr(mins: number): string {
  const hrs = mins / 60;
  return hrs.toFixed(2);
}

function minutesToUnits(mins: number): number {
  return Math.ceil(mins / 15);
}

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

function normalizeQ(q: string): string {
  return String(q || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function mapShiftToMobileShift(params: {
  shift: ScheduleShift & {
    individual: Individual;
    service: Service;
    visits: Visit[];
  };
  staffId: string;
  date: string;
}): MobileShift {
  const { shift, staffId, date } = params;
  const individual = shift.individual;
  const service = shift.service;
  const visits = shift.visits ?? [];

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

    visitStart = formatTimeHHmmInTZ(earliest.checkInAt);
    visitEnd = formatTimeHHmmInTZ(latest.checkOutAt ?? latest.checkInAt);

    if (visitsForDsp.some((v) => !v.checkOutAt)) status = 'IN_PROGRESS';
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

function mapShiftToMobileShiftForClientDetail(params: {
  shift: ScheduleShift & {
    individual: Individual;
    service: Service;
    visits: Visit[];
  };
  date: string;
  staffId?: string;
}): MobileShift {
  const { shift, date, staffId } = params;
  const individual = shift.individual;
  const service = shift.service;
  const visits = shift.visits ?? [];

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

  serviceCode?: string;
  clientTime?: string;
};

function isOfficeRole(role?: string | null) {
  const r = (role || '').trim().toLowerCase();
  return (
    r === 'office staff' ||
    r === 'office' ||
    r === 'officestaff' ||
    r === 'office_staff'
  );
}

@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportsService: GoogleReportsService,
  ) {}

  /**
   * Resolve Employee.id from either:
   * - Employee.id (cuid)
   * - Employee.employeeId (human code like "BAC-E-2025-008")
   */
  private async resolveEmployeeId(staffIdRaw: string): Promise<string | null> {
    const staffId = String(staffIdRaw || '').trim();
    if (!staffId) return null;

    const emp = await this.prisma.employee.findFirst({
      where: {
        OR: [{ id: staffId }, { employeeId: staffId }],
      },
      select: { id: true },
    });

    return emp?.id ?? null;
  }

  /**
   * ✅ Double-time guard:
   * If this staff is Office role AND has open OfficeAttendanceEvent (IN),
   * block visit check-in until office check-out happens.
   */
  private async ensureNotCheckedInOfficeTimeKeeping(staffTechId: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: staffTechId },
      select: { employeeId: true, role: true },
    });

    if (!emp) return;
    if (!isOfficeRole(emp.role)) return;

    // OfficeAttendanceEvent.staffId uses Employee.employeeId (human code)
    const open = await this.prisma.officeAttendanceEvent.findFirst({
      where: { staffId: emp.employeeId, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
      select: { id: true, checkInAt: true },
    });

    if (open) {
      throw new BadRequestException(
        'You are currently checked-in for Office Time Keeping. Please check out first.',
      );
    }
  }

  private getWeekWindow(nowTz: DateTime): {
    weekStart: DateTime;
    weekEnd: DateTime;
  } {
    const dayStart = nowTz.startOf('day');
    const daysToSubtract = dayStart.weekday % 7;
    const weekStart = dayStart.minus({ days: daysToSubtract });
    const weekEnd = weekStart.plus({ days: 7 }).minus({ milliseconds: 1 });
    return { weekStart, weekEnd };
  }

  private async getOrCreateScheduleWeekIdTx(
    tx: any,
    individualId: string,
    nowTz: DateTime,
  ): Promise<string> {
    const { weekStart, weekEnd } = this.getWeekWindow(nowTz);

    const weekStartJs = weekStart.toJSDate();
    const weekEndJs = weekEnd.toJSDate();

    const existing = await tx.scheduleWeek.findFirst({
      where: {
        individualId,
        weekStart: weekStartJs,
      },
      select: { id: true },
    });

    if (existing?.id) return existing.id;

    const created = await tx.scheduleWeek.create({
      data: {
        individualId,
        weekStart: weekStartJs,
        weekEnd: weekEndJs,
        notes: 'AUTO_CREATED_BY_UNKNOWN_VISIT',
      },
      select: { id: true },
    });

    return created.id;
  }

  // =====================================================
  // Start Unknown Visit (AD-HOC)
  // =====================================================
  async startUnknownVisit(
    input: StartUnknownVisitInput,
  ): Promise<{ shiftId: string }> {
    const staffIdRaw = String(input.staffId || '').trim();
    const firstName = String(input.firstName || '').trim();
    const lastName = String(input.lastName || '').trim();

    if (!staffIdRaw) throw new BadRequestException('Missing staffId');
    if (!firstName || !lastName) {
      throw new BadRequestException('Please enter First Name and Last Name');
    }

    const staffTechId = await this.resolveEmployeeId(staffIdRaw);
    if (!staffTechId) {
      throw new BadRequestException(`Employee not found: ${staffIdRaw}`);
    }

    // ✅ Double-time block
    await this.ensureNotCheckedInOfficeTimeKeeping(staffTechId);

    const individual = await this.findIndividualByName(firstName, lastName);
    if (!individual) {
      throw new NotFoundException(
        `Individual not found: "${firstName} ${lastName}". Please check spelling or search client first.`,
      );
    }

    const serviceCode = String(input.serviceCode || 'COMP')
      .trim()
      .toUpperCase();

    const service = await this.prisma.service.findFirst({
      where: { serviceCode },
      select: { id: true, serviceCode: true, serviceName: true },
    });
    if (!service)
      throw new BadRequestException(`Service not found: ${serviceCode}`);

    const now = input.clientTime
      ? DateTime.fromISO(input.clientTime, { setZone: true }).setZone(TZ)
      : DateTime.now().setZone(TZ);

    const plannedStart = now.toJSDate();
    const plannedEnd = now.plus({ minutes: 60 }).toJSDate();
    const scheduleDate = now.startOf('day').toJSDate();

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const weekId = await this.getOrCreateScheduleWeekIdTx(
          tx,
          individual.id,
          now,
        );

        const shift = await tx.scheduleShift.create({
          data: {
            weekId,
            scheduleDate,
            individualId: individual.id,
            serviceId: service.id,

            plannedStart,
            plannedEnd,

            plannedDspId: staffTechId,
            actualDspId: staffTechId,

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
            dspId: staffTechId,
            serviceId: service.id,
            checkInAt: plannedStart,
            source: VisitSource.MOBILE,
          } as any,
          select: { id: true },
        });

        return { shiftId: shift.id };
      });

      return { shiftId: created.shiftId };
    } catch (err: any) {
      console.error('[MobileService] startUnknownVisit failed', {
        staffIdRaw,
        staffTechId,
        firstName,
        lastName,
        serviceCode,
        err: err?.message ?? err,
      });

      const msg = String(err?.message || '');
      if (msg.toLowerCase().includes('prisma')) {
        throw new BadRequestException(
          'Database validation error. Some required fields are missing or invalid.',
        );
      }

      throw new BadRequestException('Unable to start Unknown Visit right now.');
    }
  }

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
  // Today shifts for mobile (✅ normalize staffId)
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

    const staffTechId = (await this.resolveEmployeeId(staffId)) ?? staffId;

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        scheduleDate: { gte: dayStartLocal, lte: dayEndLocal },
        OR: [{ plannedDspId: staffTechId }, { actualDspId: staffTechId }],
      },
      include: {
        individual: true,
        service: true,
        visits: {
          where: {
            dspId: staffTechId,
            checkInAt: { gte: dayStartLocal, lte: dayEndLocal },
          },
          orderBy: { checkInAt: 'asc' },
        },
      },
      orderBy: { plannedStart: 'asc' },
    });

    return {
      shifts: shifts.map((s) =>
        mapShiftToMobileShift({ shift: s, staffId: staffTechId, date }),
      ),
    };
  }

  async getTodayShiftsForIndividual(
    individualId: string,
    date: string,
    staffId?: string,
  ): Promise<{ shifts: MobileShift[] }> {
    const dayStartLocal = DateTime.fromISO(date, { zone: TZ })
      .startOf('day')
      .toJSDate();
    const dayEndLocal = DateTime.fromISO(date, { zone: TZ })
      .endOf('day')
      .toJSDate();

    const staffTechId = staffId
      ? ((await this.resolveEmployeeId(staffId)) ?? staffId)
      : undefined;

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
            ...(staffTechId ? { dspId: staffTechId } : {}),
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
          staffId: staffTechId,
        }),
      ),
    };
  }

  // =====================================================
  // Save Daily Note from mobile (✅ normalize staffId)
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

    const staffTechId = (await this.resolveEmployeeId(staffId)) ?? staffId;

    const serviceDate = DateTime.fromISO(date, { zone: TZ })
      .startOf('day')
      .toJSDate();

    const visit = await this.prisma.visit.findFirst({
      where: { scheduleShiftId: shiftId, dspId: staffTechId },
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
        staffId: staffTechId,
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
        const { staff, individual } =
          await this.reportsService.generateDailyNoteDocs(
            record.id,
            computedPayload,
          );

        await this.prisma.dailyNote.update({
          where: { id: record.id },
          data: {
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
  // Check-in (✅ double-time guard + normalize staffId)
  // =====================================================
  async checkInShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): Promise<CheckInOutResponse> {
    const staffTechId = (await this.resolveEmployeeId(staffId)) ?? staffId;

    // ✅ Double-time block
    await this.ensureNotCheckedInOfficeTimeKeeping(staffTechId);

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
        dspId: staffTechId,
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
          actualDspId: shift.actualDspId ?? staffTechId,
        },
      });
    }

    return {
      status: 'OK',
      mode: 'IN',
      shiftId,
      staffId: staffTechId,
      time: checkInAt.toISOString(),
      timesheetId: visit.id,
    };
  }

  // =====================================================
  // Check-out (✅ normalize staffId)
  // =====================================================
  async checkOutShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): Promise<CheckInOutResponse> {
    const staffTechId = (await this.resolveEmployeeId(staffId)) ?? staffId;

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
      where: { scheduleShiftId: shiftId, dspId: staffTechId, checkOutAt: null },
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
          dspId: staffTechId,
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
        actualDspId: shift?.actualDspId ?? staffTechId,
      },
    });

    return {
      status: 'OK',
      mode: 'OUT',
      shiftId,
      staffId: staffTechId,
      time: checkOutAt.toISOString(),
      timesheetId: visit.id,
    };
  }
}
