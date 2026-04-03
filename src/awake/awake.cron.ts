// ======================================================
//  bac-hms/bac-api/src/awake/awake.cron.ts
// ======================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

@Injectable()
export class AwakeCronService {
  private readonly logger = new Logger(AwakeCronService.name);
  private isRunningOverdueJob = false;
  private isRunningReminderJob = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
  ) {}

  private async logAwakeEvent(args: {
    visitId: string;
    scheduleShiftId?: string | null;
    individualId: string;
    dspId: string;
    serviceId?: string | null;
    eventType: 'REMINDER_SENT' | 'AUTO_CHECKOUT_FAIL_CONFIRM';
    eventTime?: Date;
    note?: string | null;
    meta?: Record<string, any> | null;
  }) {
    try {
      await (this.prisma as any).awakeEventLog.create({
        data: {
          visitId: args.visitId,
          scheduleShiftId: args.scheduleShiftId ?? null,
          individualId: args.individualId,
          dspId: args.dspId,
          serviceId: args.serviceId ?? null,
          eventType: args.eventType,
          eventTime: args.eventTime ?? new Date(),
          note: args.note ?? null,
          meta: args.meta ?? null,
        },
      });
    } catch (e: any) {
      this.logger.error(
        `[AwakeCron][AwakeEventLog] failed for visit ${args.visitId}: ${e?.message ?? e}`,
        e?.stack,
      );
    }
  }

  /**
   * 🔔 Send awake reminder push
   * Runs every minute.
   */
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'awake-reminder-push',
  })
  async handleAwakeReminderPush() {
    if (this.isRunningReminderJob) {
      this.logger.warn(
        '[AwakeCron] Previous reminder job is still running. Skip this tick.',
      );
      return;
    }

    this.isRunningReminderJob = true;

    try {
      const now = new Date();

      const dueVisits = await this.prisma.visit.findMany({
        where: {
          awakeMonitoringEnabled: true,
          checkOutAt: null,
          autoCheckedOutAt: null,
          nextAwakeConfirmDueAt: {
            lte: now,
          },
          awakeDeadlineAt: {
            gt: now,
          },
          OR: [
            { awakeStatus: 'ACTIVE' },
            { awakeStatus: 'DUE' },
            { awakeStatus: null },
          ],
        },
        select: {
          id: true,
          dspId: true,
          individualId: true,
          serviceId: true,
          scheduleShiftId: true,
          nextAwakeConfirmDueAt: true,
          awakeDeadlineAt: true,
          awakeStatus: true,
        },
        orderBy: {
          nextAwakeConfirmDueAt: 'asc',
        },
        take: 200,
      });

      if (dueVisits.length === 0) {
        return;
      }

      this.logger.log(
        `[AwakeCron] Found ${dueVisits.length} due awake visit(s).`,
      );

      for (const visit of dueVisits) {
        try {
          // Tránh gửi lặp lại mỗi phút nếu đã đánh dấu DUE rồi
          if (visit.awakeStatus === 'DUE') {
            continue;
          }

          await this.prisma.visit.update({
            where: { id: visit.id },
            data: {
              awakeStatus: 'DUE',
            } as any,
          });

          await this.pushService.sendToStaff(visit.dspId, {
            title: 'Awake Check Required',
            body: 'Please confirm you are awake for your shift now.',
            sound: 'default',
            data: {
              type: 'AWAKE_REMINDER',
              visitId: visit.id,
              shiftId: visit.scheduleShiftId ?? null,
              nextDueAt: visit.nextAwakeConfirmDueAt?.toISOString() ?? null,
              deadlineAt: visit.awakeDeadlineAt?.toISOString() ?? null,
              ts: new Date().toISOString(),
            },
          });

          await this.logAwakeEvent({
            visitId: visit.id,
            scheduleShiftId: visit.scheduleShiftId ?? null,
            individualId: visit.individualId,
            dspId: visit.dspId,
            serviceId: visit.serviceId ?? null,
            eventType: 'REMINDER_SENT',
            eventTime: now,
            note: 'Awake reminder push sent.',
            meta: {
              source: 'AWAKE_CRON_REMINDER',
              nextDueAt: visit.nextAwakeConfirmDueAt?.toISOString() ?? null,
              deadlineAt: visit.awakeDeadlineAt?.toISOString() ?? null,
            },
          });

          this.logger.log(
            `[AwakeCron] Reminder push sent → visit=${visit.id}, dsp=${visit.dspId}`,
          );
        } catch (error: any) {
          this.logger.error(
            `[AwakeCron] Failed reminder push for visit ${visit.id}: ${error?.message ?? error}`,
            error?.stack,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(
        `[AwakeCron] Reminder job failed: ${error?.message ?? error}`,
        error?.stack,
      );
    } finally {
      this.isRunningReminderJob = false;
    }
  }

  /**
   * ❌ Auto checkout all awake-monitoring visits that passed deadline
   * Runs every minute.
   */
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'awake-overdue-auto-checkout',
  })
  async handleAwakeOverdueAutoCheckout() {
    if (this.isRunningOverdueJob) {
      this.logger.warn(
        '[AwakeCron] Previous overdue job is still running. Skip this tick.',
      );
      return;
    }

    this.isRunningOverdueJob = true;

    try {
      const now = new Date();

      const overdueVisits = await this.prisma.visit.findMany({
        where: {
          awakeMonitoringEnabled: true,
          checkOutAt: null,
          autoCheckedOutAt: null,
          awakeDeadlineAt: {
            lte: now,
          },
        },
        select: {
          id: true,
          scheduleShiftId: true,
          individualId: true,
          serviceId: true,
          dspId: true,
          checkInAt: true,
          awakeDeadlineAt: true,
          awakeStatus: true,
        },
        orderBy: {
          awakeDeadlineAt: 'asc',
        },
        take: 200,
      });

      if (overdueVisits.length === 0) {
        return;
      }

      this.logger.warn(
        `[AwakeCron] Found ${overdueVisits.length} overdue awake visit(s).`,
      );

      for (const visit of overdueVisits) {
        try {
          await this.autoCheckoutSingleVisit(visit.id);
        } catch (error: any) {
          this.logger.error(
            `[AwakeCron] Failed auto-checkout for visit ${visit.id}: ${error?.message ?? error}`,
            error?.stack,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(
        `[AwakeCron] Overdue job failed: ${error?.message ?? error}`,
        error?.stack,
      );
    } finally {
      this.isRunningOverdueJob = false;
    }
  }

  private async autoCheckoutSingleVisit(visitId: string): Promise<void> {
    const processedAt = new Date();

    let pushTargetStaffId: string | null = null;
    let pushShiftId: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: visitId },
        select: {
          id: true,
          dspId: true,
          individualId: true,
          serviceId: true,
          scheduleShiftId: true,
          checkInAt: true,
          checkOutAt: true,
          awakeMonitoringEnabled: true,
          awakeDeadlineAt: true,
          autoCheckedOutAt: true,
          autoCheckoutReason: true,
          awakeStatus: true,
        },
      });

      if (!visit) {
        this.logger.warn(
          `[AwakeCron] Visit ${visitId} no longer exists. Skip.`,
        );
        return;
      }

      if (visit.awakeMonitoringEnabled !== true) {
        this.logger.warn(
          `[AwakeCron] Visit ${visit.id} is not awake-enabled. Skip.`,
        );
        return;
      }

      if (visit.checkOutAt || visit.autoCheckedOutAt) {
        this.logger.log(
          `[AwakeCron] Visit ${visit.id} already checked out. Skip.`,
        );
        return;
      }

      const effectiveCheckoutAt = visit.awakeDeadlineAt ?? processedAt;
      const failNote = 'Fail confirm Awake';

      const visitUpdate = await tx.visit.updateMany({
        where: {
          id: visit.id,
          checkOutAt: null,
          autoCheckedOutAt: null,
        },
        data: {
          checkOutAt: effectiveCheckoutAt,
          autoCheckedOutAt: processedAt,
          autoCheckoutReason: 'FAIL_CONFIRM_AWAKE',
          awakeStatus: 'AUTO_CHECKED_OUT',
        } as any,
      });

      if (visitUpdate.count === 0) {
        this.logger.warn(
          `[AwakeCron] Visit ${visit.id} was processed by another worker. Skip.`,
        );
        return;
      }

      await (tx as any).awakeEventLog.create({
        data: {
          visitId: visit.id,
          scheduleShiftId: visit.scheduleShiftId ?? null,
          individualId: visit.individualId,
          dspId: visit.dspId,
          serviceId: visit.serviceId ?? null,
          eventType: 'AUTO_CHECKOUT_FAIL_CONFIRM',
          eventTime: processedAt,
          note: 'Visit auto checked out due to missed awake confirmation.',
          meta: {
            source: 'AWAKE_CRON_AUTO_CHECKOUT',
            effectiveCheckoutAt: effectiveCheckoutAt.toISOString(),
            awakeDeadlineAt: visit.awakeDeadlineAt?.toISOString() ?? null,
            reason: 'FAIL_CONFIRM_AWAKE',
          },
        },
      });

      if (visit.scheduleShiftId) {
        const existingShift = await tx.scheduleShift.findUnique({
          where: { id: visit.scheduleShiftId },
          select: {
            id: true,
            notes: true,
            status: true,
          },
        });

        if (existingShift) {
          const oldNotes = String(existingShift.notes ?? '').trim();
          const alreadyHasFailNote = oldNotes
            .toLowerCase()
            .includes(failNote.toLowerCase());

          const mergedNotes = alreadyHasFailNote
            ? oldNotes
            : oldNotes
              ? `${oldNotes} | ${failNote}`
              : failNote;

          await tx.scheduleShift.update({
            where: { id: existingShift.id },
            data: {
              status: ScheduleStatus.NOT_COMPLETED,
              notes: mergedNotes,
            } as any,
          });
        }
      }

      pushTargetStaffId = visit.dspId;
      pushShiftId = visit.scheduleShiftId ?? null;

      this.logger.warn(
        `[AwakeCron] AUTO CHECKOUT completed for visit=${visit.id}, shift=${visit.scheduleShiftId ?? 'N/A'}, dsp=${visit.dspId}, deadline=${effectiveCheckoutAt.toISOString()}, reason=FAIL_CONFIRM_AWAKE`,
      );
    });

    // Send push OUTSIDE transaction
    if (pushTargetStaffId) {
      try {
        await this.pushService.sendToStaff(pushTargetStaffId, {
          title: 'Shift Auto Checked Out',
          body: 'You missed Awake confirmation. Your shift has been automatically ended.',
          sound: 'default',
          data: {
            type: 'AWAKE_AUTO_CHECKOUT',
            visitId,
            shiftId: pushShiftId,
            reason: 'FAIL_CONFIRM_AWAKE',
            ts: new Date().toISOString(),
          },
        });

        this.logger.log(
          `[AwakeCron] Auto-checkout push sent → visit=${visitId}, dsp=${pushTargetStaffId}`,
        );
      } catch (error: any) {
        this.logger.error(
          `[AwakeCron] Failed auto-checkout push for visit ${visitId}: ${error?.message ?? error}`,
          error?.stack,
        );
      }
    }
  }
}