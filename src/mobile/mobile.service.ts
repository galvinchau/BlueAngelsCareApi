// ======================================================
//  src/mobile/mobile.service.ts  (UPDATED – FIX TIMEZONE)
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
import { PrismaService } from '../prisma/prisma.service';

/**
 * Loại trạng thái ca trực trên mobile
 */
export type ShiftStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

/**
 * Dữ liệu ca trực trả về cho mobile
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
 * Payload Daily Note gửi từ mobile lên
 */
export interface MobileDailyNotePayload {
  shiftId: string;
  staffId: string;
  individualId: string;

  date: string;
  individualName: string;
  individualDob?: string;
  individualMa?: string;
  individualAddress?: string;

  serviceCode: string;
  serviceName: string;
  scheduleStart: string;
  scheduleEnd: string;
  outcomeText?: string;

  visitStart?: string;
  visitEnd?: string;

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
  certifyText?: string;
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

/**
 * ============= FIXED: FORMAT GIỜ LOCAL, KHÔNG DÙNG UTC =================
 */
function formatTimeHHmm(dt: Date | null | undefined): string | null {
  if (!dt) return null;

  // LẤY GIỜ THEO LOCAL TIME (KHÔNG UTC)
  const hh = dt.getHours().toString().padStart(2, '0');
  const mm = dt.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Helper: format địa chỉ
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
 * Helper: map ScheduleShift -> MobileShift
 */
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

  // Visit
  const visitsForDsp = visits.filter(
    (v) =>
      v.dspId === staffId &&
      v.checkInAt &&
      v.checkInAt.toISOString().substring(0, 10) === date,
  );

  let visitStart: string | null = null;
  let visitEnd: string | null = null;

  if (visitsForDsp.length > 0) {
    const earliest = [...visitsForDsp].sort((a, b) =>
      a.checkInAt < b.checkInAt ? -1 : 1,
    )[0];

    const latest = visitsForDsp.reduce((max, v) =>
      (v.checkOutAt ?? v.checkInAt) > (max.checkOutAt ?? max.checkInAt)
        ? v
        : max,
    );

    visitStart = formatTimeHHmm(earliest.checkInAt);
    visitEnd = formatTimeHHmm(latest.checkOutAt ?? latest.checkInAt);

    if (visitsForDsp.some((v) => !v.checkOutAt)) status = 'IN_PROGRESS';
    else status = 'COMPLETED';
  }

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
    scheduleStart: formatTimeHHmm(shift.plannedStart) ?? '',
    scheduleEnd: formatTimeHHmm(shift.plannedEnd) ?? '',
    status,
    visitStart,
    visitEnd,
    outcomeText: null,
  };
}

@Injectable()
export class MobileService {
  constructor(private readonly prisma: PrismaService) {}

  async getTodayShifts(
    staffId: string,
    date: string,
  ): Promise<{ shifts: MobileShift[] }> {
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        scheduleDate: {
          gte: dayStart,
          lte: dayEnd,
        },
        OR: [{ plannedDspId: staffId }, { actualDspId: staffId }],
      },
      include: {
        individual: true,
        service: true,
        visits: {
          where: {
            dspId: staffId,
            checkInAt: {
              gte: dayStart,
              lte: dayEnd,
            },
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

  submitDailyNote(payload: MobileDailyNotePayload) {
    const id = `DN_${Date.now()}`;
    console.log('[MobileService] DAILY NOTE:', payload);
    return { status: 'OK', id };
  }

  async checkInShift(shiftId: string, staffId: string, clientTime?: string) {
    const checkInAt = clientTime ? new Date(clientTime) : new Date();

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

  async checkOutShift(shiftId: string, staffId: string, clientTime?: string) {
    const checkOutAt = clientTime ? new Date(clientTime) : new Date();

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
