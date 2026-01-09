import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateTime } from 'luxon';
import type { OfficeAttendanceSource } from '@prisma/client';

const TZ = 'America/New_York';

type AdminCtx = {
  userType: string; // ADMIN | HR | ...
  userEmail: string;
  userId: string;
};

type DailyAdjInput = { date: string; minutes: number | null };

type WeeklyRow = {
  staffId: string;
  name: string;
  position: string;
  computedMinutes: number;
  adjustedMinutes: number | null; // legacy weekly adjusted (optional)
  finalMinutes: number;
  status: 'PENDING' | 'APPROVED';
  approvedBy: string | null; // email
  approvedByName: string | null; // ✅ name
  approvedAt: string | null; // iso
  flagsCount: number;
};

type DailySummaryRow = {
  date: string; // YYYY-MM-DD
  computedMinutes: number;
  adjustedMinutes: number | null;
  resultMinutes: number;
};

// ✅ Typed shape for approvals to avoid Map<never, never>
type ApprovalLite = {
  staffId: string;
  status: 'PENDING' | 'APPROVED';
  adjustedMinutes: number | null;
  finalMinutes: number;
  approvedByEmail: string | null;
  approvedAt: Date | null;
  dailyAdjustments: any; // Json
};

function parseISODateOnly(s: string) {
  const dt = DateTime.fromISO(s, { zone: TZ });
  if (!dt.isValid) return null;
  return dt.startOf('day');
}

function weekStartEnd(from: string, to: string) {
  const s = parseISODateOnly(from);
  const e = parseISODateOnly(to);
  if (!s || !e) return null;
  return {
    weekStart: s.startOf('day'),
    weekEnd: e.endOf('day'),
  };
}

function minutesBetween(a: DateTime, b: DateTime) {
  const diff = b.diff(a, 'minutes').minutes;
  return Math.max(0, Math.round(diff));
}

function todayLocal() {
  return DateTime.now().setZone(TZ);
}

function requireGPS(lat?: number, lng?: number, acc?: number) {
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    typeof acc !== 'number'
  ) {
    throw new BadRequestException(
      'GPS is required (latitude/longitude/accuracy).',
    );
  }
}

/**
 * IMPORTANT (Audit):
 * - For admin actions (approve/adjust/unlock), we must ALWAYS know who did it.
 * - Do NOT default userEmail to admin@local.
 * - If ctx.userEmail is missing => throw 400 so we can fix the caller (web/api).
 */
function normalizeCtx(ctx?: AdminCtx): AdminCtx {
  const userType = ((ctx?.userType || '').toString().trim() ||
    'ADMIN') as string;

  const userEmail = (ctx?.userEmail || '').toString().trim();
  if (!userEmail) {
    throw new BadRequestException(
      'Missing userEmail context. Cannot audit approve/adjust actions.',
    );
  }

  const userId = (ctx?.userId || '').toString().trim();

  return { userType, userEmail, userId };
}

function isOfficeRole(role?: string | null) {
  const r = (role || '').trim().toLowerCase();
  return (
    r === 'office staff' ||
    r === 'office' ||
    r === 'officestaff' ||
    r === 'office_staff'
  );
}

// ✅ Normalize day key (YYYY-MM-DD) in TZ
function dayKeyFromJSDate(d: Date) {
  return DateTime.fromJSDate(d).setZone(TZ).toISODate()!;
}

function safeNumber(x: any): number | null {
  if (typeof x !== 'number') return null;
  if (!Number.isFinite(x)) return null;
  return x;
}

// ✅ Read stored dailyAdjustments from DB (Json) safely
function readDailyAdjustmentsJson(x: any): Record<string, number | null> {
  if (!x || typeof x !== 'object') return {};
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(x)) {
    const n = safeNumber(v);
    out[k] = n === null ? null : Math.round(n);
  }
  return out;
}

@Injectable()
export class TimeKeepingService {
  constructor(private readonly prisma: PrismaService) {}

  private ensureApprover(ctx: AdminCtx) {
    if (ctx.userType !== 'ADMIN' && ctx.userType !== 'HR') {
      throw new ForbiddenException('Only ADMIN/HR can approve time keeping.');
    }
  }

  /**
   * Resolve staffId for self endpoints:
   * - If staffId is provided: use it (but still must be Office Staff).
   * - If missing: resolve by ctx.userEmail => Employee.email => employee.employeeId
   */
  private async resolveStaffIdForSelf(staffId?: string, ctx?: AdminCtx) {
    const userType = (ctx?.userType || 'ADMIN').toString();
    const userEmail = (ctx?.userEmail || '').toString();
    const userId = (ctx?.userId || '').toString();
    const c = { userType, userEmail, userId };

    if (staffId && staffId.trim()) return staffId.trim();

    const email = (c.userEmail || '').trim().toLowerCase();
    if (!email) {
      throw new BadRequestException(
        'Missing staffId. Cannot resolve by userEmail.',
      );
    }

    const emp = await this.prisma.employee.findFirst({
      where: { email: email },
      select: {
        employeeId: true,
        role: true,
        firstName: true,
        lastName: true,
        email: true,
      },
    });

    if (!emp) {
      throw new NotFoundException(
        'Employee profile not found. Please ensure this office user is linked to an Employee record.',
      );
    }

    if (!isOfficeRole(emp.role)) {
      throw new ForbiddenException('Time Keeping is for Office staff only.');
    }

    return emp.employeeId;
  }

  private async ensureOfficeStaffById(staffId: string) {
    const emp = await this.prisma.employee.findFirst({
      where: { employeeId: staffId },
      select: { employeeId: true, role: true },
    });

    if (!emp) {
      throw new NotFoundException(
        'Employee profile not found. Please ensure this office user is linked to an Employee record.',
      );
    }

    if (!isOfficeRole(emp.role)) {
      throw new ForbiddenException('Time Keeping is for Office staff only.');
    }
  }

  // ✅ NEW: if week is APPROVED, block check-in until unlocked
  private async ensureWeekNotApprovedForCheckIn(
    staffId: string,
    now: DateTime,
  ) {
    // week starts Sunday
    const weekStart = now.startOf('day').minus({ days: now.weekday % 7 }); // Sun=0
    const weekEnd = weekStart.plus({ days: 6 }).endOf('day');

    const existing = await this.prisma.officeWeeklyApproval.findUnique({
      where: {
        staffId_weekStart_weekEnd: {
          staffId,
          weekStart: weekStart.toJSDate(),
          weekEnd: weekEnd.toJSDate(),
        },
      },
      select: { status: true },
    });

    if (existing?.status === 'APPROVED') {
      throw new ForbiddenException('Week is approved. Ask Admin/HR to unlock.');
    }
  }

  // =================== SELF ===================

  async getStatus(params: {
    staffId?: string;
    from: string;
    to: string;
    ctx?: AdminCtx;
  }) {
    const { from, to } = params;

    const staffId = await this.resolveStaffIdForSelf(
      params.staffId,
      params.ctx,
    );
    await this.ensureOfficeStaffById(staffId);

    const latest = await this.prisma.officeAttendanceEvent.findFirst({
      where: { staffId },
      orderBy: { checkInAt: 'desc' },
    });

    const open = await this.prisma.officeAttendanceEvent.findFirst({
      where: { staffId, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
    });

    const serverNow = todayLocal();

    return {
      staffId,
      staffName: latest?.staffName || '-',
      role: 'OFFICE',
      isCheckedIn: !!open,
      activeSessionId: open?.id || null,
      lastCheckInAt: latest?.checkInAt ? latest.checkInAt.toISOString() : null,
      lastCheckOutAt: latest?.checkOutAt
        ? latest.checkOutAt.toISOString()
        : null,
      lastLat: latest?.checkOutLat ?? latest?.checkInLat ?? null,
      lastLng: latest?.checkOutLng ?? latest?.checkInLng ?? null,
      lastAccuracy: latest?.checkOutAccuracy ?? latest?.checkInAccuracy ?? null,
      serverTime: serverNow.toISO(),
    };
  }

  async getAttendance(params: {
    staffId?: string;
    from: string;
    to: string;
    ctx?: AdminCtx;
  }) {
    const { from, to } = params;

    const staffId = await this.resolveStaffIdForSelf(
      params.staffId,
      params.ctx,
    );
    await this.ensureOfficeStaffById(staffId);

    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');

    const events = await this.prisma.officeAttendanceEvent.findMany({
      where: {
        staffId,
        checkInAt: {
          gte: range.weekStart.toJSDate(),
          lte: range.weekEnd.toJSDate(),
        },
      },
      orderBy: { checkInAt: 'asc' },
    });

    return events.map((ev) => {
      const inAt = DateTime.fromJSDate(ev.checkInAt).setZone(TZ);
      const outAt = ev.checkOutAt
        ? DateTime.fromJSDate(ev.checkOutAt).setZone(TZ)
        : null;
      const totalMinutes = outAt ? minutesBetween(inAt, outAt) : null;

      return {
        id: ev.id,
        staffId: ev.staffId,
        staffName: ev.staffName || '-',
        checkInAt: ev.checkInAt.toISOString(),
        checkOutAt: ev.checkOutAt ? ev.checkOutAt.toISOString() : null,
        totalMinutes,
        latitude: ev.checkInLat ?? null,
        longitude: ev.checkInLng ?? null,
        accuracy: ev.checkInAccuracy ?? null,
        source: ev.source,
        flags: ev.flags ?? [],
      };
    });
  }

  async checkIn(params: {
    staffId?: string; // ✅ optional
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    source: 'WEB' | 'MOBILE';
    clientTime?: string;
    ctx?: AdminCtx;
  }) {
    const { latitude, longitude, accuracy, source } = params;

    requireGPS(latitude, longitude, accuracy);

    const staffId = await this.resolveStaffIdForSelf(
      params.staffId,
      params.ctx,
    );
    await this.ensureOfficeStaffById(staffId);

    const now = todayLocal();

    // ✅ Option 1: If week already approved => block new attendance
    await this.ensureWeekNotApprovedForCheckIn(staffId, now);

    const open = await this.prisma.officeAttendanceEvent.findFirst({
      where: { staffId, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
    });

    if (open) {
      throw new BadRequestException(
        'Already checked in. Please check out first.',
      );
    }

    const emp = await this.prisma.employee.findFirst({
      where: { employeeId: staffId },
      select: { firstName: true, lastName: true, email: true },
    });

    const staffName = emp ? `${emp.firstName} ${emp.lastName}` : null;

    const created = await this.prisma.officeAttendanceEvent.create({
      data: {
        staffId,
        staffEmail: emp?.email ?? null,
        staffName,
        checkInAt: now.toJSDate(),
        checkInLat: latitude,
        checkInLng: longitude,
        checkInAccuracy: accuracy,
        source: source as OfficeAttendanceSource,
        flags: [],
      },
    });

    return { ok: true, id: created.id, staffId };
  }

  async checkOut(params: {
    staffId?: string; // ✅ optional
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    source: 'WEB' | 'MOBILE';
    clientTime?: string;
    ctx?: AdminCtx;
  }) {
    const { latitude, longitude, accuracy } = params;

    requireGPS(latitude, longitude, accuracy);

    const staffId = await this.resolveStaffIdForSelf(
      params.staffId,
      params.ctx,
    );
    await this.ensureOfficeStaffById(staffId);

    const open = await this.prisma.officeAttendanceEvent.findFirst({
      where: { staffId, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
    });

    if (!open) {
      throw new BadRequestException('No active check-in found.');
    }

    const now = todayLocal();

    await this.prisma.officeAttendanceEvent.update({
      where: { id: open.id },
      data: {
        checkOutAt: now.toJSDate(),
        checkOutLat: latitude,
        checkOutLng: longitude,
        checkOutAccuracy: accuracy,
      },
    });

    return { ok: true, staffId };
  }

  // =================== ADMIN/HR Approval ===================

  private async getApproverNameByEmail(email?: string | null) {
    const e = (email || '').trim().toLowerCase();
    if (!e) return null;

    const emp = await this.prisma.employee.findFirst({
      where: { email: e },
      select: { firstName: true, lastName: true },
    });
    if (!emp) return null;

    const name = `${emp.firstName} ${emp.lastName}`.trim();
    return name || null;
  }

  private computeDailyComputedFromEvents(
    events: Array<{ checkInAt: Date; checkOutAt: Date | null }>,
  ) {
    const byDay = new Map<string, number>();
    for (const ev of events) {
      const day = dayKeyFromJSDate(ev.checkInAt);
      const inAt = DateTime.fromJSDate(ev.checkInAt).setZone(TZ);
      const outAt = ev.checkOutAt
        ? DateTime.fromJSDate(ev.checkOutAt).setZone(TZ)
        : null;
      const mins = outAt ? minutesBetween(inAt, outAt) : 0;
      byDay.set(day, (byDay.get(day) || 0) + mins);
    }
    return byDay;
  }

  async adminListWeekly(params: {
    from: string;
    to: string;
    q: string;
    status: 'PENDING' | 'APPROVED' | 'ALL';
    ctx?: AdminCtx;
  }) {
    const { from, to, q, status } = params;
    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');

    const ctx = normalizeCtx(params.ctx);
    this.ensureApprover(ctx);

    const events = await this.prisma.officeAttendanceEvent.findMany({
      where: {
        checkInAt: {
          gte: range.weekStart.toJSDate(),
          lte: range.weekEnd.toJSDate(),
        },
      },
      select: {
        staffId: true,
        checkInAt: true,
        checkOutAt: true,
        flags: true,
      },
    });

    const staffIds = Array.from(new Set(events.map((e) => e.staffId)));

    const employees = await this.prisma.employee.findMany({
      where: {
        employeeId: { in: staffIds },
      },
      select: {
        employeeId: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    const empMap = new Map(
      employees.map((e) => [
        e.employeeId,
        { name: `${e.firstName} ${e.lastName}`, position: e.role || 'Office' },
      ]),
    );

    // ✅ FIX (never): force typed approvals + typed Map key/value
    const approvals = (await this.prisma.officeWeeklyApproval.findMany({
      where: {
        weekStart: range.weekStart.toJSDate(),
        weekEnd: range.weekEnd.toJSDate(),
        staffId: { in: staffIds },
      },
      select: {
        staffId: true,
        status: true,
        adjustedMinutes: true,
        finalMinutes: true,
        approvedByEmail: true,
        approvedAt: true,
        dailyAdjustments: true as any, // ✅ Json
      } as any,
    } as any)) as unknown as ApprovalLite[];

    const appMap = new Map<string, ApprovalLite>();
    for (const a of approvals) appMap.set(a.staffId, a);

    // computed minutes + flags count
    const agg = new Map<
      string,
      { computedMinutes: number; flagsCount: number }
    >();

    for (const ev of events) {
      const inAt = DateTime.fromJSDate(ev.checkInAt).setZone(TZ);
      const outAt = ev.checkOutAt
        ? DateTime.fromJSDate(ev.checkOutAt).setZone(TZ)
        : null;
      const mins = outAt ? minutesBetween(inAt, outAt) : 0;

      const prev = agg.get(ev.staffId) || { computedMinutes: 0, flagsCount: 0 };
      prev.computedMinutes += mins;

      const hasFlags = Array.isArray(ev.flags) && ev.flags.length > 0;
      if (hasFlags) prev.flagsCount += 1;

      agg.set(ev.staffId, prev);
    }

    const rows: WeeklyRow[] = [];

    for (const staffId of staffIds) {
      const a = appMap.get(staffId) ?? null;
      const c = agg.get(staffId) || { computedMinutes: 0, flagsCount: 0 };
      const meta = empMap.get(staffId) || { name: staffId, position: 'Office' };

      const approvedByEmail = (a?.approvedByEmail ?? null) as string | null;
      const approvedByName = await this.getApproverNameByEmail(approvedByEmail);

      const finalMinutes =
        (typeof a?.finalMinutes === 'number'
          ? a.finalMinutes
          : typeof a?.adjustedMinutes === 'number'
            ? a.adjustedMinutes
            : null) ?? c.computedMinutes;

      rows.push({
        staffId,
        name: meta.name,
        position: meta.position,
        computedMinutes: c.computedMinutes,
        adjustedMinutes:
          typeof a?.adjustedMinutes === 'number' ? a.adjustedMinutes : null,
        finalMinutes,
        status:
          ((a?.status || 'PENDING') as 'PENDING' | 'APPROVED') || 'PENDING',
        approvedBy: approvedByEmail,
        approvedByName,
        approvedAt: a?.approvedAt ? new Date(a.approvedAt).toISOString() : null,
        flagsCount: c.flagsCount,
      });
    }

    const filtered = rows.filter((r) => {
      const q2 = q.trim().toLowerCase();
      const matchQ =
        !q2 ||
        r.staffId.toLowerCase().includes(q2) ||
        r.name.toLowerCase().includes(q2) ||
        r.position.toLowerCase().includes(q2);

      const matchStatus = status === 'ALL' ? true : r.status === status;

      return matchQ && matchStatus;
    });

    return filtered;
  }

  async adminGetWeeklyDetail(params: {
    staffId: string;
    from: string;
    to: string;
    ctx?: AdminCtx;
  }) {
    const { staffId, from, to } = params;
    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');

    const ctx = normalizeCtx(params.ctx);
    this.ensureApprover(ctx);

    const emp = await this.prisma.employee.findFirst({
      where: { employeeId: staffId },
      select: {
        employeeId: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    const events = await this.prisma.officeAttendanceEvent.findMany({
      where: {
        staffId,
        checkInAt: {
          gte: range.weekStart.toJSDate(),
          lte: range.weekEnd.toJSDate(),
        },
      },
      orderBy: { checkInAt: 'asc' },
    });

    let computedMinutes = 0;
    let flagsCount = 0;

    const attendance = events.map((ev) => {
      const inAt = DateTime.fromJSDate(ev.checkInAt).setZone(TZ);
      const outAt = ev.checkOutAt
        ? DateTime.fromJSDate(ev.checkOutAt).setZone(TZ)
        : null;
      const mins = outAt ? minutesBetween(inAt, outAt) : 0;
      computedMinutes += mins;

      const hasFlags = Array.isArray(ev.flags) && ev.flags.length > 0;
      if (hasFlags) flagsCount += 1;

      return {
        id: ev.id,
        staffId: ev.staffId,
        staffName:
          ev.staffName || (emp ? `${emp.firstName} ${emp.lastName}` : '-'),
        checkInAt: ev.checkInAt.toISOString(),
        checkOutAt: ev.checkOutAt ? ev.checkOutAt.toISOString() : null,
        totalMinutes: outAt ? mins : null,
        latitude: ev.checkInLat ?? null,
        longitude: ev.checkInLng ?? null,
        accuracy: ev.checkInAccuracy ?? null,
        source: ev.source,
        flags: ev.flags ?? [],
      };
    });

    const approval = (await this.prisma.officeWeeklyApproval.findUnique({
      where: {
        staffId_weekStart_weekEnd: {
          staffId,
          weekStart: range.weekStart.toJSDate(),
          weekEnd: range.weekEnd.toJSDate(),
        },
      },
      select: {
        adjustedMinutes: true,
        finalMinutes: true,
        computedMinutes: true,
        status: true,
        approvedByEmail: true,
        approvedAt: true,
        dailyAdjustments: true as any, // ✅ Json
      } as any,
    } as any)) as unknown as
      | (ApprovalLite & {
          computedMinutes?: number;
        })
      | null;

    const name = emp ? `${emp.firstName} ${emp.lastName}` : staffId;
    const position = emp?.role || 'Office';

    const dailyComputedMap = this.computeDailyComputedFromEvents(
      events.map((e) => ({ checkInAt: e.checkInAt, checkOutAt: e.checkOutAt })),
    );

    const days: string[] = [];
    const cur = range.weekStart.startOf('day');
    for (let i = 0; i < 7; i++) {
      days.push(cur.plus({ days: i }).toISODate()!);
    }

    const storedDaily = readDailyAdjustmentsJson(approval?.dailyAdjustments);

    const daily: DailySummaryRow[] = days.map((d) => {
      const computed = dailyComputedMap.get(d) || 0;
      const adj = typeof storedDaily[d] === 'number' ? storedDaily[d] : null;
      const result = adj === null ? computed : adj;
      return {
        date: d,
        computedMinutes: computed,
        adjustedMinutes: adj,
        resultMinutes: result,
      };
    });

    const totalAfterAdjustedMinutes = daily.reduce(
      (sum, r) => sum + (r.resultMinutes || 0),
      0,
    );

    const approvedByEmail = (approval?.approvedByEmail ?? null) as
      | string
      | null;
    const approvedByName = await this.getApproverNameByEmail(approvedByEmail);

    const row = {
      staffId,
      name,
      position,
      computedMinutes,
      adjustedMinutes: approval?.adjustedMinutes ?? null, // legacy
      finalMinutes:
        (typeof approval?.finalMinutes === 'number'
          ? approval.finalMinutes
          : null) ?? totalAfterAdjustedMinutes,
      totalAfterAdjustedMinutes, // ✅ used by UI
      status: (approval?.status || 'PENDING') as 'PENDING' | 'APPROVED',
      approvedBy: approvedByEmail,
      approvedByName,
      approvedAt: approval?.approvedAt
        ? new Date(approval.approvedAt).toISOString()
        : null,
      flagsCount,
      daily, // ✅ new
    };

    return { row, attendance };
  }

  async adminAdjustWeekly(params: {
    staffId: string;
    from: string;
    to: string;
    dailyAdjustments: DailyAdjInput[];
    adjustedMinutes: number | null; // legacy
    reason: string;
    ctx?: AdminCtx;
  }) {
    const { staffId, from, to, dailyAdjustments, adjustedMinutes, reason } =
      params;
    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');

    const ctx = normalizeCtx(params.ctx);
    this.ensureApprover(ctx);

    const events = await this.prisma.officeAttendanceEvent.findMany({
      where: {
        staffId,
        checkInAt: {
          gte: range.weekStart.toJSDate(),
          lte: range.weekEnd.toJSDate(),
        },
      },
      select: { checkInAt: true, checkOutAt: true },
    });

    let computedMinutes = 0;
    for (const ev of events) {
      const inAt = DateTime.fromJSDate(ev.checkInAt).setZone(TZ);
      const outAt = ev.checkOutAt
        ? DateTime.fromJSDate(ev.checkOutAt).setZone(TZ)
        : null;
      if (outAt) computedMinutes += minutesBetween(inAt, outAt);
    }

    const dailyAdjJson: Record<string, number | null> = {};
    if (Array.isArray(dailyAdjustments) && dailyAdjustments.length) {
      for (const x of dailyAdjustments) {
        const d = (x?.date || '').toString().trim();
        const dt = parseISODateOnly(d);
        if (!dt) continue;

        if (x.minutes === null || x.minutes === undefined) {
          dailyAdjJson[dt.toISODate()!] = null;
          continue;
        }
        if (!Number.isFinite(Number(x.minutes)) || Number(x.minutes) < 0) {
          throw new BadRequestException(
            'dailyAdjustments.minutes must be >= 0',
          );
        }
        dailyAdjJson[dt.toISODate()!] = Math.round(Number(x.minutes));
      }
    }

    const dailyComputedMap = this.computeDailyComputedFromEvents(events);

    const days: string[] = [];
    const cur = range.weekStart.startOf('day');
    for (let i = 0; i < 7; i++) {
      days.push(cur.plus({ days: i }).toISODate()!);
    }

    let totalAfterAdjustedMinutes = 0;
    for (const d of days) {
      const computed = dailyComputedMap.get(d) || 0;
      const adj = typeof dailyAdjJson[d] === 'number' ? dailyAdjJson[d] : null;
      totalAfterAdjustedMinutes += adj === null ? computed : adj;
    }

    const finalMinutes = dailyAdjustments?.length
      ? totalAfterAdjustedMinutes
      : typeof adjustedMinutes === 'number'
        ? Math.round(adjustedMinutes)
        : computedMinutes;

    const up = await this.prisma.officeWeeklyApproval.upsert({
      where: {
        staffId_weekStart_weekEnd: {
          staffId,
          weekStart: range.weekStart.toJSDate(),
          weekEnd: range.weekEnd.toJSDate(),
        },
      },
      update: {
        computedMinutes,
        adjustedMinutes: dailyAdjustments?.length
          ? null
          : typeof adjustedMinutes === 'number'
            ? Math.round(adjustedMinutes)
            : null,
        finalMinutes,
        reason: reason || null,
        dailyAdjustments: dailyAdjJson as any,
      } as any,
      create: {
        staffId,
        weekStart: range.weekStart.toJSDate(),
        weekEnd: range.weekEnd.toJSDate(),
        computedMinutes,
        adjustedMinutes: dailyAdjustments?.length
          ? null
          : typeof adjustedMinutes === 'number'
            ? Math.round(adjustedMinutes)
            : null,
        finalMinutes,
        status: 'PENDING',
        reason: reason || null,
        dailyAdjustments: dailyAdjJson as any,
      } as any,
    } as any);

    return {
      ok: true,
      computedMinutes: (up as any).computedMinutes,
      finalMinutes: (up as any).finalMinutes,
      status: (up as any).status,
    };
  }

  async adminApproveWeekly(params: {
    staffId: string;
    from: string;
    to: string;
    reason: string;
    ctx?: AdminCtx;
  }) {
    const { staffId, from, to, reason } = params;
    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');

    const ctx = normalizeCtx(params.ctx);
    this.ensureApprover(ctx);

    const approverEmail = ctx.userEmail;
    const approverId = ctx.userId;

    const existing = (await this.prisma.officeWeeklyApproval.findUnique({
      where: {
        staffId_weekStart_weekEnd: {
          staffId,
          weekStart: range.weekStart.toJSDate(),
          weekEnd: range.weekEnd.toJSDate(),
        },
      },
      select: {
        id: true,
        finalMinutes: true,
        reason: true,
        dailyAdjustments: true as any,
      } as any,
    } as any)) as unknown as { id: string; reason: string | null } | null;

    if (!existing) {
      const events = await this.prisma.officeAttendanceEvent.findMany({
        where: {
          staffId,
          checkInAt: {
            gte: range.weekStart.toJSDate(),
            lte: range.weekEnd.toJSDate(),
          },
        },
        select: { checkInAt: true, checkOutAt: true },
      });

      let computedMinutes = 0;
      for (const ev of events) {
        const inAt = DateTime.fromJSDate(ev.checkInAt).setZone(TZ);
        const outAt = ev.checkOutAt
          ? DateTime.fromJSDate(ev.checkOutAt).setZone(TZ)
          : null;
        if (outAt) computedMinutes += minutesBetween(inAt, outAt);
      }

      const created = await this.prisma.officeWeeklyApproval.create({
        data: {
          staffId,
          weekStart: range.weekStart.toJSDate(),
          weekEnd: range.weekEnd.toJSDate(),
          computedMinutes,
          adjustedMinutes: null,
          finalMinutes: computedMinutes,
          status: 'APPROVED',
          approvedByUserId: approverId,
          approvedByEmail: approverEmail,
          approvedAt: todayLocal().toJSDate(),
          reason: reason || null,
          dailyAdjustments: {} as any,
        },
      } as any);

      return {
        ok: true,
        status: (created as any).status,
        finalMinutes: (created as any).finalMinutes,
      };
    }

    const updated = await this.prisma.officeWeeklyApproval.update({
      where: { id: existing.id },
      data: {
        status: 'APPROVED',
        approvedByUserId: approverId,
        approvedByEmail: approverEmail,
        approvedAt: todayLocal().toJSDate(),
        reason: reason || existing.reason || null,
      },
    });

    return {
      ok: true,
      status: (updated as any).status,
      finalMinutes: (updated as any).finalMinutes,
    };
  }

  async adminUnlockWeekly(params: {
    staffId: string;
    from: string;
    to: string;
    reason: string;
    ctx?: AdminCtx;
  }) {
    const { staffId, from, to, reason } = params;
    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');

    const ctx = normalizeCtx(params.ctx);
    this.ensureApprover(ctx);

    const existing = await this.prisma.officeWeeklyApproval.findUnique({
      where: {
        staffId_weekStart_weekEnd: {
          staffId,
          weekStart: range.weekStart.toJSDate(),
          weekEnd: range.weekEnd.toJSDate(),
        },
      },
      select: { id: true },
    });

    if (!existing) {
      return { ok: true, status: 'PENDING' };
    }

    const updated = await this.prisma.officeWeeklyApproval.update({
      where: { id: existing.id },
      data: {
        status: 'PENDING',
        approvedByUserId: null,
        approvedByEmail: null,
        approvedAt: null,
        reason: reason || null,
      },
    });

    return { ok: true, status: (updated as any).status };
  }
}
