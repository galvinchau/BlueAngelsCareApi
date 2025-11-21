// src/mobile/mobile.service.ts
import { Injectable } from '@nestjs/common';
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
 * Timesheet “mock” lưu tạm trong RAM
 */
export type CheckMode = 'IN' | 'OUT';

export interface TimesheetEntry {
  id: string; // TS_1, TS_2, ...
  shiftId: string;
  staffId: string;
  mode: CheckMode; // IN / OUT
  time: string; // ISO timestamp (ưu tiên giờ gửi từ device)
}

/**
 * Response cho mobile khi Check in / Check out
 */
export interface CheckInOutResponse {
  status: 'OK';
  mode: CheckMode;
  shiftId: string;
  staffId: string;
  time: string;
  timesheetId: string;
}

@Injectable()
export class MobileService {
  // Inject PrismaService để sau này dùng query DB thật
  constructor(private readonly prisma: PrismaService) {}

  // Bộ nhớ tạm để giữ timesheet (mỗi lần restart Nest sẽ mất – tạm chấp nhận)
  private timesheets: TimesheetEntry[] = [];
  private timesheetCounter = 1;

  /**
   * Mock Today’s Shifts cho 1 staff
   * + Tính trạng thái theo timesheets (NOT_STARTED / IN_PROGRESS / COMPLETED)
   * + Gán visitStart / visitEnd theo lần IN/OUT thực tế trong ngày đó
   */
  getTodayShifts(staffId: string, date: string): { shifts: MobileShift[] } {
    // Mock một ca cố định
    const baseShift: MobileShift = {
      id: '1',
      date,
      individualId: 'IND001',
      individualName: 'Donald Wilbur',
      individualDob: '01/15/1985',
      individualMa: 'MA123456',
      individualAddress: '123 Main St, Altoona, PA 16602',
      serviceCode: 'COMP',
      serviceName: 'COMP – Companion',
      location: 'Home – Altoona, PA',
      scheduleStart: '08:00',
      scheduleEnd: '12:00',
      status: 'NOT_STARTED',
      visitStart: null,
      visitEnd: null,
      outcomeText: 'Increase independence with daily living skills at home.',
    };

    // Lọc timesheet của ca này, staff này, đúng ngày
    const entriesForDay = this.timesheets.filter((e) => {
      if (e.shiftId !== baseShift.id || e.staffId !== staffId) return false;
      const entryDate = e.time.substring(0, 10); // "YYYY-MM-DD"
      return entryDate === date;
    });

    let currentShift: MobileShift = { ...baseShift };

    if (entriesForDay.length > 0) {
      const inEntries = entriesForDay.filter((e) => e.mode === 'IN');
      const outEntries = entriesForDay.filter((e) => e.mode === 'OUT');

      const hasIn = inEntries.length > 0;
      const hasOut = outEntries.length > 0;

      if (hasIn && !hasOut) {
        currentShift.status = 'IN_PROGRESS';
      } else if (hasIn && hasOut) {
        currentShift.status = 'COMPLETED';
      }

      if (hasIn) {
        const earliestIn = inEntries.reduce((min, e) =>
          e.time < min.time ? e : min,
        );
        currentShift.visitStart = earliestIn.time;
      }

      if (hasOut) {
        const latestOut = outEntries.reduce((max, e) =>
          e.time > max.time ? e : max,
        );
        currentShift.visitEnd = latestOut.time;
      }
    }

    console.log('[MobileService] getTodayShifts for', { staffId, date });
    console.log('[MobileService] -> currentShift:', currentShift);

    return { shifts: [currentShift] };
  }

  /**
   * Nhận Daily Note từ mobile (đang chỉ log ra console)
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
   * Check in – tạo 1 timesheet entry (mock)
   * Nếu mobile gửi clientTime thì dùng luôn clientTime làm giờ chính thức.
   */
  checkInShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): CheckInOutResponse {
    const time = clientTime || new Date().toISOString();
    const timesheetId = `TS_${this.timesheetCounter++}`;

    const entry: TimesheetEntry = {
      id: timesheetId,
      shiftId,
      staffId,
      mode: 'IN',
      time,
    };

    this.timesheets.push(entry);

    console.log('[MobileService] CHECK IN:', entry);

    return {
      status: 'OK',
      mode: 'IN',
      shiftId,
      staffId,
      time,
      timesheetId,
    };
  }

  /**
   * Check out – tạo 1 timesheet entry (mock)
   * Nếu mobile gửi clientTime thì dùng luôn clientTime làm giờ chính thức.
   */
  checkOutShift(
    shiftId: string,
    staffId: string,
    clientTime?: string,
  ): CheckInOutResponse {
    const time = clientTime || new Date().toISOString();
    const timesheetId = `TS_${this.timesheetCounter++}`;

    const entry: TimesheetEntry = {
      id: timesheetId,
      shiftId,
      staffId,
      mode: 'OUT',
      time,
    };

    this.timesheets.push(entry);

    console.log('[MobileService] CHECK OUT:', entry);

    return {
      status: 'OK',
      mode: 'OUT',
      shiftId,
      staffId,
      time,
      timesheetId,
    };
  }
}
