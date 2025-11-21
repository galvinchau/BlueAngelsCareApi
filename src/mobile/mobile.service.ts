// src/mobile/mobile.service.ts
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
 * (giữ dạng any cho đơn giản, sau này map sang schema thật của BAC-HMS)
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

/**
 * Timesheet “mock” cũ – giữ type lại để status CheckInOutResponse dùng cho mobile
 */
export type CheckMode = 'IN' | 'OUT';

/**
 * Response cho mobile khi Check in / Check out
 */
export interface CheckInOutResponse {
  status: 'OK';
  mode: CheckMode;
  shiftId: string;
  staffId: string;
  time: string;
  timesheetId: string; // dùng Visit.id cho đồng bộ
}

/**
 * Helper: format DateTime -> "HH:mm"
 */
function formatTimeHHmm(dt: Date | null | undefined): string | null {
  if (!dt) return null;
  // Dùng ISO rồi cắt HH:MM cho đơn giản (UTC); sau này có thể chỉnh timezone nếu cần
  return dt.toISOString().substring(11, 16);
}

/**
 * Helper: format địa chỉ full string
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
 * Helper: map ScheduleShift + relations -> MobileShift
 */
function mapShiftToMobileShift(params: {
  shift: ScheduleShift & {
    individual: Individual;
    service: Service;
    visits: Visit[];
  };
  staffId: string;
  date: string; // YYYY-MM-DD
}): MobileShift {
  const { shift, staffId, date } = params;
  const individual = shift.individual;
  const service = shift.service;
  const visits = shift.visits ?? [];

  // Mặc định status dựa vào ScheduleStatus
  let status: ShiftStatus = 'NOT_STARTED';
  switch (shift.status) {
    case ScheduleStatus.IN_PROGRESS:
      status = 'IN_PROGRESS';
      break;
    case ScheduleStatus.COMPLETED:
    case ScheduleStatus.NOT_COMPLETED:
      status = 'COMPLETED';
      break;
    default:
      status = 'NOT_STARTED';
  }

  // Lấy visits trong ngày cho đúng DSP (filter thêm lần nữa cho chắc)
  const visitsForDsp = visits.filter(
    (v) =>
      v.dspId === staffId &&
      v.checkInAt &&
      v.checkInAt.toISOString().substring(0, 10) === date,
  );

  let visitStart: string | null = null;
  let visitEnd: string | null = null;

  if (visitsForDsp.length > 0) {
    const sortedByIn = [...visitsForDsp].sort((a, b) =>
      a.checkInAt < b.checkInAt ? -1 : 1,
    );
    const earliest = sortedByIn[0];
    const latest = sortedByIn.reduce((max, v) =>
      (v.checkOutAt ?? v.checkInAt) > (max.checkOutAt ?? max.checkInAt)
        ? v
        : max,
    );

    visitStart = formatTimeHHmm(earliest.checkInAt);
    visitEnd = formatTimeHHmm(latest.checkOutAt ?? latest.checkInAt);

    // Nếu đã có check in mà chưa có check out => IN_PROGRESS
    const anyWithoutOut = visitsForDsp.some((v) => !v.checkOutAt);
    if (anyWithoutOut) {
      status = 'IN_PROGRESS';
    } else {
      status = 'COMPLETED';
    }
  }

  return {
    id: shift.id,
    date,
    individualId: individual.id,
    individualName: `${individual.firstName} ${individual.lastName}`.trim(),
    individualDob: individual.dob ?? '',
    // Hiện schema Individual chưa có trường MA#, tạm để trống – sau này map thêm field medicaidId nếu có
    individualMa: '',
    individualAddress: formatAddress(individual),
    serviceCode: service.serviceCode,
    serviceName: service.serviceName,
    location: individual.location ?? '', // tạm lấy từ Individual.location
    scheduleStart: formatTimeHHmm(shift.plannedStart) ?? '',
    scheduleEnd: formatTimeHHmm(shift.plannedEnd) ?? '',
    status,
    visitStart,
    visitEnd,
    // Hiện chưa có OutcomeText trong schedule/visit → để null, sau này nối với ISP/BSP hoặc Daily Note
    outcomeText: null,
  };
}

@Injectable()
export class MobileService {
  // Inject PrismaService để query DB thật
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Today’s Shifts cho 1 staff (dùng DB thật)
   * - Lấy ScheduleShift của DSP trong ngày (plannedDspId/actualDspId = staffId)
   * - Join Individual + Service + Visits
   * - Tính status/visitStart/visitEnd dựa trên Visit
   */
  async getTodayShifts(
    staffId: string,
    date: string,
  ): Promise<{ shifts: MobileShift[] }> {
    // date dạng "YYYY-MM-DD"
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

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
          orderBy: {
            checkInAt: 'asc',
          },
        },
      },
      orderBy: {
        plannedStart: 'asc',
      },
    });

    const mobileShifts = shifts.map((shift) =>
      mapShiftToMobileShift({ shift, staffId, date }),
    );

    console.log('[MobileService] getTodayShifts from DB', {
      staffId,
      date,
      count: mobileShifts.length,
    });

    return { shifts: mobileShifts };
  }

  /**
   * Nhận Daily Note từ mobile (hiện tại vẫn mock – chỉ log ra console)
   * TODO: sau này lưu sang bảng DailyNote riêng (DOCX/PDF...)
   */
  submitDailyNote(payload: MobileDailyNotePayload): {
    status: 'OK';
    id: string;
  } {
    const id = `DN_${Date.now()}`;

    console.log('[MobileService] submitDailyNote payload:', payload);
    console.log('[MobileService] -> mock DailyNote id:', id);

    return { status: 'OK', id };
  }

  /**
   * Check in – tạo Visit record trong DB
   * - Nếu có ScheduleShift tương ứng → gắn scheduleShiftId/individualId/serviceId
   * - Cập nhật ScheduleShift.status = IN_PROGRESS + actualDspId nếu chưa có
   */
  async checkInShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): Promise<CheckInOutResponse> {
    const checkInAt = clientTime ? new Date(clientTime) : new Date();

    // Lấy thông tin shift để biết individual/service
    const shift = await this.prisma.scheduleShift.findUnique({
      where: { id: shiftId },
      select: {
        id: true,
        individualId: true,
        serviceId: true,
        actualDspId: true,
        status: true,
      },
    });

    if (!shift) {
      // Trong thực tế nên throw HttpException, tạm log cho đơn giản
      console.error('[MobileService] checkInShift: shift not found', {
        shiftId,
        staffId,
      });
    }

    const individualId = shift?.individualId ?? '';
    const serviceId = shift?.serviceId ?? null;

    const visit = await this.prisma.visit.create({
      data: {
        scheduleShiftId: shiftId,
        individualId,
        dspId: staffId,
        serviceId,
        checkInAt,
        source: VisitSource.MOBILE,
      },
    });

    // Cập nhật status ca trực
    if (shift) {
      await this.prisma.scheduleShift.update({
        where: { id: shiftId },
        data: {
          status: ScheduleStatus.IN_PROGRESS,
          actualDspId: shift.actualDspId ?? staffId,
        },
      });
    }

    console.log('[MobileService] CHECK IN (DB):', {
      visitId: visit.id,
      shiftId,
      staffId,
      checkInAt: visit.checkInAt,
    });

    return {
      status: 'OK',
      mode: 'IN',
      shiftId,
      staffId,
      time: visit.checkInAt.toISOString(),
      timesheetId: visit.id,
    };
  }

  /**
   * Check out – cập nhật Visit record trong DB
   * - Tìm Visit gần nhất chưa có checkOutAt cho shift + staff
   * - Nếu không thấy thì tạo Visit mới với checkInAt = checkOutAt
   * - Cập nhật ScheduleShift.status = COMPLETED (tạm thời)
   */
  async checkOutShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): Promise<CheckInOutResponse> {
    const checkOutAt = clientTime ? new Date(clientTime) : new Date();

    // Lấy shift để lấy info
    const shift = await this.prisma.scheduleShift.findUnique({
      where: { id: shiftId },
      select: {
        id: true,
        individualId: true,
        serviceId: true,
        actualDspId: true,
      },
    });

    const individualId = shift?.individualId ?? '';
    const serviceId = shift?.serviceId ?? null;

    // Tìm visit open (chưa check out)
    let visit = await this.prisma.visit.findFirst({
      where: {
        scheduleShiftId: shiftId,
        dspId: staffId,
        checkOutAt: null,
      },
      orderBy: {
        checkInAt: 'desc',
      },
    });

    if (visit) {
      // Cập nhật checkOutAt cho visit hiện có
      visit = await this.prisma.visit.update({
        where: { id: visit.id },
        data: {
          checkOutAt,
        },
      });
    } else {
      // Không tìm được visit open -> tạo visit mới (in/out cùng lúc)
      visit = await this.prisma.visit.create({
        data: {
          scheduleShiftId: shiftId,
          individualId,
          dspId: staffId,
          serviceId,
          checkInAt: checkOutAt,
          checkOutAt,
          source: VisitSource.MOBILE,
        },
      });
    }

    // Cập nhật status ca trực -> COMPLETED (tạm, sau này có thể tinh chỉnh thêm NOT_COMPLETED...)
    if (shift) {
      await this.prisma.scheduleShift.update({
        where: { id: shiftId },
        data: {
          status: ScheduleStatus.COMPLETED,
          actualDspId: shift.actualDspId ?? staffId,
        },
      });
    }

    console.log('[MobileService] CHECK OUT (DB):', {
      visitId: visit.id,
      shiftId,
      staffId,
      checkInAt: visit.checkInAt,
      checkOutAt: visit.checkOutAt,
    });

    return {
      status: 'OK',
      mode: 'OUT',
      shiftId,
      staffId,
      time: (visit.checkOutAt ?? visit.checkInAt).toISOString(),
      timesheetId: visit.id,
    };
  }
}
