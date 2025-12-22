// src/reports/reports.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateTime } from 'luxon';

const TZ = 'America/New_York';

export type DailyNotesFilter = {
  from?: string;
  to?: string;
  staffId?: string;
  individualId?: string;
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private toLocalISODate(d: Date): string {
    return (
      DateTime.fromJSDate(d, { zone: 'utc' }).setZone(TZ).toISODate() ?? ''
    );
  }

  private normalizeDateInput(v?: string): string | undefined {
    // Expect YYYY-MM-DD from UI; accept empty
    if (!v) return undefined;
    const s = String(v).trim();
    if (!s) return undefined;
    return s;
  }

  async getDailyNotes(filter: DailyNotesFilter) {
    const from = this.normalizeDateInput(filter.from);
    const to = this.normalizeDateInput(filter.to);

    // Use date range on dn.date (stored as Date)
    // We interpret from/to as local dates in America/New_York and convert to UTC bounds.
    let gte: Date | undefined;
    let lt: Date | undefined;

    if (from) {
      const startLocal = DateTime.fromISO(from, { zone: TZ }).startOf('day');
      gte = startLocal.toUTC().toJSDate();
    }

    if (to) {
      const endLocalExclusive = DateTime.fromISO(to, { zone: TZ })
        .plus({ days: 1 })
        .startOf('day');
      lt = endLocalExclusive.toUTC().toJSDate();
    }

    const where: any = {};
    if (gte || lt)
      where.date = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
    if (filter.staffId) where.staffId = filter.staffId;
    if (filter.individualId) where.individualId = filter.individualId;

    const items = await this.prisma.dailyNote.findMany({
      where,
      orderBy: { date: 'desc' },
      select: {
        id: true,
        date: true,
        staffId: true,
        staffName: true,
        individualId: true,
        individualName: true,
        serviceCode: true,
        serviceName: true,
        scheduleStart: true,
        scheduleEnd: true,
        visitStart: true,
        visitEnd: true,
        mileage: true,
        isCanceled: true,
        cancelReason: true,

        // file paths (may be null)
        staffReportDocPath: true,
        staffReportPdfPath: true,
        individualReportDocPath: true,
        individualReportPdfPath: true,
      },
    });

    // keep API response stable for web UI
    return items.map((x) => ({
      ...x,
      dateLocal: x.date ? this.toLocalISODate(x.date) : '',
    }));
  }

  /**
   * Detail used by Web preview page
   * GET /reports/daily-notes/:id
   */
  async getDailyNoteDetail(id: string) {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id },
      select: {
        id: true,
        date: true,
        staffId: true,
        staffName: true,
        individualId: true,
        individualName: true,
        serviceCode: true,
        serviceName: true,
        scheduleStart: true,
        scheduleEnd: true,
        visitStart: true,
        visitEnd: true,
        mileage: true,
        isCanceled: true,
        cancelReason: true,
        payload: true,

        staffReportDocPath: true,
        staffReportPdfPath: true,
        individualReportDocPath: true,
        individualReportPdfPath: true,
      },
    });

    if (!dn) return null;

    return {
      ...dn,
      dateLocal: dn.date ? this.toLocalISODate(dn.date) : '',
    };
  }

  /**
   * Minimal payload for download generation/filename
   * used by ReportsController download endpoint
   */
  async getDailyNoteForDownload(id: string) {
    const dn = await this.prisma.dailyNote.findUnique({
      where: { id },
      select: {
        id: true,
        date: true,
        staffId: true,
        staffName: true,
        individualId: true,
        individualName: true,
        serviceCode: true,
        serviceName: true,
        scheduleStart: true,
        scheduleEnd: true,
        visitStart: true,
        visitEnd: true,
        mileage: true,
        isCanceled: true,
        cancelReason: true,
        payload: true,

        staffReportDocPath: true,
        staffReportPdfPath: true,
        individualReportDocPath: true,
        individualReportPdfPath: true,
      },
    });

    if (!dn) return null;
    return dn;
  }
}
