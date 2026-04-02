// ======================================================
//  bac-hms/bac-api/src/awake/awake.cron.ts
// ======================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AwakeCronService {
  private readonly logger = new Logger(AwakeCronService.name);
  private isRunningOverdueJob = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Auto checkout all awake-monitoring visits that passed deadline
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

    await this.prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: visitId },
        select: {
          id: true,
          dspId: true,
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

      this.logger.warn(
        `[AwakeCron] AUTO CHECKOUT completed for visit=${visit.id}, shift=${visit.scheduleShiftId ?? 'N/A'}, dsp=${visit.dspId}, deadline=${effectiveCheckoutAt.toISOString()}, reason=FAIL_CONFIRM_AWAKE`,
      );

      /**
       * NEXT PHASE HOOKS:
       * 1) Send push to DSP: "Shift auto checked out because awake confirmation was missed"
       * 2) Send notification/email/in-app alert to Office
       * 3) Optionally create audit record / notification row
       */
    });
  }
}