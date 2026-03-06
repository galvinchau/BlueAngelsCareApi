// src/mobile/mobile.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';

// Import type-only để tránh lỗi TS1272
import type {
  MobileDailyNotePayload,
  MobileIndividualLite,
  MobileHealthIncidentPayload, // ✅ NEW
} from './mobile.service';

// Import class service như bình thường
import { MobileService } from './mobile.service';

type StartUnknownVisitBody = {
  staffId: string;
  staffName?: string;
  staffEmail?: string;

  firstName: string;
  lastName: string;

  medicaidId?: string | null;
  clientId?: string | null;

  // optional future
  serviceCode?: string;
  clientTime?: string; // ISO string from device (optional)
};

// ---------- helpers (no deps) ----------
function isNonEmptyString(v: any): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseMMDDYYYY(
  v: any,
): { mm: number; dd: number; yyyy: number } | null {
  if (!isNonEmptyString(v)) return null;
  const s = v.trim();
  // Accept "MM/DD/YYYY" (with possible single digit M/D)
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  if (yyyy < 1900 || yyyy > 3000) return null;
  return { mm, dd, yyyy };
}

function parseTimeAMPM(v: any): { hh24: number; min: number } | null {
  if (!isNonEmptyString(v)) return null;
  const s = v.trim().toUpperCase();

  // Accept "HH:MM AM/PM" or "H:MM AM/PM"
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!m) return null;

  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3];

  if (h < 1 || h > 12) return null;
  if (min < 0 || min > 59) return null;

  // 12-hour -> 24-hour
  if (ampm === 'AM') {
    if (h === 12) h = 0;
  } else {
    if (h !== 12) h = h + 12;
  }

  return { hh24: h, min };
}

function buildIncidentTimestampISO(
  incidentDate: any,
  incidentTime: any,
): string | null {
  const d = parseMMDDYYYY(incidentDate);
  const t = parseTimeAMPM(incidentTime);
  if (!d || !t) return null;

  // NOTE: uses server local timezone when constructing Date(...)
  const dt = new Date(d.yyyy, d.mm - 1, d.dd, t.hh24, t.min, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;

  return dt.toISOString();
}

function normalizeHealthIncidentBody(raw: any) {
  const nowIso = new Date().toISOString();

  const body = raw && typeof raw === 'object' ? { ...raw } : {};

  // status: keep client value if present, else default SUBMITTED
  if (!isNonEmptyString(body.status)) {
    body.status = 'SUBMITTED';
  }

  // staffId is REQUIRED by DB FK (NOT NULL + FK)
  if (!isNonEmptyString(body.staffId)) {
    throw new BadRequestException('Missing staffId');
  }

  // Build incident ISO from incidentDate + incidentTime (if provided)
  const incidentIso = buildIncidentTimestampISO(
    body.incidentDate,
    body.incidentTime,
  );

  // Ensure date exists (DB: NOT NULL)
  // Prefer: explicit body.date -> incidentDate/time -> now
  if (!isNonEmptyString(body.date)) {
    body.date = incidentIso ?? nowIso;
  }

  // submittedAt:
  // - If client already sends it, keep it
  // - Else: set only when status is NOT DRAFT
  if (!isNonEmptyString(body.submittedAt)) {
    if (String(body.status).toUpperCase() !== 'DRAFT') {
      body.submittedAt = nowIso;
    }
  }

  // Ensure payload exists (DB: NOT NULL jsonb default '{}'::jsonb)
  // If mobile already sends payload object, keep it.
  // Else, store a shallow copy of form fields for audit/debug.
  if (!body.payload || typeof body.payload !== 'object') {
    const payloadCopy = { ...body };
    delete payloadCopy.payload;
    body.payload = payloadCopy;
  }

  return body;
}
// --------------------------------------

@Controller('mobile')
export class MobileController {
  constructor(private readonly mobileService: MobileService) {}

  /**
   * GET /mobile/shifts/today?staffId=...&date=YYYY-MM-DD
   */
  @Get('shifts/today')
  getTodayShifts(
    @Query('staffId') staffId: string,
    @Query('date') date: string,
  ) {
    return this.mobileService.getTodayShifts(staffId, date);
  }

  /**
   * ✅ 3-week shifts window (Prev + Current + Next week)
   * GET /mobile/shifts/window?staffId=...&date=YYYY-MM-DD
   * - date is optional (if omitted, uses "today" in America/New_York)
   */
  @Get('shifts/window')
  getShiftsWindow(
    @Query('staffId') staffId: string,
    @Query('date') date?: string,
  ) {
    return this.mobileService.getShiftsWindow(staffId, date);
  }

  /**
   * ✅ Search Individuals
   * GET /mobile/individuals?search=...
   */
  @Get('individuals')
  async searchIndividuals(
    @Query('search') search?: string,
  ): Promise<{ items: MobileIndividualLite[] }> {
    const q = String(search ?? '').trim();
    const items = await this.mobileService.searchIndividuals(q);
    return { items };
  }

  /**
   * ✅ Today shifts for a specific individual
   * GET /mobile/individuals/:id/shifts/today?date=YYYY-MM-DD&staffId=...
   * staffId is optional (if provided, show only that DSP's visits/status)
   */
  @Get('individuals/:id/shifts/today')
  async getTodayShiftsForIndividual(
    @Param('id') individualId: string,
    @Query('date') date: string,
    @Query('staffId') staffId?: string,
  ) {
    return this.mobileService.getTodayShiftsForIndividual(
      individualId,
      date,
      staffId,
    );
  }

  /**
   * ✅ Start Unknown Visit (AD-HOC)
   * POST /mobile/visits/unknown/start
   */
  @Post('visits/unknown/start')
  async startUnknownVisit(@Body() body: StartUnknownVisitBody) {
    return this.mobileService.startUnknownVisit(body);
  }

  /**
   * POST /mobile/daily-notes
   */
  @Post('daily-notes')
  submitDailyNote(@Body() payload: MobileDailyNotePayload) {
    return this.mobileService.submitDailyNote(payload);
  }

  /**
   * ✅ NEW
   * POST /mobile/health-incident
   *
   * Normalize:
   * - Require staffId
   * - Ensure date (timestamp) exists (NOT NULL in DB)
   * - If incidentDate + incidentTime present, use them to build date ISO
   * - Ensure payload jsonb exists (NOT NULL in DB)
   * - Only auto-set submittedAt when status != DRAFT
   */
  @Post('health-incident')
  submitHealthIncident(@Body() payload: MobileHealthIncidentPayload) {
    const normalized = normalizeHealthIncidentBody(
      payload,
    ) as MobileHealthIncidentPayload;
    return this.mobileService.submitHealthIncident(normalized);
  }

  /**
   * POST /mobile/shifts/:id/check-in
   */
  @Post('shifts/:id/check-in')
  checkIn(
    @Param('id') shiftId: string,
    @Body('staffId') staffId: string,
    @Body('clientTime') clientTime?: string,
  ) {
    return this.mobileService.checkInShift(shiftId, staffId, clientTime);
  }

  /**
   * POST /mobile/shifts/:id/check-out
   */
  @Post('shifts/:id/check-out')
  checkOut(
    @Param('id') shiftId: string,
    @Body('staffId') staffId: string,
    @Body('clientTime') clientTime?: string,
  ) {
    return this.mobileService.checkOutShift(shiftId, staffId, clientTime);
  }
}