import { Injectable } from '@nestjs/common';
import {
  BillingPayer,
  ScheduleStatus,
  VisitSource as PrismaVisitSource,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type UiVisitStatus = 'OPEN' | 'COMPLETED' | 'CANCELED';
type UiVisitSource = 'SCHEDULE' | 'MOBILE' | 'MANUAL';
type UiRateStatus = 'FOUND' | 'MISSING';

type RateLite = {
  id: string;
  serviceId: string;
  rate: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
};

function toPartsInTimeZone(date: Date | null | undefined, timeZone: string) {
  if (!date) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function toIsoDateInNewYork(date: Date | null | undefined) {
  const p = toPartsInTimeZone(date, 'America/New_York');
  if (!p) return '';
  return `${p.year}-${p.month}-${p.day}`;
}

function toHmInNewYork(date: Date | null | undefined) {
  const p = toPartsInTimeZone(date, 'America/New_York');
  if (!p) return null;
  return `${p.hour}:${p.minute}`;
}

function diffMinutes(start: Date | null | undefined, end: Date | null | undefined) {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  return Math.max(0, Math.round(ms / 60000));
}

function minutesToRoundedHourUnits(minutes: number | null | undefined) {
  if (minutes == null) return 0;
  return Math.round(minutes / 60);
}

function buildFullName(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(' ').trim() || '—';
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class VisitedMaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  private mapSource(source: PrismaVisitSource): UiVisitSource {
    switch (source) {
      case PrismaVisitSource.MOBILE:
        return 'MOBILE';
      case PrismaVisitSource.OFFICE_EDIT:
        return 'MANUAL';
      case PrismaVisitSource.AUTO_MATCH:
      default:
        return 'SCHEDULE';
    }
  }

  private mapStatus(params: {
    shiftStatus?: ScheduleStatus | null;
    checkInAt?: Date | null;
    checkOutAt?: Date | null;
  }): UiVisitStatus {
    if (params.shiftStatus === ScheduleStatus.CANCELLED) {
      return 'CANCELED';
    }

    if (params.checkInAt && params.checkOutAt) {
      return 'COMPLETED';
    }

    return 'OPEN';
  }

  /**
   * Convert any timestamp to a stable "service day anchor" in America/New_York.
   * We intentionally anchor to 12:00 PM local day to avoid edge cases caused by:
   * - effectiveFrom stored at 00:00:00
   * - effectiveTo stored at 23:59:59.999
   * - visit check-in happening at arbitrary hours
   *
   * This keeps date-based matching stable without hardcoding any business date.
   */
  private toServiceDayAnchor(date?: Date | null): Date | null {
    if (!date) return null;

    const isoDate = toIsoDateInNewYork(date);
    if (!isoDate) return null;

    return new Date(`${isoDate}T12:00:00`);
  }

  private pickEffectiveRate(
    rateMap: Map<string, RateLite[]>,
    serviceId?: string | null,
    visitDate?: Date | null,
  ): RateLite | null {
    if (!serviceId || !visitDate) return null;

    const candidates = rateMap.get(serviceId) || [];
    if (!candidates.length) return null;

    for (const row of candidates) {
      const startsOk = row.effectiveFrom.getTime() <= visitDate.getTime();
      const endsOk =
        !row.effectiveTo || row.effectiveTo.getTime() >= visitDate.getTime();

      if (startsOk && endsOk) {
        return row;
      }
    }

    return null;
  }

  async listVisits() {
    const visits = await this.prisma.visit.findMany({
      orderBy: { checkInAt: 'desc' },
      include: {
        individual: {
          select: {
            firstName: true,
            middleName: true,
            lastName: true,
          },
        },
        dsp: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        service: {
          select: {
            id: true,
            serviceCode: true,
            serviceName: true,
          },
        },
        scheduleShift: {
          select: {
            id: true,
            scheduleDate: true,
            plannedStart: true,
            plannedEnd: true,
            status: true,
            cancelReason: true,
          },
        },
      },
    });

    const visitIds = visits.map((v) => v.id);

    const noteLinks =
      visitIds.length > 0
        ? await this.prisma.dailyNote.findMany({
            where: {
              visitId: { in: visitIds },
            },
            select: {
              visitId: true,
            },
          })
        : [];

    const linkedVisitIds = new Set(
      noteLinks.map((x) => x.visitId).filter((x): x is string => Boolean(x)),
    );

    // Load rates one time only to avoid connection-pool pressure
    const serviceIds = Array.from(
      new Set(
        visits.map((v) => v.service?.id).filter((x): x is string => Boolean(x)),
      ),
    );

    const rateRows =
      serviceIds.length > 0
        ? await this.prisma.serviceRate.findMany({
            where: {
              payer: BillingPayer.ODP,
              isActive: true,
              serviceId: { in: serviceIds },
            },
            select: {
              id: true,
              serviceId: true,
              rate: true,
              effectiveFrom: true,
              effectiveTo: true,
              isActive: true,
            },
            orderBy: [{ serviceId: 'asc' }, { effectiveFrom: 'desc' }],
          })
        : [];

    const rateMap = new Map<string, RateLite[]>();
    for (const row of rateRows) {
      const arr = rateMap.get(row.serviceId) || [];
      arr.push(row);
      rateMap.set(row.serviceId, arr);
    }

    return visits.map((visit) => {
      const plannedMinutes = diffMinutes(
        visit.scheduleShift?.plannedStart,
        visit.scheduleShift?.plannedEnd,
      );

      const actualMinutes =
        visit.durationMinutes ?? diffMinutes(visit.checkInAt, visit.checkOutAt);

      const unitsActual =
        typeof visit.units === 'number'
          ? visit.units
          : minutesToRoundedHourUnits(actualMinutes);

      const rawVisitDate =
        visit.checkInAt ?? visit.scheduleShift?.scheduleDate ?? null;

      const visitDateForRate = this.toServiceDayAnchor(rawVisitDate);

      const effectiveRate = this.pickEffectiveRate(
        rateMap,
        visit.service?.id ?? null,
        visitDateForRate,
      );

      const rate =
        effectiveRate && typeof effectiveRate.rate === 'number'
          ? effectiveRate.rate
          : 0;

      const amount = roundMoney(unitsActual * rate);
      const rateStatus: UiRateStatus = effectiveRate ? 'FOUND' : 'MISSING';

      return {
        id: visit.id,
        date:
          toIsoDateInNewYork(visit.scheduleShift?.scheduleDate) ||
          toIsoDateInNewYork(visit.checkInAt) ||
          '',

        individualName: buildFullName([
          visit.individual.firstName,
          visit.individual.middleName,
          visit.individual.lastName,
        ]),

        dspName: buildFullName([visit.dsp.firstName, visit.dsp.lastName]),

        serviceId: visit.service?.id ?? null,
        serviceCode:
          visit.service?.serviceCode || visit.service?.serviceName || '—',
        serviceName: visit.service?.serviceName || '—',

        payer: BillingPayer.ODP,

        plannedStart: toHmInNewYork(visit.scheduleShift?.plannedStart) || '—',
        plannedEnd: toHmInNewYork(visit.scheduleShift?.plannedEnd) || '—',

        checkIn: toHmInNewYork(visit.checkInAt),
        checkOut: toHmInNewYork(visit.checkOutAt),

        unitsPlanned: minutesToRoundedHourUnits(plannedMinutes),
        unitsActual,

        rate,
        amount,
        rateStatus,
        rateEffectiveFrom: effectiveRate?.effectiveFrom ?? null,
        rateEffectiveTo: effectiveRate?.effectiveTo ?? null,

        status: this.mapStatus({
          shiftStatus: visit.scheduleShift?.status,
          checkInAt: visit.checkInAt,
          checkOutAt: visit.checkOutAt,
        }),

        cancelReason: visit.scheduleShift?.cancelReason ?? null,
        source: this.mapSource(visit.source),
        noteLinked: linkedVisitIds.has(visit.id),
        reviewed: Boolean(visit.reviewedAt),
      };
    });
  }

  async markReviewed(id: string) {
    const now = new Date();

    const updated = await this.prisma.visit.update({
      where: { id },
      data: {
        reviewedAt: now,
      },
      select: {
        id: true,
        reviewedAt: true,
      },
    });

    return {
      id: updated.id,
      reviewed: Boolean(updated.reviewedAt),
      reviewedAt: updated.reviewedAt,
    };
  }

  async markReviewedBulk(visitIds: string[]) {
    const ids = Array.from(new Set((visitIds || []).filter(Boolean)));

    if (!ids.length) {
      return { count: 0 };
    }

    const now = new Date();

    const result = await this.prisma.visit.updateMany({
      where: {
        id: { in: ids },
      },
      data: {
        reviewedAt: now,
      },
    });

    return {
      count: result.count,
      reviewedAt: now,
    };
  }
}