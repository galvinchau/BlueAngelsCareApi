// src/reports/reports.service.ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';

export interface DailyNotesFilter {
  from?: string;
  to?: string;
  staffId?: string;
  individualId?: string;
}

export type DailyNoteReportItem = {
  id: string;
  date: Date;

  individualId: string;
  individualName?: string | null;

  staffId: string;
  staffName?: string | null;

  serviceCode?: string | null;
  serviceName?: string | null;

  scheduleStart?: string | null;
  scheduleEnd?: string | null;

  visitStart?: string | null;
  visitEnd?: string | null;

  mileage?: number | null;
  isCanceled?: boolean | null;
  cancelReason?: string | null;

  // legacy (existing)
  staffReportFileId?: string | null;
  individualReportFileId?: string | null;

  // new (for UI DOC|PDF)
  staffReportDocFileId: string | null;
  staffReportPdfFileId: string | null;
  individualReportDocFileId: string | null;
  individualReportPdfFileId: string | null;
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getDailyNotes(
    filter: DailyNotesFilter,
  ): Promise<DailyNoteReportItem[]> {
    const where: Prisma.DailyNoteWhereInput = {};

    if (filter.staffId) where.staffId = filter.staffId;
    if (filter.individualId) where.individualId = filter.individualId;

    if (filter.from || filter.to) {
      const dateCond: Prisma.DateTimeFilter = {};

      if (filter.from) {
        dateCond.gte = DateTime.fromISO(filter.from, {
          zone: 'America/New_York',
        })
          .startOf('day')
          .toJSDate();
      }

      if (filter.to) {
        dateCond.lte = DateTime.fromISO(filter.to, { zone: 'America/New_York' })
          .endOf('day')
          .toJSDate();
      }

      where.date = dateCond;
    }

    // IMPORTANT: select only lightweight fields (NO payload/signatures)
    const rows = await this.prisma.dailyNote.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        date: true,

        individualId: true,
        individualName: true,

        staffId: true,
        staffName: true,

        serviceCode: true,
        serviceName: true,

        scheduleStart: true,
        scheduleEnd: true,

        visitStart: true,
        visitEnd: true,

        mileage: true,
        isCanceled: true,
        cancelReason: true,

        staffReportFileId: true,
        individualReportFileId: true,
      },
    });

    return rows.map((n) => {
      const legacyStaff = n.staffReportFileId ?? null;
      const legacyInd = n.individualReportFileId ?? null;

      return {
        ...n,

        // new fields (UI will use these)
        staffReportDocFileId: null,
        staffReportPdfFileId: legacyStaff,

        individualReportDocFileId: null,
        individualReportPdfFileId: legacyInd,
      };
    });
  }
}
