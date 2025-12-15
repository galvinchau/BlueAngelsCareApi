// ======================================================
//  src/mobile/mobile.service.ts
//  - Timezone: America/New_York (Altoona, PA)
//  - Lưu Daily Note vào bảng DailyNote
//  - Phase 1: Xem Daily Note trong Reports (Web)
//  - (Optional) Google Drive export is gated by env ENABLE_GOOGLE_REPORTS=1
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

  // Mileage trên mobile (nếu có)
  mileage?: number;
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
 * Format giờ HH:mm theo local time (đã convert về America/New_York trước khi gọi)
 */
function formatTimeHHmm(dt: Date | null | undefined): string | null {
  if (!dt) return null;
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
 * Helper: convert Date (UTC) -> Date (America/New_York)
 */
function toLocalDate(dt: Date): Date {
  return DateTime.fromJSDate(dt).setZone('America/New_York').toJSDate();
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
  date: string; // YYYY-MM-DD (theo America/New_York)
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

  // Visit theo DSP & theo đúng ngày local (America/New_York)
  const visitsForDsp = visits.filter((v) => {
    if (v.dspId !== staffId || !v.checkInAt) return false;
    const localDateStr = DateTime.fromJSDate(v.checkInAt)
      .setZone('America/New_York')
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

    const earliestLocal = toLocalDate(earliest.checkInAt);
    const latestLocal = toLocalDate(latest.checkOutAt ?? latest.checkInAt);

    visitStart = formatTimeHHmm(earliestLocal);
    visitEnd = formatTimeHHmm(latestLocal);

    if (visitsForDsp.some((v) => !v.checkOutAt)) status = 'IN_PROGRESS';
    else status = 'COMPLETED';
  }

  const plannedStartLocal = toLocalDate(shift.plannedStart);
  const plannedEndLocal = toLocalDate(shift.plannedEnd);

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
    scheduleStart: formatTimeHHmm(plannedStartLocal) ?? '',
    scheduleEnd: formatTimeHHmm(plannedEndLocal) ?? '',
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
  // Lấy ca trực hôm nay cho mobile
  // =====================================================
  async getTodayShifts(
    staffId: string,
    date: string,
  ): Promise<{ shifts: MobileShift[] }> {
    const dayStartLocal = DateTime.fromISO(date, { zone: 'America/New_York' })
      .startOf('day')
      .toJSDate();
    const dayEndLocal = DateTime.fromISO(date, { zone: 'America/New_York' })
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
  // Lưu Daily Note từ mobile vào bảng DailyNote
  // Phase 1: Web Reports đọc từ DB
  // =====================================================
  async submitDailyNote(payload: MobileDailyNotePayload) {
    const {
      shiftId,
      staffId,
      individualId,
      date,
      serviceCode,
      serviceName,
      scheduleStart,
      scheduleEnd,
      visitStart,
      visitEnd,
      staffName,
      mileage,
    } = payload;

    const serviceDate = DateTime.fromISO(date, { zone: 'America/New_York' })
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
        serviceName,
        scheduleStart,
        scheduleEnd,
        visitStart: visitStart ?? null,
        visitEnd: visitEnd ?? null,

        mileage: typeof mileage === 'number' ? mileage : null,
        isCanceled: false,
        cancelReason: null,

        payload: payload as unknown as object,

        staffReportFileId: null,
        individualReportFileId: null,
      },
    });

    // 2) Optional: Google export (disabled by default)
    const enableGoogle = process.env.ENABLE_GOOGLE_REPORTS === '1';
    if (enableGoogle) {
      try {
        const { staff, individual } =
          await this.reportsService.generateDailyNoteDocs(record.id, payload);

        await this.prisma.dailyNote.update({
          where: { id: record.id },
          data: {
            staffReportFileId: staff.pdfId ?? staff.docId ?? null,
            individualReportFileId:
              individual.pdfId ?? individual.docId ?? null,
          },
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
  // Check-in ca trực
  // =====================================================
  async checkInShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): Promise<CheckInOutResponse> {
    const checkInAt = clientTime
      ? DateTime.fromISO(clientTime, { zone: 'America/New_York' }).toJSDate()
      : DateTime.now().setZone('America/New_York').toJSDate();

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
  // Check-out ca trực
  // =====================================================
  async checkOutShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): Promise<CheckInOutResponse> {
    const checkOutAt = clientTime
      ? DateTime.fromISO(clientTime, { zone: 'America/New_York' }).toJSDate()
      : DateTime.now().setZone('America/New_York').toJSDate();

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
