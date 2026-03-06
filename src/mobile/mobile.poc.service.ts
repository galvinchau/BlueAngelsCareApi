// src/mobile/mobile.poc.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type TaskStatus = 'INDEPENDENT' | 'VERBAL_PROMPT' | 'PHYSICAL_ASSIST' | 'REFUSED';
type LogStatus = 'DRAFT' | 'SUBMITTED';

function startOfDayLocal(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map((x) => Number(x));
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}
function endOfDayLocal(dateStr: string) {
  const s = startOfDayLocal(dateStr);
  return new Date(s.getFullYear(), s.getMonth(), s.getDate(), 23, 59, 59, 999);
}

function isIsoDateOnly(s?: string) {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

type TableRef = { schema: string; table: string }; // table is exact case from DB
type PocMeta = {
  tables: {
    poc: TableRef;
    duty: TableRef;
    dailyLog: TableRef;
    taskLog: TableRef;
  };
  columns: {
    poc: {
      id: string;
      individualId: string;
      pocNumber?: string;
      start: string;
      end?: string; // ✅ CHANGED: optional (DB may not have enddate)
      status?: string;
      createdAt: string;
    };
    duty: {
      id: string;
      pocId: string;
      category?: string;
      taskNo?: string;
      duty?: string;
      minutes?: string;
      asNeeded?: string;
      timesWeekMin?: string;
      timesWeekMax?: string;
      daysOfWeek?: string;
      instruction?: string;
      sortOrder?: string;
    };
    dailyLog: {
      id: string;
      pocId: string;
      individualId: string;
      dspId?: string;
      date: string;
      status: string;
      submittedAt?: string;
      createdAt?: string;
      updatedAt?: string;
      scheduleShiftId?: string;
    };
    taskLog: {
      id: string;
      dailyLogId: string;
      pocDutyId: string;
      completionStatus: string;
      completedAt?: string;
      note?: string;
      createdAt?: string;
      updatedAt?: string;
    };
  };
};

// safe quote identifiers with exact case
function qIdent(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}
function qTable(t: TableRef) {
  return `${qIdent(t.schema)}.${qIdent(t.table)}`;
}

@Injectable()
export class MobilePocService {
  constructor(private readonly prisma: PrismaService) {}

  // cache meta lookup to avoid re-querying info_schema every call
  private metaPromise: Promise<PocMeta> | null = null;

  private async resolveShiftOrThrow(shiftId: string) {
    if (!shiftId?.trim()) throw new BadRequestException('shiftId is required');

    const shift = await this.prisma.scheduleShift.findUnique({
      where: { id: shiftId },
      select: {
        id: true,
        individualId: true,
        scheduleDate: true,
        plannedStart: true,
        plannedEnd: true,
        plannedDspId: true,
        actualDspId: true,
        serviceId: true,
        status: true,
      },
    });

    if (!shift) throw new NotFoundException(`ScheduleShift not found: ${shiftId}`);
    return shift;
  }

  private async getMeta(): Promise<PocMeta> {
    if (this.metaPromise) return this.metaPromise;

    this.metaPromise = (async () => {
      const schema = 'public';

      // ✅ CHANGED: resolve actual table names safely (avoid ANY($2) array binding issues)
      const findTable = async (candidates: string[]): Promise<TableRef> => {
        for (const c of candidates) {
          const rows = (await this.prisma.$queryRawUnsafe(
            `
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_schema = $1
              AND table_name ILIKE $2
            LIMIT 1
          `,
            schema,
            c,
          )) as Array<{ table_schema: string; table_name: string }>;

          if (rows?.[0]) return { schema: rows[0].table_schema, table: rows[0].table_name };
        }

        throw new Error(
          `POC tables not found. Checked: ${candidates.join(', ')} in schema ${schema}`,
        );
      };

      const poc = await findTable(['poc', 'POC', 'Poc']);
      const duty = await findTable(['poc_duty', 'POC_Duty', 'pocDuty']);
      const dailyLog = await findTable(['poc_daily_log', 'POC_Daily_Log', 'pocDailyLog']);
      const taskLog = await findTable([
        'poc_daily_task_log',
        'POC_Daily_Task_Log',
        'pocDailyTaskLog',
      ]);

      // 2) resolve column names for each table
      const colsOf = async (t: TableRef) => {
        const rows = (await this.prisma.$queryRawUnsafe(
          `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
        `,
          t.schema,
          t.table,
        )) as Array<{ column_name: string }>;
        return rows.map((r) => r.column_name);
      };

      const pick = (cols: string[], candidates: string[], label: string) => {
        for (const c of candidates) {
          if (cols.includes(c)) return c;
        }
        throw new Error(`Missing column "${label}". Candidates: ${candidates.join(', ')}.`);
      };

      const pickOptional = (cols: string[], candidates: string[]) => {
        for (const c of candidates) {
          if (cols.includes(c)) return c;
        }
        return undefined;
      };

      const pocCols = await colsOf(poc);
      const dutyCols = await colsOf(duty);
      const dailyCols = await colsOf(dailyLog);
      const taskCols = await colsOf(taskLog);

      return {
        tables: { poc, duty, dailyLog, taskLog },
        columns: {
          poc: {
            id: pick(pocCols, ['id'], 'poc.id'),
            individualId: pick(pocCols, ['individualid', 'individualId'], 'poc.individualId'),
            pocNumber: pocCols.includes('pocnumber')
              ? 'pocnumber'
              : pocCols.includes('pocNumber')
                ? 'pocNumber'
                : undefined,
            start: pick(
              pocCols,
              ['startdate', 'startDate', 'start_date'],
              'poc.startDate',
            ),
            // ✅ CHANGED: end is optional (do NOT crash if missing)
            end: pickOptional(pocCols, ['enddate', 'endDate', 'end_date']),
            status: pocCols.includes('status') ? 'status' : undefined,
            createdAt: pick(
              pocCols,
              ['createdat', 'createdAt', 'created_at'],
              'poc.createdAt',
            ),
          },
          duty: {
            id: pick(dutyCols, ['id'], 'duty.id'),
            pocId: pick(dutyCols, ['pocid', 'pocId'], 'duty.pocId'),
            category: dutyCols.includes('category') ? 'category' : undefined,
            taskNo: dutyCols.includes('taskno')
              ? 'taskno'
              : dutyCols.includes('taskNo')
                ? 'taskNo'
                : undefined,
            duty: dutyCols.includes('duty') ? 'duty' : undefined,
            minutes: dutyCols.includes('minutes') ? 'minutes' : undefined,
            asNeeded: dutyCols.includes('asneeded')
              ? 'asneeded'
              : dutyCols.includes('asNeeded')
                ? 'asNeeded'
                : undefined,
            timesWeekMin: dutyCols.includes('timesweekmin')
              ? 'timesweekmin'
              : dutyCols.includes('timesWeekMin')
                ? 'timesWeekMin'
                : undefined,
            timesWeekMax: dutyCols.includes('timesweekmax')
              ? 'timesweekmax'
              : dutyCols.includes('timesWeekMax')
                ? 'timesWeekMax'
                : undefined,
            daysOfWeek: dutyCols.includes('daysofweek')
              ? 'daysofweek'
              : dutyCols.includes('daysOfWeek')
                ? 'daysOfWeek'
                : undefined,
            instruction: dutyCols.includes('instruction') ? 'instruction' : undefined,
            sortOrder: dutyCols.includes('sortorder')
              ? 'sortorder'
              : dutyCols.includes('sortOrder')
                ? 'sortOrder'
                : undefined,
          },
          dailyLog: {
            id: pick(dailyCols, ['id'], 'dailyLog.id'),
            pocId: pick(dailyCols, ['pocid', 'pocId'], 'dailyLog.pocId'),
            individualId: pick(
              dailyCols,
              ['individualid', 'individualId'],
              'dailyLog.individualId',
            ),
            dspId: dailyCols.includes('dspid')
              ? 'dspid'
              : dailyCols.includes('dspId')
                ? 'dspId'
                : undefined,
            date: pick(dailyCols, ['date'], 'dailyLog.date'),
            status: pick(dailyCols, ['status'], 'dailyLog.status'),
            submittedAt: dailyCols.includes('submittedat')
              ? 'submittedat'
              : dailyCols.includes('submittedAt')
                ? 'submittedAt'
                : undefined,
            createdAt: dailyCols.includes('createdat')
              ? 'createdat'
              : dailyCols.includes('createdAt')
                ? 'createdAt'
                : dailyCols.includes('created_at')
                  ? 'created_at'
                  : undefined,
            updatedAt: dailyCols.includes('updatedat')
              ? 'updatedat'
              : dailyCols.includes('updatedAt')
                ? 'updatedAt'
                : dailyCols.includes('updated_at')
                  ? 'updated_at'
                  : undefined,
            scheduleShiftId: dailyCols.includes('scheduleshiftid')
              ? 'scheduleshiftid'
              : dailyCols.includes('scheduleShiftId')
                ? 'scheduleShiftId'
                : undefined,
          },
          taskLog: {
            id: pick(taskCols, ['id'], 'taskLog.id'),
            dailyLogId: pick(taskCols, ['dailylogid', 'dailyLogId'], 'taskLog.dailyLogId'),
            pocDutyId: pick(taskCols, ['pocdutyid', 'pocDutyId'], 'taskLog.pocDutyId'),
            completionStatus: pick(
              taskCols,
              ['completionstatus', 'completionStatus'],
              'taskLog.completionStatus',
            ),
            completedAt: taskCols.includes('completedat')
              ? 'completedat'
              : taskCols.includes('completedAt')
                ? 'completedAt'
                : undefined,
            note: taskCols.includes('note') ? 'note' : undefined,
            createdAt: taskCols.includes('createdat')
              ? 'createdat'
              : taskCols.includes('createdAt')
                ? 'createdAt'
                : taskCols.includes('created_at')
                  ? 'created_at'
                  : undefined,
            updatedAt: taskCols.includes('updatedat')
              ? 'updatedat'
              : taskCols.includes('updatedAt')
                ? 'updatedAt'
                : taskCols.includes('updated_at')
                  ? 'updated_at'
                  : undefined,
          },
        },
      };
    })()
      .catch((e) => {
        // ✅ allow retry if meta resolution fails once
        this.metaPromise = null;
        throw e;
      });

    return this.metaPromise;
  }

  private async findActivePocOrNull(individualId: string, at: Date) {
    const meta = await this.getMeta();

    const T = qTable(meta.tables.poc);
    const c = meta.columns.poc;

    // ✅ CHANGED: if end column missing, treat as open-ended
    const endClause = c.end
      ? `AND (
          ${qIdent(c.end)} IS NULL
          OR ${qIdent(c.end)} >= $2
        )`
      : ``;

    const q = `
      SELECT *
      FROM ${T}
      WHERE ${qIdent(c.individualId)} = $1
        AND ${qIdent(c.start)} <= $2
        ${endClause}
      ORDER BY ${qIdent(c.createdAt)} DESC
      LIMIT 1
    `;

    const rows = (await this.prisma.$queryRawUnsafe(q, individualId, at)) as any[];
    return rows?.[0] ?? null;
  }

  /**
   * GET duties by shiftId
   * - shiftId -> individualId -> active POC -> duties
   */
  async getDutiesByShiftId(shiftId?: string) {
    const sid = String(shiftId || '').trim();
    if (!sid) throw new BadRequestException('shiftId is required');

    const shift = await this.resolveShiftOrThrow(sid);
    const meta = await this.getMeta();

    // date anchor (use shift.scheduleDate if present, else now)
    const at = shift.scheduleDate ? new Date(shift.scheduleDate) : new Date();

    const poc = await this.findActivePocOrNull(shift.individualId, at);
    if (!poc) {
      return {
        shiftId: sid,
        individualId: shift.individualId,
        poc: null,
        duties: [],
        note: 'No active POC found for this Individual at this date.',
      };
    }

    const dutyT = qTable(meta.tables.duty);
    const d = meta.columns.duty;

    const dutyRows = (await this.prisma.$queryRawUnsafe(
      `
      SELECT *
      FROM ${dutyT}
      WHERE ${qIdent(d.pocId)} = $1
      ORDER BY ${d.sortOrder ? qIdent(d.sortOrder) : qIdent(d.id)} ASC
    `,
      poc[meta.columns.poc.id],
    )) as any[];

    const duties = dutyRows.map((r) => ({
      id: r[d.id],
      pocId: r[d.pocId],
      category: d.category ? r[d.category] : null,
      taskNo: d.taskNo ? r[d.taskNo] : null,
      duty: d.duty ? r[d.duty] : null,
      minutes: d.minutes ? r[d.minutes] : null,
      asNeeded: d.asNeeded ? r[d.asNeeded] : null,
      timesWeekMin: d.timesWeekMin ? r[d.timesWeekMin] : null,
      timesWeekMax: d.timesWeekMax ? r[d.timesWeekMax] : null,
      daysOfWeek: d.daysOfWeek ? r[d.daysOfWeek] : null,
      instruction: d.instruction ? r[d.instruction] : null,
      sortOrder: d.sortOrder ? r[d.sortOrder] : null,
    }));

    return {
      shiftId: sid,
      individualId: shift.individualId,
      poc: {
        id: poc[meta.columns.poc.id],
        pocNumber: meta.columns.poc.pocNumber ? poc[meta.columns.poc.pocNumber] : null,
        start: poc[meta.columns.poc.start],
        // ✅ CHANGED: end might be missing
        end: meta.columns.poc.end ? poc[meta.columns.poc.end] : null,
        status: meta.columns.poc.status ? poc[meta.columns.poc.status] : null,
      },
      duties,
    };
  }

  /**
   * GET daily log by shiftId + date
   * - returns: status + items (per duty)
   */
  async getDailyLog(shiftId?: string, date?: string) {
    const sid = String(shiftId || '').trim();
    if (!sid) throw new BadRequestException('shiftId is required');

    const shift = await this.resolveShiftOrThrow(sid);
    const meta = await this.getMeta();

    const dateStr =
      (isIsoDateOnly(date) ? date : null) ?? new Date().toISOString().slice(0, 10);

    const dayStart = startOfDayLocal(dateStr);
    const dayEnd = endOfDayLocal(dateStr);

    const poc = await this.findActivePocOrNull(shift.individualId, dayStart);
    if (!poc) {
      return {
        shiftId: sid,
        individualId: shift.individualId,
        date: dateStr,
        status: 'DRAFT' as LogStatus,
        dailyLogId: null,
        items: [],
        note: 'No active POC found, so no daily log.',
      };
    }

    // load duties
    const dutiesRes = await this.getDutiesByShiftId(sid);
    const duties = dutiesRes.duties || [];

    // find existing daily log row in that day range
    const dlT = qTable(meta.tables.dailyLog);
    const dl = meta.columns.dailyLog;

    const dlRows = (await this.prisma.$queryRawUnsafe(
      `
      SELECT *
      FROM ${dlT}
      WHERE ${qIdent(dl.pocId)} = $1
        AND ${qIdent(dl.individualId)} = $2
        AND ${qIdent(dl.date)} >= $3
        AND ${qIdent(dl.date)} <= $4
      ORDER BY ${dl.createdAt ? qIdent(dl.createdAt) : qIdent(dl.id)} DESC
      LIMIT 1
    `,
      poc[meta.columns.poc.id],
      shift.individualId,
      dayStart,
      dayEnd,
    )) as any[];

    const dailyLog = dlRows?.[0] ?? null;

    // load task logs if dailyLog exists
    const tlT = qTable(meta.tables.taskLog);
    const tl = meta.columns.taskLog;

    let taskLogs: any[] = [];
    if (dailyLog) {
      taskLogs = (await this.prisma.$queryRawUnsafe(
        `
        SELECT *
        FROM ${tlT}
        WHERE ${qIdent(tl.dailyLogId)} = $1
      `,
        dailyLog[dl.id],
      )) as any[];
    }

    const mapByDutyId = new Map<string, any>();
    for (const row of taskLogs) {
      mapByDutyId.set(String(row[tl.pocDutyId]), row);
    }

    const items = duties.map((duty: any) => {
      const log = mapByDutyId.get(String(duty.id));
      return {
        pocDutyId: duty.id,
        taskNo: duty.taskNo ?? null,
        category: duty.category ?? null,
        duty: duty.duty ?? null,

        completionStatus: log ? (log[tl.completionStatus] as TaskStatus) : null,
        note: log && tl.note ? (log[tl.note] as string) : null,
        timestamp:
          log && tl.completedAt && log[tl.completedAt]
            ? new Date(log[tl.completedAt]).toISOString()
            : null,
      };
    });

    return {
      shiftId: sid,
      individualId: shift.individualId,
      date: dateStr,
      pocId: poc[meta.columns.poc.id],
      dailyLogId: dailyLog ? dailyLog[dl.id] : null,
      status: dailyLog ? (dailyLog[dl.status] as LogStatus) : ('DRAFT' as LogStatus),
      items,
    };
  }

  /**
   * POST save daily log
   * body:
   *  - shiftId (required)
   *  - date (YYYY-MM-DD required)
   *  - status: DRAFT|SUBMITTED
   *  - dspId, dspName (optional)
   *  - items: [{ pocDutyId, completionStatus, note, timestamp? }]
   */
  async saveDailyLog(body: any) {
    const shiftId = String(body?.shiftId || '').trim();
    const dateStr = String(body?.date || '').trim();
    const status = String(body?.status || 'DRAFT').trim() as LogStatus;

    if (!shiftId) throw new BadRequestException('shiftId is required');
    if (!isIsoDateOnly(dateStr)) throw new BadRequestException('date must be YYYY-MM-DD');

    const shift = await this.resolveShiftOrThrow(shiftId);
    const meta = await this.getMeta();

    const dayStart = startOfDayLocal(dateStr);
    const dayEnd = endOfDayLocal(dateStr);

    const poc = await this.findActivePocOrNull(shift.individualId, dayStart);
    if (!poc) {
      throw new BadRequestException('No active POC for this Individual/date');
    }

    const dlT = qTable(meta.tables.dailyLog);
    const dl = meta.columns.dailyLog;

    // find existing daily log
    const existingRows = (await this.prisma.$queryRawUnsafe(
      `
      SELECT *
      FROM ${dlT}
      WHERE ${qIdent(dl.pocId)} = $1
        AND ${qIdent(dl.individualId)} = $2
        AND ${qIdent(dl.date)} >= $3
        AND ${qIdent(dl.date)} <= $4
      ORDER BY ${dl.createdAt ? qIdent(dl.createdAt) : qIdent(dl.id)} DESC
      LIMIT 1
    `,
      poc[meta.columns.poc.id],
      shift.individualId,
      dayStart,
      dayEnd,
    )) as any[];

    let dailyLogId: string;

    const now = new Date();
    const dspId = body?.dspId ? String(body.dspId) : null;

    if (!existingRows?.[0]) {
      // INSERT new daily log
      const cols: string[] = [dl.pocId, dl.individualId, dl.date, dl.status];
      const vals: any[] = [
        poc[meta.columns.poc.id],
        shift.individualId,
        dayStart,
        status,
      ];

      if (dl.dspId && dspId) {
        cols.push(dl.dspId);
        vals.push(dspId);
      }
      if (dl.scheduleShiftId) {
        cols.push(dl.scheduleShiftId);
        vals.push(shiftId);
      }
      if (dl.submittedAt && status === 'SUBMITTED') {
        cols.push(dl.submittedAt);
        vals.push(now);
      }

      const colSql = cols.map(qIdent).join(', ');
      const valSql = vals.map((_, i) => `$${i + 1}`).join(', ');

      const inserted = (await this.prisma.$queryRawUnsafe(
        `
        INSERT INTO ${dlT} (${colSql})
        VALUES (${valSql})
        RETURNING ${qIdent(dl.id)}
      `,
        ...vals,
      )) as any[];

      dailyLogId = String(inserted?.[0]?.[dl.id]);
    } else {
      dailyLogId = String(existingRows[0][dl.id]);

      // UPDATE daily log status (+ submittedAt)
      const sets: string[] = [`${qIdent(dl.status)} = $2`];
      const params: any[] = [dailyLogId, status];
      let idx = 3;

      if (dl.submittedAt) {
        if (status === 'SUBMITTED') {
          sets.push(`${qIdent(dl.submittedAt)} = $${idx++}`);
          params.push(now);
        }
      }
      if (dl.updatedAt) {
        sets.push(`${qIdent(dl.updatedAt)} = $${idx++}`);
        params.push(now);
      }
      if (dl.dspId && dspId) {
        sets.push(`${qIdent(dl.dspId)} = $${idx++}`);
        params.push(dspId);
      }

      await this.prisma.$queryRawUnsafe(
        `
        UPDATE ${dlT}
        SET ${sets.join(', ')}
        WHERE ${qIdent(dl.id)} = $1
      `,
        ...params,
      );
    }

    // replace task logs for this dailyLog (simple + stable)
    const tlT = qTable(meta.tables.taskLog);
    const tl = meta.columns.taskLog;

    await this.prisma.$queryRawUnsafe(
      `
      DELETE FROM ${tlT}
      WHERE ${qIdent(tl.dailyLogId)} = $1
    `,
      dailyLogId,
    );

    const items = Array.isArray(body?.items) ? body.items : [];
    for (const it of items) {
      const pocDutyId = String(it?.pocDutyId || '').trim();
      const completionStatus = String(it?.completionStatus || '').trim() as TaskStatus;
      const note = it?.note != null ? String(it.note) : null;

      if (!pocDutyId) continue;
      if (!completionStatus) continue;

      const completedAt =
        it?.timestamp && !Number.isNaN(new Date(String(it.timestamp)).getTime())
          ? new Date(String(it.timestamp))
          : now;

      const cols: string[] = [tl.dailyLogId, tl.pocDutyId, tl.completionStatus];
      const vals: any[] = [dailyLogId, pocDutyId, completionStatus];

      if (tl.completedAt) {
        cols.push(tl.completedAt);
        vals.push(completedAt);
      }
      if (tl.note && note) {
        cols.push(tl.note);
        vals.push(note);
      }

      const colSql = cols.map(qIdent).join(', ');
      const valSql = vals.map((_, i) => `$${i + 1}`).join(', ');

      await this.prisma.$queryRawUnsafe(
        `
        INSERT INTO ${tlT} (${colSql})
        VALUES (${valSql})
      `,
        ...vals,
      );
    }

    // return latest view
    const latest = await this.getDailyLog(shiftId, dateStr);

    return {
      ok: true,
      shiftId,
      date: dateStr,
      saved: {
        dailyLogId: latest.dailyLogId,
        status: latest.status,
        itemsCount: latest.items?.length ?? 0,
      },
      data: latest,
    };
  }
}