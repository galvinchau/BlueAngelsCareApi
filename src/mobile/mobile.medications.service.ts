// src/mobile/mobile.medications.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

type MedicationAdminStatus =
  | "GIVEN"
  | "REFUSED"
  | "MISSED"
  | "HELD"
  | "LATE"
  | "ERROR";

// ✅ Use app timezone for "today" (avoid UTC date shift)
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/New_York";

function formatLocalYYYYMMDD(date: Date) {
  // Convert to YYYY-MM-DD in a specific timezone safely
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value || "1970";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  const d = parts.find((p) => p.type === "day")?.value || "01";
  return `${y}-${m}-${d}`;
}

function startOfDayLocal(dateStr: string) {
  // dateStr: "YYYY-MM-DD"
  const [y, m, d] = dateStr.split("-").map((x) => Number(x));
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

function endOfDayLocal(dateStr: string) {
  const s = startOfDayLocal(dateStr);
  return new Date(
    s.getFullYear(),
    s.getMonth(),
    s.getDate(),
    23,
    59,
    59,
    999
  );
}

@Injectable()
export class MobileMedicationsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveShiftOrThrow(shiftId: string) {
    if (!shiftId?.trim()) throw new BadRequestException("shiftId is required");

    // ✅ Prisma model from schema: ScheduleShift -> prisma.scheduleShift
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

    if (!shift)
      throw new NotFoundException(`ScheduleShift not found: ${shiftId}`);
    return shift;
  }

  /**
   * GET orders by shiftId
   * - shift -> individualId -> MedicationOrder (ACTIVE)
   */
  async getOrdersByShiftId(shiftId: string) {
    const shift = await this.resolveShiftOrThrow(shiftId);

    const orders = await this.prisma.medicationOrder.findMany({
      where: {
        individualId: shift.individualId,
        status: "ACTIVE",
      },
      orderBy: [{ medicationName: "asc" }],
      select: {
        id: true,
        individualId: true,
        medicationName: true,
        form: true,
        doseValue: true,
        doseUnit: true,
        route: true,
        type: true,
        frequencyText: true,
        timesOfDay: true,
        startDate: true,
        endDate: true,
        status: true,
        prescriberName: true,
        pharmacyName: true,
        indications: true,
        allergyFlag: true,
      },
    });

    return {
      shiftId,
      individualId: shift.individualId,
      orders,
      note: orders.length
        ? undefined
        : "No ACTIVE medication orders found for this Individual.",
    };
  }

  /**
   * GET MAR by shiftId (+ optional date)
   * - date default: today in APP_TIMEZONE (not UTC)
   * - filter scheduledDateTime within that local day
   */
  async getMarByShiftId(shiftId: string, date?: string) {
    const shift = await this.resolveShiftOrThrow(shiftId);

    const validInput =
      date && /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())
        ? String(date).trim()
        : null;

    // ✅ IMPORTANT: default date should be local timezone date
    const dateStr = validInput ?? formatLocalYYYYMMDD(new Date());

    const from = startOfDayLocal(dateStr);
    const to = endOfDayLocal(dateStr);

    const items = await this.prisma.medicationAdministration.findMany({
      where: {
        individualId: shift.individualId,
        scheduledDateTime: { gte: from, lte: to },
      },
      orderBy: [{ scheduledDateTime: "asc" }],
      select: {
        id: true,
        orderId: true,
        individualId: true,
        scheduledDateTime: true,
        actualDateTime: true,
        status: true,
        reason: true,
        vitalsSummary: true,
        staffId: true,
        staffName: true,
        createdAt: true,
        updatedAt: true,
        order: {
          select: {
            id: true,
            medicationName: true,
            doseValue: true,
            doseUnit: true,
            route: true,
            type: true,
            timesOfDay: true,
            frequencyText: true,
          },
        },
      },
    });

    return {
      shiftId,
      individualId: shift.individualId,
      date: dateStr,
      items,
      note: items.length ? undefined : "No MAR records for this date.",
    };
  }

  /**
   * POST create MAR row
   * body:
   *  - shiftId (required)
   *  - orderId (required)
   *  - scheduledDateTime (required, ISO string)
   *  - status (required)
   *  - reason, vitalsSummary, staffId, staffName (optional)
   *  - actualDateTime (optional, ISO string) if GIVEN etc
   */
  async createAdministration(body: any) {
    const shiftId = String(body?.shiftId || "").trim();
    const orderId = String(body?.orderId || "").trim();
    const status = String(body?.status || "").trim() as MedicationAdminStatus;

    if (!shiftId) throw new BadRequestException("shiftId is required");
    if (!orderId) throw new BadRequestException("orderId is required");
    if (!status) throw new BadRequestException("status is required");

    const scheduledDateTimeRaw = String(body?.scheduledDateTime || "").trim();
    const scheduledDateTime = new Date(scheduledDateTimeRaw);
    if (!scheduledDateTimeRaw || Number.isNaN(scheduledDateTime.getTime())) {
      throw new BadRequestException(
        "scheduledDateTime must be a valid ISO datetime"
      );
    }

    const actualDateTimeRaw = body?.actualDateTime
      ? String(body.actualDateTime).trim()
      : "";
    const actualDateTime = actualDateTimeRaw ? new Date(actualDateTimeRaw) : null;
    if (actualDateTimeRaw && Number.isNaN(actualDateTime!.getTime())) {
      throw new BadRequestException("actualDateTime must be a valid ISO datetime");
    }

    // validate shift and order belong to same individual
    const shift = await this.resolveShiftOrThrow(shiftId);

    const order = await this.prisma.medicationOrder.findUnique({
      where: { id: orderId },
      select: { id: true, individualId: true, status: true },
    });
    if (!order) throw new NotFoundException(`MedicationOrder not found: ${orderId}`);
    if (order.individualId !== shift.individualId) {
      throw new BadRequestException(
        "Order does not belong to the Individual of this shift"
      );
    }

    const created = await this.prisma.medicationAdministration.create({
      data: {
        orderId,
        individualId: shift.individualId,
        scheduledDateTime,
        actualDateTime: actualDateTime || undefined,
        status: status as any,
        reason: body?.reason ? String(body.reason) : undefined,
        vitalsSummary: body?.vitalsSummary ? String(body.vitalsSummary) : undefined,
        staffId: body?.staffId ? String(body.staffId) : undefined,
        staffName: body?.staffName ? String(body.staffName) : undefined,
      },
      select: {
        id: true,
        orderId: true,
        individualId: true,
        scheduledDateTime: true,
        actualDateTime: true,
        status: true,
        reason: true,
        vitalsSummary: true,
        staffId: true,
        staffName: true,
        createdAt: true,
      },
    });

    return { ok: true, item: created };
  }
}