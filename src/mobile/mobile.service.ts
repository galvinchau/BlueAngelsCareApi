// src/mobile/mobile.service.ts
import { Injectable } from '@nestjs/common';

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
  time: string; // ISO timestamp
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
  // Bộ nhớ tạm để giữ timesheet (mỗi lần restart Nest sẽ mất – tạm chấp nhận)
  private timesheets: TimesheetEntry[] = [];
  private timesheetCounter = 1;

  // Bộ nhớ tạm giữ ca trực của hôm nay (mock 1 ca duy nhất)
  private currentShift: MobileShift | null = null;

  /**
   * Mock Today’s Shifts cho 1 staff
   */
  getTodayShifts(staffId: string, date: string): { shifts: MobileShift[] } {
    // Nếu chưa có currentShift, hoặc ngày khác → tạo ca mới
    if (!this.currentShift || this.currentShift.date !== date) {
      this.currentShift = {
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
    }

    console.log('[MobileService] getTodayShifts for', { staffId, date });
    console.log('[MobileService] -> currentShift:', this.currentShift);

    return { shifts: [this.currentShift] };
  }

  /**
   * Nhận Daily Note từ mobile (đang chỉ log ra console)
   */
  submitDailyNote(payload: MobileDailyNotePayload): { status: 'OK'; id: string } {
    const id = `DN_${Date.now()}`;

    console.log('[MobileService] submitDailyNote payload:', payload);
    console.log('[MobileService] -> mock DailyNote id:', id);

    return { status: 'OK', id };
  }

  /**
   * Check in – tạo 1 timesheet entry (mock) + cập nhật status/visitStart
   */
  checkInShift(shiftId: string, staffId: string): CheckInOutResponse {
    const time = new Date().toISOString();
    const timesheetId = `TS_${this.timesheetCounter++}`;

    // Cập nhật ca trực hiện tại nếu khớp id
    if (this.currentShift && this.currentShift.id === shiftId) {
      if (!this.currentShift.visitStart) {
        this.currentShift.visitStart = time;
      }
      // Nếu đang NOT_STARTED thì chuyển sang IN_PROGRESS
      if (this.currentShift.status === 'NOT_STARTED') {
        this.currentShift.status = 'IN_PROGRESS';
      }
    } else {
      console.warn(
        '[MobileService] checkInShift: no currentShift matched',
        shiftId,
        this.currentShift,
      );
    }

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
   * Check out – tạo 1 timesheet entry (mock) + cập nhật status/visitEnd
   */
  checkOutShift(shiftId: string, staffId: string): CheckInOutResponse {
    const time = new Date().toISOString();
    const timesheetId = `TS_${this.timesheetCounter++}`;

    // Cập nhật ca trực hiện tại nếu khớp id
    if (this.currentShift && this.currentShift.id === shiftId) {
      if (!this.currentShift.visitEnd) {
        this.currentShift.visitEnd = time;
      }
      this.currentShift.status = 'COMPLETED';
    } else {
      console.warn(
        '[MobileService] checkOutShift: no currentShift matched',
        shiftId,
        this.currentShift,
      );
    }

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
