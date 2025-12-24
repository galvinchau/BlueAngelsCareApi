// ======================================================
//  src/mobile/mobile.service.ts
//  - Timezone: America/New_York (Altoona, PA)
//  - Save Daily Note into DailyNote table
//  - Google export is gated by env ENABLE_GOOGLE_REPORTS=1
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

export type ShiftStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

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
  certifyText?: string;

  mileage?: number;

  // Mobile app may send additional fields (signatures, cancel, etc.).
  // We keep all of them inside payload JSON to avoid schema mismatch issues.
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

@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportsService: GoogleReportsService,
  ) {}

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
  // Save Daily Note from mobile (SAFE MODE)
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

    // NOTE: Mobile may send cancel fields even if not in the TS interface.
    const isCanceled = (payload as any)?.isCanceled === true;
    const cancelReason =
      typeof (payload as any)?.cancelReason === 'string'
        ? String((payload as any).cancelReason).trim()
        : null;

    // SAFE CREATE:
    // - Only write core columns that are guaranteed in schema
    // - Do NOT write any report fields (staffReportDocPath, etc.) to avoid Prisma Client mismatch on Render
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
        cancelReason: isCanceled ? cancelReason : null,

        payload: payload as unknown as object,
      } as any,
    });

    // Optional: generate docs (but do NOT update DB report columns here)
    const enableGoogle = process.env.ENABLE_GOOGLE_REPORTS === '1';
    if (enableGoogle) {
      try {
        await this.reportsService.generateDailyNoteDocs(record.id, payload);
      } catch (err) {
        console.error(
          '[MobileService] Failed to generate Google Docs/PDF',
          err,
        );
      }
    }

    return { status: 'OK', id: record.id };
  }

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
