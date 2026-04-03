// ======================================================
//  bac-hms/bac-api/src/mobile/mobile.service.ts
// ======================================================

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ScheduleStatus, VisitSource, type Individual } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleReportsService } from '../reports/google-reports.service';
import { PushService } from '../push/push.service';

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
  awakeMonitoringRequired?: boolean;
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

export interface MobileHealthIncidentPayload {
  staffId: string;
  staffName?: string;
  staffEmail?: string;

  individualId?: string | null;
  individualName?: string | null;

  shiftId?: string | null;

  date: string;

  payload: Record<string, any>;

  status?: 'DRAFT' | 'SUBMITTED';
}

export type CheckMode = 'IN' | 'OUT';

export interface CheckInOutResponse {
  status: 'OK';
  mode: CheckMode;
  shiftId: string;
  staffId: string;
  time: string;
  timesheetId: string;
  awakeMonitoring?: {
    enabled: boolean;
    status: string | null;
    intervalMinutes: number | null;
    graceMinutes: number | null;
    lastConfirmedAt: string | null;
    nextDueAt: string | null;
    deadlineAt: string | null;
    autoCheckedOutAt: string | null;
    autoCheckoutReason: string | null;
  };
}

export interface AwakeConfirmResponse {
  status: 'OK';
  visitId: string;
  staffId: string;
  confirmedAt: string;
  awakeMonitoring: {
    enabled: boolean;
    status: string | null;
    intervalMinutes: number | null;
    graceMinutes: number | null;
    lastConfirmedAt: string | null;
    nextDueAt: string | null;
    deadlineAt: string | null;
    autoCheckedOutAt: string | null;
    autoCheckoutReason: string | null;
  };
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

function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;

  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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

function uniqStrings(arr: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const v = String(x || '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function getShiftLocalDate(shift: any, fallbackDate?: string): string {
  const fromScheduleDate = shift?.scheduleDate
    ? DateTime.fromJSDate(shift.scheduleDate).setZone(TZ).toISODate()
    : null;

  if (fromScheduleDate) return fromScheduleDate;

  const fromPlannedStart = shift?.plannedStart
    ? DateTime.fromJSDate(shift.plannedStart).setZone(TZ).toISODate()
    : null;

  return fromPlannedStart || fallbackDate || DateTime.now().setZone(TZ).toISODate()!;
}

function pickRelevantVisitsForMobileShift(params: {
  visits: any[];
  staffIds?: string[];
  shiftDate: string;
}): any[] {
  const { visits, staffIds, shiftDate } = params;

  const visitsFiltered = staffIds?.length
    ? visits.filter((v) => staffIds.includes(v.dspId))
    : visits;

  const openVisits = visitsFiltered.filter((v) => !!v.checkInAt && !v.checkOutAt);
  if (openVisits.length > 0) return openVisits;

  return visitsFiltered.filter((v) => {
    if (!v.checkInAt) return false;
    const localDateStr = DateTime.fromJSDate(v.checkInAt)
      .setZone(TZ)
      .toISODate();
    return localDateStr === shiftDate;
  });
}

function mapShiftToMobileShift(params: {
  shift: any;
  staffIds: string[];
  date?: string;
}): MobileShift {
  const { shift, staffIds, date } = params;
  const individual = shift.individual;
  const service = shift.service;
  const visits = shift.visits ?? [];
  const shiftDate = getShiftLocalDate(shift, date);

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

  const visitsForDsp = pickRelevantVisitsForMobileShift({
    visits,
    staffIds,
    shiftDate,
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
    date: shiftDate,
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
    awakeMonitoringRequired: shift.awakeMonitoringRequired === true,
  };
}

function mapShiftToMobileShiftForClientDetail(params: {
  shift: any;
  date?: string;
  staffIds?: string[];
}): MobileShift {
  const { shift, date, staffIds } = params;
  const individual = shift.individual;
  const service = shift.service;
  const visits = shift.visits ?? [];
  const shiftDate = getShiftLocalDate(shift, date);

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

  const visitsFiltered = pickRelevantVisitsForMobileShift({
    visits,
    staffIds,
    shiftDate,
  });

  let visitStart: string | null = null;
  let visitEnd: string | null = null;

  if (visitsFiltered.length > 0) {
    const sorted = [...visitsFiltered].sort((a, b) =>
      a.checkInAt < b.checkInAt ? -1 : 1,
    );
    const earliest = sorted[0];

    const latest = visitsFiltered.reduce((max, v) => {
      const vEnd = v.checkOutAt ?? v.checkInAt;
      const maxEnd = max.checkOutAt ?? max.checkInAt;
      return vEnd > maxEnd ? v : max;
    });

    visitStart = formatTimeHHmmInTZ(earliest.checkInAt);
    visitEnd = formatTimeHHmmInTZ(latest.checkOutAt ?? latest.checkInAt);

    if (visitsFiltered.some((v) => !v.checkOutAt)) status = 'IN_PROGRESS';
    else status = 'COMPLETED';
  }

  const scheduleStart = formatTimeHHmmInTZ(shift.plannedStart) ?? '';
  const scheduleEnd = formatTimeHHmmInTZ(shift.plannedEnd) ?? '';

  return {
    id: shift.id,
    date: shiftDate,
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
    awakeMonitoringRequired: shift.awakeMonitoringRequired === true,
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

function buildAwakeMonitoringCreateData(checkInAt: Date, enabled?: boolean) {
  if (!enabled) {
    return {
      awakeMonitoringEnabled: false,
      awakeIntervalMinutes: 60,
      awakeGraceMinutes: 10,
      awakeStatus: 'OFF',
      lastAwakeConfirmedAt: null,
      nextAwakeConfirmDueAt: null,
      awakeDeadlineAt: null,
      autoCheckedOutAt: null,
      autoCheckoutReason: null,
    };
  }

  const intervalMinutes = 60;
  const graceMinutes = 10;

  const nextDueAt = new Date(
    checkInAt.getTime() + intervalMinutes * 60 * 1000,
  );
  const deadlineAt = new Date(
    nextDueAt.getTime() + graceMinutes * 60 * 1000,
  );

  return {
    awakeMonitoringEnabled: true,
    awakeIntervalMinutes: intervalMinutes,
    awakeGraceMinutes: graceMinutes,
    awakeStatus: 'ACTIVE',
    lastAwakeConfirmedAt: checkInAt,
    nextAwakeConfirmDueAt: nextDueAt,
    awakeDeadlineAt: deadlineAt,
    autoCheckedOutAt: null,
    autoCheckoutReason: null,
  };
}

function buildAwakeMonitoringConfirmData(
  confirmedAt: Date,
  intervalMinutes?: number | null,
  graceMinutes?: number | null,
) {
  const safeInterval =
    typeof intervalMinutes === 'number' && intervalMinutes > 0
      ? intervalMinutes
      : 60;

  const safeGrace =
    typeof graceMinutes === 'number' && graceMinutes > 0 ? graceMinutes : 10;

  const nextDueAt = new Date(
    confirmedAt.getTime() + safeInterval * 60 * 1000,
  );
  const deadlineAt = new Date(
    nextDueAt.getTime() + safeGrace * 60 * 1000,
  );

  return {
    awakeStatus: 'ACTIVE',
    lastAwakeConfirmedAt: confirmedAt,
    nextAwakeConfirmDueAt: nextDueAt,
    awakeDeadlineAt: deadlineAt,
  };
}

function mapAwakeMonitoringResponse(visit: any) {
  return {
    enabled: Boolean(visit?.awakeMonitoringEnabled),
    status: visit?.awakeStatus ?? null,
    intervalMinutes:
      typeof visit?.awakeIntervalMinutes === 'number'
        ? visit.awakeIntervalMinutes
        : null,
    graceMinutes:
      typeof visit?.awakeGraceMinutes === 'number'
        ? visit.awakeGraceMinutes
        : null,
    lastConfirmedAt: visit?.lastAwakeConfirmedAt
      ? new Date(visit.lastAwakeConfirmedAt).toISOString()
      : null,
    nextDueAt: visit?.nextAwakeConfirmDueAt
      ? new Date(visit.nextAwakeConfirmDueAt).toISOString()
      : null,
    deadlineAt: visit?.awakeDeadlineAt
      ? new Date(visit.awakeDeadlineAt).toISOString()
      : null,
    autoCheckedOutAt: visit?.autoCheckedOutAt
      ? new Date(visit.autoCheckedOutAt).toISOString()
      : null,
    autoCheckoutReason: visit?.autoCheckoutReason ?? null,
  };
}

@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportsService: GoogleReportsService,
    private readonly pushService: PushService,
  ) {}

  private async logAwakeEvent(args: {
    visitId: string;
    scheduleShiftId?: string | null;
    individualId: string;
    dspId: string;
    serviceId?: string | null;
    eventType:
      | 'CHECK_IN_AWAKE_STARTED'
      | 'CONFIRMED_AWAKE'
      | 'MANUAL_CHECKOUT';
    eventTime?: Date;
    note?: string | null;
    meta?: Record<string, any> | null;
  }) {
    try {
      await (this.prisma as any).awakeEventLog.create({
        data: {
          visitId: args.visitId,
          scheduleShiftId: args.scheduleShiftId ?? null,
          individualId: args.individualId,
          dspId: args.dspId,
          serviceId: args.serviceId ?? null,
          eventType: args.eventType,
          eventTime: args.eventTime ?? new Date(),
          note: args.note ?? null,
          meta: args.meta ?? null,
        },
      });
    } catch (e: any) {
      console.error('[MobileService][AwakeEventLog] failed', {
        eventType: args.eventType,
        visitId: args.visitId,
        message: e?.message ?? e,
      });
    }
  }

  private async resolveStaffIdentity(staffIdRaw: string): Promise<{
    techId: string;
    employeeId: string | null;
    role: string | null;
  } | null> {
    const staffId = String(staffIdRaw || '').trim();
    if (!staffId) return null;

    const emp = await this.prisma.employee.findFirst({
      where: {
        OR: [{ id: staffId }, { employeeId: staffId }],
      },
      select: { id: true, employeeId: true, role: true },
    });

    if (!emp?.id) return null;

    return {
      techId: emp.id,
      employeeId: emp.employeeId ?? null,
      role: emp.role ?? null,
    };
  }

  private staffVisitIds(identity: {
    techId: string;
    employeeId: string | null;
    staffIdRaw: string;
  }): string[] {
    return uniqStrings([
      identity.techId,
      identity.employeeId,
      identity.staffIdRaw,
    ]);
  }

  private async findLatestOpenVisitForStaff(staffIds: string[]) {
    return this.prisma.visit.findFirst({
      where: {
        dspId: { in: staffIds },
        checkOutAt: null,
      },
      orderBy: { checkInAt: 'desc' },
    });
  }

  private async ensureNotCheckedInOfficeTimeKeeping(staffTechId: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: staffTechId },
      select: { employeeId: true, role: true },
    });

    if (!emp) return;
    if (!isOfficeRole(emp.role)) return;

    const empCode = (emp.employeeId || '').trim();
    if (!empCode) return;

    const open = await this.prisma.officeAttendanceEvent.findFirst({
      where: { staffId: empCode, checkOutAt: null },
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

  private async generateNextHealthIncidentCaseNumber(): Promise<string> {
    const prismaAny = this.prisma as any;

    const latestWithCaseNumber = await prismaAny.healthIncidentReport.findFirst({
      where: {
        caseNumber: {
          not: null,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { date: 'desc' }],
      select: {
        caseNumber: true,
      },
    });

    const current = String(latestWithCaseNumber?.caseNumber || '').trim();
    const match = /^HIR-(\d+)$/.exec(current);

    const nextNumber = match ? Number(match[1]) + 1 : 1;
    return `HIR-${String(nextNumber).padStart(6, '0')}`;
  }

  async registerPushToken(input: {
    staffId: string;
    expoPushToken: string;
    platform?: string;
    deviceId?: string;
    deviceName?: string;
    appVersion?: string;
  }) {
    const identity = await this.resolveStaffIdentity(input.staffId);
    if (!identity) {
      throw new BadRequestException(`Employee not found: ${input.staffId}`);
    }

    const expoPushToken = String(input.expoPushToken || '').trim();

    if (!this.pushService.isExpoPushToken(expoPushToken)) {
      throw new BadRequestException('Invalid Expo push token.');
    }

    const saved = await this.prisma.mobilePushToken.upsert({
      where: {
        expoPushToken,
      },
      update: {
        staffId: identity.techId,
        platform: input.platform?.trim() || null,
        deviceId: input.deviceId?.trim() || null,
        deviceName: input.deviceName?.trim() || null,
        appVersion: input.appVersion?.trim() || null,
        isActive: true,
        lastSeenAt: new Date(),
        revokedAt: null,
      },
      create: {
        staffId: identity.techId,
        expoPushToken,
        platform: input.platform?.trim() || null,
        deviceId: input.deviceId?.trim() || null,
        deviceName: input.deviceName?.trim() || null,
        appVersion: input.appVersion?.trim() || null,
        isActive: true,
        lastSeenAt: new Date(),
        revokedAt: null,
      },
    });

    return {
      status: 'OK',
      id: saved.id,
      expoPushToken: saved.expoPushToken,
      isActive: saved.isActive,
    };
  }

  async deactivatePushToken(input: {
    staffId: string;
    expoPushToken: string;
  }) {
    const identity = await this.resolveStaffIdentity(input.staffId);
    if (!identity) {
      throw new BadRequestException(`Employee not found: ${input.staffId}`);
    }

    const expoPushToken = String(input.expoPushToken || '').trim();

    const result = await this.prisma.mobilePushToken.updateMany({
      where: {
        staffId: identity.techId,
        expoPushToken,
        isActive: true,
      },
      data: {
        isActive: false,
        revokedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    return {
      status: 'OK',
      updated: result.count,
    };
  }

  async sendTestPush(staffId: string) {
    const identity = await this.resolveStaffIdentity(staffId);
    if (!identity) {
      throw new BadRequestException(`Employee not found: ${staffId}`);
    }

    return this.pushService.sendTestToStaff(identity.techId);
  }

  async sendShiftCancelledPush(input: {
    staffId: string;
    shiftId?: string;
    individualName?: string | null;
    serviceName?: string | null;
    shiftDateLabel?: string | null;
    shiftTimeLabel?: string | null;
    note?: string | null;
  }) {
    const identity = await this.resolveStaffIdentity(input.staffId);
    if (!identity) {
      throw new BadRequestException(`Employee not found: ${input.staffId}`);
    }

    const title = 'Assigned Shift Cancelled';

    const mainParts = [
      input.individualName ? `Individual: ${input.individualName}` : null,
      input.serviceName ? `Service: ${input.serviceName}` : null,
      input.shiftDateLabel ? `Date: ${input.shiftDateLabel}` : null,
      input.shiftTimeLabel ? `Time: ${input.shiftTimeLabel}` : null,
    ].filter(Boolean);

    const body =
      mainParts.length > 0
        ? `Your assigned shift has been cancelled.\n${mainParts.join('\n')}`
        : 'Your assigned shift has been cancelled. Please check the app or contact the office.';

    return this.pushService.sendToStaff(identity.techId, {
      title,
      body,
      sound: 'default',
      data: {
        type: 'SHIFT_CANCELLED',
        shiftId: input.shiftId ?? null,
        individualName: input.individualName ?? null,
        serviceName: input.serviceName ?? null,
        shiftDateLabel: input.shiftDateLabel ?? null,
        shiftTimeLabel: input.shiftTimeLabel ?? null,
        note: input.note ?? null,
        ts: new Date().toISOString(),
      },
    });
  }

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

    const identity = await this.resolveStaffIdentity(staffIdRaw);
    if (!identity) {
      throw new BadRequestException(`Employee not found: ${staffIdRaw}`);
    }

    const staffTechId = identity.techId;

    await this.ensureNotCheckedInOfficeTimeKeeping(staffTechId);

    const individual = await this.findIndividualByName(firstName, lastName);
    if (!individual) {
      throw new NotFoundException(
        `Individual not found: "${firstName} ${lastName}". Please check spelling or search client first.`,
      );
    }

    const serviceCode = String(input.serviceCode || 'W1726')
      .trim()
      .toUpperCase();

    const service = await this.prisma.service.findFirst({
      where: { serviceCode },
      select: { id: true, serviceCode: true, serviceName: true },
    });
    if (!service) {
      throw new BadRequestException(`Service not found: ${serviceCode}`);
    }

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

    const identity = await this.resolveStaffIdentity(staffId);
    const staffTechId = identity?.techId ?? staffId;
    const staffIds = this.staffVisitIds({
      techId: staffTechId,
      employeeId: identity?.employeeId ?? null,
      staffIdRaw: staffId,
    });

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        OR: [
          {
            AND: [
              {
                scheduleDate: { gte: dayStartLocal, lte: dayEndLocal },
              },
              {
                OR: [
                  { plannedDspId: staffTechId },
                  { actualDspId: staffTechId },
                ],
              },
            ],
          },
          {
            visits: {
              some: {
                dspId: { in: staffIds },
                checkOutAt: { equals: null },
              },
            },
          },
        ],
      },
      include: {
        individual: true,
        service: true,
        visits: {
          where: {
            dspId: { in: staffIds },
          },
          orderBy: { checkInAt: 'asc' },
        },
      },
      orderBy: { plannedStart: 'asc' },
    });

    return {
      shifts: shifts.map((s) =>
        mapShiftToMobileShift({ shift: s, staffIds, date }),
      ),
    };
  }

  async getShiftsWindow(
    staffId: string,
    date?: string,
  ): Promise<{ shifts: MobileShift[] }> {
    const identity = await this.resolveStaffIdentity(staffId);
    const staffTechId = identity?.techId ?? staffId;

    const staffIds = this.staffVisitIds({
      techId: staffTechId,
      employeeId: identity?.employeeId ?? null,
      staffIdRaw: staffId,
    });

    const nowTz = date
      ? DateTime.fromISO(date, { zone: TZ })
      : DateTime.now().setZone(TZ);

    const { weekStart } = this.getWeekWindow(nowTz);

    const rangeStart = weekStart.minus({ days: 7 }).startOf('day');
    const rangeEnd = weekStart.plus({ days: 14 }).minus({ milliseconds: 1 });

    const rangeStartJs = rangeStart.toJSDate();
    const rangeEndJs = rangeEnd.toJSDate();

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        OR: [
          {
            AND: [
              {
                scheduleDate: { gte: rangeStartJs, lte: rangeEndJs },
              },
              {
                OR: [
                  { plannedDspId: staffTechId },
                  { actualDspId: staffTechId },
                ],
              },
            ],
          },
          {
            visits: {
              some: {
                dspId: { in: staffIds },
                checkOutAt: { equals: null },
              },
            },
          },
        ],
      },
      include: {
        individual: true,
        service: true,
        visits: {
          where: {
            dspId: { in: staffIds },
          },
          orderBy: { checkInAt: 'asc' },
        },
      },
      orderBy: [{ scheduleDate: 'asc' }, { plannedStart: 'asc' }],
    });

    return {
      shifts: shifts.map((s) => {
        const d = DateTime.fromJSDate(s.scheduleDate)
          .setZone(TZ)
          .toISODate() as string;

        return mapShiftToMobileShift({ shift: s, staffIds, date: d });
      }),
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

    let staffIds: string[] | undefined = undefined;
    if (staffId) {
      const identity = await this.resolveStaffIdentity(staffId);
      const staffTechId = identity?.techId ?? staffId;
      staffIds = this.staffVisitIds({
        techId: staffTechId,
        employeeId: identity?.employeeId ?? null,
        staffIdRaw: staffId,
      });
    }

    const openVisitOrConditions = staffIds?.length
      ? [
          {
            visits: {
              some: {
                dspId: { in: staffIds },
                checkOutAt: { equals: null },
              },
            },
          },
        ]
      : [];

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        individualId,
        OR: [
          {
            scheduleDate: { gte: dayStartLocal, lte: dayEndLocal },
          },
          ...openVisitOrConditions,
        ],
      },
      include: {
        individual: true,
        service: true,
        visits: {
          where: {
            ...(staffIds?.length ? { dspId: { in: staffIds } } : {}),
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
          staffIds,
        }),
      ),
    };
  }

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

    const identity = await this.resolveStaffIdentity(staffId);
    const staffTechId = identity?.techId ?? staffId;
    const staffIds = this.staffVisitIds({
      techId: staffTechId,
      employeeId: identity?.employeeId ?? null,
      staffIdRaw: staffId,
    });

    const shift = await this.prisma.scheduleShift.findUnique({
      where: { id: shiftId },
      select: {
        id: true,
        scheduleDate: true,
        plannedStart: true,
        serviceId: true,
      },
    });

    const serviceDate =
      shift?.scheduleDate ??
      DateTime.fromISO(date, { zone: TZ }).startOf('day').toJSDate();

    const visit = await this.prisma.visit.findFirst({
      where: { scheduleShiftId: shiftId, dspId: { in: staffIds } },
      orderBy: { checkInAt: 'desc' },
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
      date: getShiftLocalDate(
        { scheduleDate: shift?.scheduleDate, plannedStart: shift?.plannedStart },
        date,
      ),
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
        serviceId: service?.id ?? shift?.serviceId ?? null,
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

  async submitHealthIncident(payload: MobileHealthIncidentPayload) {
    const staffIdRaw = String(payload?.staffId ?? '').trim();
    if (!staffIdRaw) throw new BadRequestException('Missing staffId');

    const dateStr = String(payload?.date ?? '').trim();
    if (!dateStr) throw new BadRequestException('Missing date (YYYY-MM-DD)');

    const identity = await this.resolveStaffIdentity(staffIdRaw);
    const staffTechId = identity?.techId ?? staffIdRaw;

    const serviceDate = DateTime.fromISO(dateStr, { zone: TZ })
      .startOf('day')
      .toJSDate();

    const status = payload?.status === 'DRAFT' ? 'DRAFT' : 'SUBMITTED';

    const prismaAny = this.prisma as any;
    if (!prismaAny?.healthIncidentReport?.create) {
      throw new BadRequestException(
        'HealthIncidentReport is not deployed yet. Please run Supabase SQL to create the table, then run pnpm prisma generate.',
      );
    }

    try {
      const caseNumber = await this.generateNextHealthIncidentCaseNumber();

      const record = await prismaAny.healthIncidentReport.create({
        data: {
          caseNumber,
          shiftId: payload.shiftId ?? null,
          staffId: staffTechId,
          staffName: payload.staffName ?? null,
          staffEmail: payload.staffEmail ?? null,

          individualId: payload.individualId ?? null,
          individualName: payload.individualName ?? null,

          date: serviceDate,

          status,
          submittedAt: status === 'SUBMITTED' ? new Date() : null,

          payload: (payload.payload ?? {}) as object,

          supervisorName: null,
          supervisorDecision: null,
          supervisorActionsTaken: null,
          reviewedAt: null,
        },
        select: { id: true, caseNumber: true },
      });

      return { status: 'OK', id: record.id, caseNumber: record.caseNumber };
    } catch (err: any) {
      console.error('[MobileService] submitHealthIncident failed', {
        staffIdRaw,
        staffTechId,
        dateStr,
        err: err?.message ?? err,
      });

      throw new BadRequestException(
        'Unable to save Health & Incident report right now.',
      );
    }
  }

  async checkInShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
    gpsLatitude?: number,
    gpsLongitude?: number,
    awakeMonitoringEnabled?: boolean, // backward compatible only; ignored for policy
  ): Promise<CheckInOutResponse> {
    const identity = await this.resolveStaffIdentity(staffId);
    if (!identity) {
      throw new BadRequestException(`Employee not found: ${staffId}`);
    }

    const staffTechId = identity.techId;
    const staffIds = this.staffVisitIds({
      techId: staffTechId,
      employeeId: identity.employeeId ?? null,
      staffIdRaw: staffId,
    });

    await this.ensureNotCheckedInOfficeTimeKeeping(staffTechId);

    const lat = toNullableNumber(gpsLatitude);
    const lng = toNullableNumber(gpsLongitude);

    console.log('[MobileService][check-in] raw gps =', {
      gpsLatitude,
      gpsLongitude,
      gpsLatitudeType: typeof gpsLatitude,
      gpsLongitudeType: typeof gpsLongitude,
      awakeMonitoringEnabledRequested: awakeMonitoringEnabled,
    });
    console.log('[MobileService][check-in] normalized gps =', {
      lat,
      lng,
    });

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
        status: true,
        awakeMonitoringRequired: true,
      },
    });

    if (!shift) throw new NotFoundException('Shift not found');

    const awakeRequiredByOffice = shift.awakeMonitoringRequired === true;

    const existingOpen = await this.prisma.visit.findFirst({
      where: {
        scheduleShiftId: shiftId,
        dspId: { in: staffIds },
        checkOutAt: null,
      },
      orderBy: { checkInAt: 'desc' },
    });

    if (existingOpen) {
      const shouldBackfillGps =
        (lat !== null || lng !== null) &&
        (existingOpen.gpsLatitude == null || existingOpen.gpsLongitude == null);

      const shouldEnableAwakeNow =
        awakeRequiredByOffice === true &&
        existingOpen.awakeMonitoringEnabled !== true;

      if (shouldBackfillGps || shouldEnableAwakeNow) {
        const awakeData = shouldEnableAwakeNow
          ? buildAwakeMonitoringCreateData(
              existingOpen.checkInAt ?? checkInAt,
              true,
            )
          : {};

        const updatedExisting = await this.prisma.visit.update({
          where: { id: existingOpen.id },
          data: {
            gpsLatitude:
              existingOpen.gpsLatitude == null ? lat : existingOpen.gpsLatitude,
            gpsLongitude:
              existingOpen.gpsLongitude == null ? lng : existingOpen.gpsLongitude,
            ...awakeData,
          },
        });

        if (shouldEnableAwakeNow) {
          await this.logAwakeEvent({
            visitId: updatedExisting.id,
            scheduleShiftId: updatedExisting.scheduleShiftId ?? null,
            individualId: updatedExisting.individualId,
            dspId: updatedExisting.dspId,
            serviceId: updatedExisting.serviceId ?? null,
            eventType: 'CHECK_IN_AWAKE_STARTED',
            eventTime: updatedExisting.checkInAt ?? checkInAt,
            note: 'Awake monitoring started on existing open visit.',
            meta: {
              source: 'MOBILE_CHECK_IN_EXISTING_OPEN_VISIT',
              awakeRequiredByOffice,
            },
          });
        }

        console.log('[MobileService][check-in] updated existing open visit =', {
          id: updatedExisting.id,
          gpsLatitude: updatedExisting.gpsLatitude,
          gpsLongitude: updatedExisting.gpsLongitude,
          awakeMonitoringEnabled: updatedExisting.awakeMonitoringEnabled,
          awakeStatus: updatedExisting.awakeStatus,
          nextAwakeConfirmDueAt: updatedExisting.nextAwakeConfirmDueAt,
          awakeDeadlineAt: updatedExisting.awakeDeadlineAt,
          awakeRequiredByOffice,
        });

        if (shift.status !== ScheduleStatus.IN_PROGRESS) {
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
          time: (updatedExisting.checkInAt ?? checkInAt).toISOString(),
          timesheetId: updatedExisting.id,
          awakeMonitoring: mapAwakeMonitoringResponse(updatedExisting),
        };
      }

      console.log(
        '[MobileService][check-in] existing open visit found but no update needed =',
        {
          existingVisitId: existingOpen.id,
          existingGpsLatitude: existingOpen.gpsLatitude,
          existingGpsLongitude: existingOpen.gpsLongitude,
          lat,
          lng,
          awakeMonitoringEnabledRequested: awakeMonitoringEnabled,
          existingAwakeMonitoringEnabled: existingOpen.awakeMonitoringEnabled,
          awakeRequiredByOffice,
        },
      );

      if (shift.status !== ScheduleStatus.IN_PROGRESS) {
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
        time: (existingOpen.checkInAt ?? checkInAt).toISOString(),
        timesheetId: existingOpen.id,
        awakeMonitoring: mapAwakeMonitoringResponse(existingOpen),
      };
    }

    const awakeData = buildAwakeMonitoringCreateData(
      checkInAt,
      awakeRequiredByOffice,
    );

    const visit = await this.prisma.visit.create({
      data: {
        scheduleShiftId: shiftId,
        individualId: shift.individualId ?? '',
        dspId: staffTechId,
        serviceId: shift.serviceId ?? null,
        checkInAt,
        source: VisitSource.MOBILE,
        gpsLatitude: lat,
        gpsLongitude: lng,
        ...awakeData,
      },
    });

    if (awakeRequiredByOffice === true) {
      await this.logAwakeEvent({
        visitId: visit.id,
        scheduleShiftId: visit.scheduleShiftId ?? null,
        individualId: visit.individualId,
        dspId: visit.dspId,
        serviceId: visit.serviceId ?? null,
        eventType: 'CHECK_IN_AWAKE_STARTED',
        eventTime: visit.checkInAt ?? checkInAt,
        note: 'Awake monitoring started on new visit check-in.',
        meta: {
          source: 'MOBILE_CHECK_IN_NEW_VISIT',
          awakeRequiredByOffice,
        },
      });
    }

    console.log('[MobileService][check-in] created visit =', {
      id: visit.id,
      gpsLatitude: visit.gpsLatitude,
      gpsLongitude: visit.gpsLongitude,
      awakeMonitoringEnabled: visit.awakeMonitoringEnabled,
      awakeStatus: visit.awakeStatus,
      nextAwakeConfirmDueAt: visit.nextAwakeConfirmDueAt,
      awakeDeadlineAt: visit.awakeDeadlineAt,
      awakeRequiredByOffice,
    });

    await this.prisma.scheduleShift.update({
      where: { id: shiftId },
      data: {
        status: ScheduleStatus.IN_PROGRESS,
        actualDspId: shift.actualDspId ?? staffTechId,
      },
    });

    return {
      status: 'OK',
      mode: 'IN',
      shiftId,
      staffId: staffTechId,
      time: checkInAt.toISOString(),
      timesheetId: visit.id,
      awakeMonitoring: mapAwakeMonitoringResponse(visit),
    };
  }

  async confirmAwake(
    visitId: string,
    staffId: string,
  ): Promise<AwakeConfirmResponse> {
    const identity = await this.resolveStaffIdentity(staffId);
    if (!identity) {
      throw new BadRequestException(`Employee not found: ${staffId}`);
    }

    const staffTechId = identity.techId;
    const staffIds = this.staffVisitIds({
      techId: staffTechId,
      employeeId: identity.employeeId ?? null,
      staffIdRaw: staffId,
    });

    const visit = await this.prisma.visit.findFirst({
      where: {
        id: visitId,
        dspId: { in: staffIds },
      },
    });

    if (!visit) {
      throw new NotFoundException('Visit not found');
    }

    if (visit.checkOutAt) {
      throw new BadRequestException(
        'This visit is already checked out. Awake confirmation is no longer allowed.',
      );
    }

    if (visit.awakeMonitoringEnabled !== true) {
      throw new BadRequestException(
        'Awake Monitoring is not enabled for this visit.',
      );
    }

    const confirmedAt = DateTime.now().setZone(TZ).toJSDate();

    const confirmData = buildAwakeMonitoringConfirmData(
      confirmedAt,
      visit.awakeIntervalMinutes,
      visit.awakeGraceMinutes,
    );

    const updatedVisit = await this.prisma.visit.update({
      where: { id: visit.id },
      data: {
        ...confirmData,
      },
    });

    await this.logAwakeEvent({
      visitId: updatedVisit.id,
      scheduleShiftId: updatedVisit.scheduleShiftId ?? null,
      individualId: updatedVisit.individualId,
      dspId: updatedVisit.dspId,
      serviceId: updatedVisit.serviceId ?? null,
      eventType: 'CONFIRMED_AWAKE',
      eventTime: confirmedAt,
      note: 'DSP confirmed awake.',
      meta: {
        source: 'MOBILE_AWAKE_CONFIRM',
        awakeStatus: updatedVisit.awakeStatus ?? null,
        nextAwakeConfirmDueAt: updatedVisit.nextAwakeConfirmDueAt ?? null,
        awakeDeadlineAt: updatedVisit.awakeDeadlineAt ?? null,
      },
    });

    console.log('[MobileService][awake-confirm] updated visit =', {
      id: updatedVisit.id,
      dspId: updatedVisit.dspId,
      awakeMonitoringEnabled: updatedVisit.awakeMonitoringEnabled,
      awakeStatus: updatedVisit.awakeStatus,
      lastAwakeConfirmedAt: updatedVisit.lastAwakeConfirmedAt,
      nextAwakeConfirmDueAt: updatedVisit.nextAwakeConfirmDueAt,
      awakeDeadlineAt: updatedVisit.awakeDeadlineAt,
    });

    return {
      status: 'OK',
      visitId: updatedVisit.id,
      staffId: staffTechId,
      confirmedAt: confirmedAt.toISOString(),
      awakeMonitoring: mapAwakeMonitoringResponse(updatedVisit),
    };
  }

  async checkOutShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
    gpsLatitude?: number,
    gpsLongitude?: number,
  ): Promise<CheckInOutResponse> {
    const identity = await this.resolveStaffIdentity(staffId);
    if (!identity) {
      throw new BadRequestException(`Employee not found: ${staffId}`);
    }

    const staffTechId = identity.techId;
    const staffIds = this.staffVisitIds({
      techId: staffTechId,
      employeeId: identity.employeeId ?? null,
      staffIdRaw: staffId,
    });

    const lat = toNullableNumber(gpsLatitude);
    const lng = toNullableNumber(gpsLongitude);

    console.log('[MobileService][check-out] raw gps =', {
      gpsLatitude,
      gpsLongitude,
      gpsLatitudeType: typeof gpsLatitude,
      gpsLongitudeType: typeof gpsLongitude,
    });
    console.log('[MobileService][check-out] normalized gps =', {
      lat,
      lng,
    });

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

    if (!shift) throw new NotFoundException('Shift not found');

    const latestOpenVisit = await this.findLatestOpenVisitForStaff(staffIds);

    if (
      latestOpenVisit?.id &&
      latestOpenVisit.scheduleShiftId &&
      latestOpenVisit.scheduleShiftId !== shiftId
    ) {
      console.warn('[MobileService][check-out] blocked mismatched shift checkout', {
        requestedShiftId: shiftId,
        actualOpenShiftId: latestOpenVisit.scheduleShiftId,
        openVisitId: latestOpenVisit.id,
        staffIdRaw: staffId,
        staffTechId,
      });

      throw new BadRequestException(
        'You are currently checked in on another shift. Please refresh and open the active overnight/current shift before checking out.',
      );
    }

    const openVisit =
      latestOpenVisit?.scheduleShiftId === shiftId
        ? latestOpenVisit
        : await this.prisma.visit.findFirst({
            where: {
              scheduleShiftId: shiftId,
              dspId: { in: staffIds },
              checkOutAt: null,
            },
            orderBy: { checkInAt: 'desc' },
          });

    let timesheetId: string;

    if (openVisit?.id) {
      const updatedVisit = await this.prisma.visit.update({
        where: { id: openVisit.id },
        data: {
          checkOutAt,
          gpsLatitude:
            openVisit.gpsLatitude == null ? lat : openVisit.gpsLatitude,
          gpsLongitude:
            openVisit.gpsLongitude == null ? lng : openVisit.gpsLongitude,
        },
      });

      if (updatedVisit.awakeMonitoringEnabled === true) {
        await this.logAwakeEvent({
          visitId: updatedVisit.id,
          scheduleShiftId: updatedVisit.scheduleShiftId ?? null,
          individualId: updatedVisit.individualId,
          dspId: updatedVisit.dspId,
          serviceId: updatedVisit.serviceId ?? null,
          eventType: 'MANUAL_CHECKOUT',
          eventTime: checkOutAt,
          note: 'DSP manually checked out awake visit.',
          meta: {
            source: 'MOBILE_CHECK_OUT_OPEN_VISIT',
            autoCheckedOutAt: updatedVisit.autoCheckedOutAt ?? null,
            autoCheckoutReason: updatedVisit.autoCheckoutReason ?? null,
          },
        });
      }

      console.log('[MobileService][check-out] updated open visit =', {
        id: updatedVisit.id,
        gpsLatitude: updatedVisit.gpsLatitude,
        gpsLongitude: updatedVisit.gpsLongitude,
        checkOutAt: updatedVisit.checkOutAt,
      });

      timesheetId = openVisit.id;
    } else {
      const created = await this.prisma.visit.create({
        data: {
          scheduleShiftId: shiftId,
          individualId: shift.individualId ?? '',
          dspId: staffTechId,
          serviceId: shift.serviceId ?? null,
          checkInAt: checkOutAt,
          checkOutAt,
          source: VisitSource.MOBILE,
          gpsLatitude: lat,
          gpsLongitude: lng,
        },
      });

      console.log('[MobileService][check-out] created visit on check-out =', {
        id: created.id,
        gpsLatitude: created.gpsLatitude,
        gpsLongitude: created.gpsLongitude,
      });

      timesheetId = created.id;
    }

    await this.prisma.scheduleShift.update({
      where: { id: shiftId },
      data: {
        status: ScheduleStatus.COMPLETED,
        actualDspId: shift.actualDspId ?? staffTechId,
      },
    });

    return {
      status: 'OK',
      mode: 'OUT',
      shiftId,
      staffId: staffTechId,
      time: checkOutAt.toISOString(),
      timesheetId,
    };
  }
}