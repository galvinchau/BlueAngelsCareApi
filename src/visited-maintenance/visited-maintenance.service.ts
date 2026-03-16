import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ScheduleStatus,
  VisitSource as PrismaVisitSource,
} from '@prisma/client';

type UiVisitStatus = 'OPEN' | 'COMPLETED' | 'CANCELED';
type UiVisitSource = 'SCHEDULE' | 'MOBILE' | 'MANUAL';

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

    return visits.map((visit) => {
      const plannedMinutes = diffMinutes(
        visit.scheduleShift?.plannedStart,
        visit.scheduleShift?.plannedEnd,
      );

      const actualMinutes =
        visit.durationMinutes ??
        diffMinutes(visit.checkInAt, visit.checkOutAt);

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
        serviceCode: visit.service?.serviceCode || visit.service?.serviceName || '—',

        plannedStart: toHmInNewYork(visit.scheduleShift?.plannedStart) || '—',
        plannedEnd: toHmInNewYork(visit.scheduleShift?.plannedEnd) || '—',

        checkIn: toHmInNewYork(visit.checkInAt),
        checkOut: toHmInNewYork(visit.checkOutAt),

        unitsPlanned: minutesToRoundedHourUnits(plannedMinutes),
        unitsActual:
          typeof visit.units === 'number'
            ? visit.units
            : minutesToRoundedHourUnits(actualMinutes),

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