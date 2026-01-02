// src/mobile/mobile.types.ts

export type MobileShiftStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export interface MobileShiftDto {
  id: string;
  date: string; // YYYY-MM-DD

  individualId: string;
  individualName: string;
  individualDob?: string;
  individualMa?: string;
  individualAddress?: string;

  serviceCode: string; // COMP / HCSS / PCA...
  serviceName: string; // "COMP – Companion"
  location: string;

  scheduleStart: string; // "08:00"
  scheduleEnd: string; // "12:00"

  status: MobileShiftStatus;
  visitStart?: string | null;
  visitEnd?: string | null;

  outcomeText?: string;
}

// Match MobileDailyNotePayload from mobile app
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

  visitStart: string;
  visitEnd: string;

  todayPlan: string;
  whatWeWorkedOn: string;
  opportunities: string;
  notes: string;

  meals: {
    breakfast: { time?: string; had?: string; offered?: string };
    lunch: { time?: string; had?: string; offered?: string };
    dinner: { time?: string; had?: string; offered?: string };
  };

  healthNotes?: string;
  incidentNotes?: string;

  staffName: string;
  certifyText: string;
}
