import {
  BadRequestException,
  ForbiddenException,
  Injectable,
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

function normalizeCtx(ctx?: AdminCtx): AdminCtx {
  return {
    userType: (ctx?.userType || 'ADMIN').toString(),
    userEmail: (ctx?.userEmail || 'admin@local').toString(),
    userId: (ctx?.userId || 'admin').toString(),
  };
}

@Injectable()
export class TimeKeepingService {
  constructor(private readonly prisma: PrismaService) {}

  private ensureApprover(ctx: AdminCtx) {
    if (ctx.userType !== 'ADMIN' && ctx.userType !== 'HR') {
      throw new ForbiddenException('Only ADMIN/HR can approve time keeping.');
    }
  }

  // ---- Auto checkout logic (Mon–Fri 5:00 PM) ----
  private async applyAutoCheckoutIfNeeded(
    staffId: string,
    from: string,
    to: string,
  ) {
    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');
    const now = todayLocal();

    const open = await this.prisma.officeAttendanceEvent.findMany({
      where: {
        staffId,
        checkOutAt: null,
        checkInAt: {
          gte: range.weekStart.toJSDate(),
          lte: range.weekEnd.toJSDate(),
        },
      },
      orderBy: { checkInAt: 'desc' },
    });

    if (!open.length) return;

    for (const ev of open) {
      const inAt = DateTime.fromJSDate(ev.checkInAt).setZone(TZ);
      const weekday = inAt.weekday; // Mon=1 ... Sun=7
      const isSatSun = weekday === 6 || weekday === 7;

      // Weekend: do not auto-close here (policy blocks weekend check-in anyway)
      if (isSatSun) continue;

      // Auto-close at 5:00 PM same day if now passed it
      const closeAt = inAt.set({
        hour: 17,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
      if (now < closeAt) continue;

      const flags = Array.isArray(ev.flags) ? ev.flags : [];
      const newFlags = flags.includes('AUTO_CHECKOUT_5PM')
        ? flags
        : [...flags, 'AUTO_CHECKOUT_5PM'];

      await this.prisma.officeAttendanceEvent.update({
        where: { id: ev.id },
        data: {
          checkOutAt: closeAt.toJSDate(),
          flags: newFlags,
        },
      });
    }
  }

  async getStatus(params: { staffId: string; from: string; to: string }) {
    const { staffId, from, to } = params;

    await this.applyAutoCheckoutIfNeeded(staffId, from, to);

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

  async getAttendance(params: { staffId: string; from: string; to: string }) {
    const { staffId, from, to } = params;
    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');

    await this.applyAutoCheckoutIfNeeded(staffId, from, to);

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
    staffId: string;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    source: 'WEB' | 'MOBILE';
    clientTime?: string;

    // ✅ Option A: allow passing permission context (for future enforcement)
    ctx?: AdminCtx;
  }) {
    const { staffId, latitude, longitude, accuracy, source } = params;

    // (ctx currently unused; kept for type alignment + future rules)
    // const ctx = params.ctx ? normalizeCtx(params.ctx) : null;

    requireGPS(latitude, longitude, accuracy);

    const now = todayLocal();
    const weekday = now.weekday; // Mon=1..Sun=7
    const isWeekend = weekday === 6 || weekday === 7;

    // Policy: Office staff cannot work weekends -> block
    if (isWeekend) {
      throw new ForbiddenException(
        'Weekend check-in is not allowed for Office staff.',
      );
    }

    const open = await this.prisma.officeAttendanceEvent.findFirst({
      where: { staffId, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
    });

    if (open) {
      throw new BadRequestException(
        'Already checked in. Please check out first.',
      );
    }

    // lookup employee to cache staffName/email (optional)
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

    return { ok: true, id: created.id };
  }

  async checkOut(params: {
    staffId: string;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    source: 'WEB' | 'MOBILE';
    clientTime?: string;

    // ✅ Option A: allow passing permission context (for future enforcement)
    ctx?: AdminCtx;
  }) {
    const { staffId, latitude, longitude, accuracy } = params;

    // (ctx currently unused; kept for type alignment + future rules)
    // const ctx = params.ctx ? normalizeCtx(params.ctx) : null;

    requireGPS(latitude, longitude, accuracy);

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

    return { ok: true };
  }

  // =================== ADMIN/HR Approval ===================

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

    const approvals = await this.prisma.officeWeeklyApproval.findMany({
      where: {
        weekStart: range.weekStart.toJSDate(),
        weekEnd: range.weekEnd.toJSDate(),
        staffId: { in: staffIds },
      },
    });

    const appMap = new Map(approvals.map((a) => [a.staffId, a]));

    // compute minutes + flags count
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

    const rows = staffIds.map((staffId) => {
      const a = appMap.get(staffId);
      const c = agg.get(staffId) || { computedMinutes: 0, flagsCount: 0 };
      const meta = empMap.get(staffId) || { name: staffId, position: 'Office' };

      const finalMinutes =
        a?.finalMinutes ?? a?.adjustedMinutes ?? c.computedMinutes;

      return {
        staffId,
        name: meta.name,
        position: meta.position,
        computedMinutes: c.computedMinutes,
        adjustedMinutes: a?.adjustedMinutes ?? null,
        finalMinutes,
        status: (a?.status || 'PENDING') as 'PENDING' | 'APPROVED',
        approvedBy: a?.approvedByEmail ?? null,
        approvedAt: a?.approvedAt ? a.approvedAt.toISOString() : null,
        flagsCount: c.flagsCount,
      };
    });

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

    const approval = await this.prisma.officeWeeklyApproval.findUnique({
      where: {
        staffId_weekStart_weekEnd: {
          staffId,
          weekStart: range.weekStart.toJSDate(),
          weekEnd: range.weekEnd.toJSDate(),
        },
      },
    });

    const name = emp ? `${emp.firstName} ${emp.lastName}` : staffId;
    const position = emp?.role || 'Office';

    const finalMinutes =
      approval?.finalMinutes ?? approval?.adjustedMinutes ?? computedMinutes;

    const row = {
      staffId,
      name,
      position,
      computedMinutes,
      adjustedMinutes: approval?.adjustedMinutes ?? null,
      finalMinutes,
      status: (approval?.status || 'PENDING') as 'PENDING' | 'APPROVED',
      approvedBy: approval?.approvedByEmail ?? null,
      approvedAt: approval?.approvedAt
        ? approval.approvedAt.toISOString()
        : null,
      flagsCount,
    };

    return { row, attendance };
  }

  async adminAdjustWeekly(params: {
    staffId: string;
    from: string;
    to: string;
    adjustedMinutes: number;
    reason: string;
    ctx?: AdminCtx;
  }) {
    const { staffId, from, to, adjustedMinutes, reason } = params;
    const range = weekStartEnd(from, to);
    if (!range) throw new BadRequestException('Invalid from/to');

    const ctx = normalizeCtx(params.ctx);
    this.ensureApprover(ctx);

    // Compute again (source of truth)
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

    const finalMinutes = adjustedMinutes;

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
        adjustedMinutes,
        finalMinutes,
        reason: reason || null,
      },
      create: {
        staffId,
        weekStart: range.weekStart.toJSDate(),
        weekEnd: range.weekEnd.toJSDate(),
        computedMinutes,
        adjustedMinutes,
        finalMinutes,
        status: 'PENDING',
        reason: reason || null,
      },
    });

    return {
      ok: true,
      computedMinutes: up.computedMinutes,
      adjustedMinutes: up.adjustedMinutes,
      finalMinutes: up.finalMinutes,
      status: up.status,
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

    const existing = await this.prisma.officeWeeklyApproval.findUnique({
      where: {
        staffId_weekStart_weekEnd: {
          staffId,
          weekStart: range.weekStart.toJSDate(),
          weekEnd: range.weekEnd.toJSDate(),
        },
      },
    });

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
        },
      });

      return {
        ok: true,
        status: created.status,
        finalMinutes: created.finalMinutes,
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
      status: updated.status,
      finalMinutes: updated.finalMinutes,
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

    return { ok: true, status: updated.status };
  }
}
