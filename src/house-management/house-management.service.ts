// bac-hms/bac-api/src/house-management/house-management.service.ts

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  IndividualStatus,
  Prisma,
  ResidentialPlacementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type GetHousesFilters = {
  search?: string;
  status?: string;
  county?: string;
  risk?: string;
};

type CreateHouseInput = {
  code?: string;
  name?: string;
  programType?: string;
  capacity?: number;
  primaryOccupancyModel?: string;
  county?: string;
  phone?: string;
  address1?: string;
  billingNote?: string;
  careComplexityNote?: string;
};

type GetAvailableIndividualsFilters = {
  search?: string;
  status?: string;
};

type GetAvailableEmployeesFilters = {
  search?: string;
  status?: string;
  houseId?: string;
};

type AssignResidentToHouseInput = {
  houseId?: string;
};

type AssignStaffToHouseInput = {
  houseId?: string;
  houseRole?: string;
  isPrimaryStaff?: boolean;
};

type UpdateStaffHouseRoleInput = {
  houseRole?: string;
  isPrimaryStaff?: boolean;
};

type UpdateResidentialProfileInput = {
  residentialPlacementType?: string;
  homeVisitSchedule?: string;
  housingCoverage?: string;
  careRateTier?: string;
  roomLabel?: string;
  behaviorSupportLevel?: string;
  appointmentLoad?: string;
};

type CreateFireDrillInput = {
  houseId?: string;
  drillDate?: string;
  drillTimeLabel?: string;
  isSleepingDrill?: boolean;
  isUnannounced?: boolean;
  isUnderNormalStaffing?: boolean;
  evacuationTimeMinutes?: number;
  allIndividualsEvacuated?: boolean;
  alarmType?: string;
  alarmOperative?: boolean;
  exitRouteUsed?: string;
  alternateExitUsed?: boolean;
  meetingPlace?: string;
  problemsEncountered?: string;
  correctiveAction?: string;
  conductedBy?: string;
  staffPresent?: string;
  notes?: string;
};

type UpdateFireDrillInput = {
  drillDate?: string;
  drillTimeLabel?: string;
  isSleepingDrill?: boolean;
  isUnannounced?: boolean;
  isUnderNormalStaffing?: boolean;
  evacuationTimeMinutes?: number;
  allIndividualsEvacuated?: boolean;
  alarmType?: string;
  alarmOperative?: boolean;
  exitRouteUsed?: string;
  alternateExitUsed?: boolean;
  meetingPlace?: string;
  problemsEncountered?: string;
  correctiveAction?: string;
  conductedBy?: string;
  staffPresent?: string;
  notes?: string;
};

type HouseAlertAction =
  | 'VIEW_RESIDENTS'
  | 'VIEW_STAFFING'
  | 'VIEW_COVERAGE'
  | 'VIEW_DASHBOARD';

@Injectable()
export class HouseManagementService {
  constructor(private readonly prisma: PrismaService) { }

  async getHouses(filters: GetHousesFilters) {
    const search = (filters.search || '').trim();
    const status = (filters.status || '').trim().toUpperCase();
    const county = (filters.county || '').trim();
    const risk = (filters.risk || '').trim().toUpperCase();

    const houses = await this.prisma.house.findMany({
      where: {
        ...(status && status !== 'ALL' ? { status } : {}),
        ...(county && county !== 'ALL' ? { county } : {}),
        ...(search
          ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { code: { contains: search, mode: 'insensitive' } },
              { address1: { contains: search, mode: 'insensitive' } },
              { city: { contains: search, mode: 'insensitive' } },
              { county: { contains: search, mode: 'insensitive' } },
            ],
          }
          : {}),
      },
      include: {
        residents: {
          select: { id: true },
        },
        staffLinks: {
          where: { isActive: true },
          select: { id: true },
        },
      },
      orderBy: [{ name: 'asc' }],
    });

    const housesWithMetrics = await Promise.all(
      houses.map(async (house) => {
        const complianceScore = await this.computeComplianceScore(house.id);
        const openAlerts = await this.computeOpenAlerts(house.id);
        const derivedRisk = this.mapScoreToRisk(complianceScore);

        return {
          id: house.id,
          code: house.code,
          name: house.name,
          address: this.formatHouseAddress(house),
          programType: house.programType || 'Residential 6400',
          capacity: house.capacity,
          currentResidents: house.residents.length,
          assignedStaff: house.staffLinks.length,
          complianceScore,
          openAlerts,
          status: house.status,
          risk: derivedRisk,
          supervisor: await this.getPrimarySupervisorName(house.id),
          county: house.county || '',
          phone: house.phone || '',
          primaryOccupancyModel: house.primaryOccupancyModel || 'SINGLE',
          houseBillingNote: house.billingNote || '',
        };
      }),
    );

    const filtered =
      risk && risk !== 'ALL'
        ? housesWithMetrics.filter((h) => h.risk === risk)
        : housesWithMetrics;

    return {
      items: filtered,
      total: filtered.length,
    };
  }

  async createFireDrill(input: CreateFireDrillInput) {
    const houseId = (input.houseId || '').trim();

    if (!houseId) {
      throw new BadRequestException('houseId is required.');
    }

    if (!input.drillDate) {
      throw new BadRequestException('drillDate is required.');
    }

    const drillDate = new Date(input.drillDate);
    if (Number.isNaN(drillDate.getTime())) {
      throw new BadRequestException('drillDate is invalid.');
    }

    const house = await this.prisma.house.findUnique({
      where: { id: houseId },
      select: { id: true, name: true },
    });

    if (!house) {
      throw new NotFoundException('House not found.');
    }

    const created = await this.prisma.houseFireDrill.create({
      data: {
        houseId,
        drillDate,
        drillTimeLabel: this.normalizeOptionalString(input.drillTimeLabel),
        isSleepingDrill: Boolean(input.isSleepingDrill),
        isUnannounced: Boolean(input.isUnannounced),
        isUnderNormalStaffing:
          typeof input.isUnderNormalStaffing === 'boolean'
            ? input.isUnderNormalStaffing
            : true,
        evacuationTimeMinutes:
          typeof input.evacuationTimeMinutes === 'number'
            ? input.evacuationTimeMinutes
            : null,
        allIndividualsEvacuated:
          typeof input.allIndividualsEvacuated === 'boolean'
            ? input.allIndividualsEvacuated
            : true,
        alarmType: this.normalizeOptionalString(input.alarmType),
        alarmOperative:
          typeof input.alarmOperative === 'boolean' ? input.alarmOperative : null,
        exitRouteUsed: this.normalizeOptionalString(input.exitRouteUsed),
        alternateExitUsed: Boolean(input.alternateExitUsed),
        meetingPlace: this.normalizeOptionalString(input.meetingPlace),
        problemsEncountered: this.normalizeOptionalString(input.problemsEncountered),
        correctiveAction: this.normalizeOptionalString(input.correctiveAction),
        conductedBy: this.normalizeOptionalString(input.conductedBy),
        staffPresent: this.normalizeOptionalString(input.staffPresent),
        notes: this.normalizeOptionalString(input.notes),
      },
      select: {
        id: true,
        houseId: true,
      },
    });

    return {
      id: created.id,
      houseId: created.houseId,
      message: 'Fire drill created successfully.',
    };
  }

  async updateFireDrill(fireDrillId: string, input: UpdateFireDrillInput) {
    const existing = await this.prisma.houseFireDrill.findUnique({
      where: { id: fireDrillId },
      select: { id: true, houseId: true },
    });

    if (!existing) {
      throw new NotFoundException('Fire drill not found.');
    }

    const data: Record<string, unknown> = {};

    if (typeof input.drillDate !== 'undefined') {
      const parsed = new Date(input.drillDate);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('drillDate is invalid.');
      }
      data.drillDate = parsed;
    }

    if (typeof input.drillTimeLabel !== 'undefined') {
      data.drillTimeLabel = this.normalizeOptionalString(input.drillTimeLabel);
    }

    if (typeof input.isSleepingDrill === 'boolean') {
      data.isSleepingDrill = input.isSleepingDrill;
    }

    if (typeof input.isUnannounced === 'boolean') {
      data.isUnannounced = input.isUnannounced;
    }

    if (typeof input.isUnderNormalStaffing === 'boolean') {
      data.isUnderNormalStaffing = input.isUnderNormalStaffing;
    }

    if (typeof input.evacuationTimeMinutes !== 'undefined') {
      data.evacuationTimeMinutes =
        typeof input.evacuationTimeMinutes === 'number'
          ? input.evacuationTimeMinutes
          : null;
    }

    if (typeof input.allIndividualsEvacuated === 'boolean') {
      data.allIndividualsEvacuated = input.allIndividualsEvacuated;
    }

    if (typeof input.alarmType !== 'undefined') {
      data.alarmType = this.normalizeOptionalString(input.alarmType);
    }

    if (typeof input.alarmOperative === 'boolean') {
      data.alarmOperative = input.alarmOperative;
    }

    if (typeof input.exitRouteUsed !== 'undefined') {
      data.exitRouteUsed = this.normalizeOptionalString(input.exitRouteUsed);
    }

    if (typeof input.alternateExitUsed === 'boolean') {
      data.alternateExitUsed = input.alternateExitUsed;
    }

    if (typeof input.meetingPlace !== 'undefined') {
      data.meetingPlace = this.normalizeOptionalString(input.meetingPlace);
    }

    if (typeof input.problemsEncountered !== 'undefined') {
      data.problemsEncountered = this.normalizeOptionalString(
        input.problemsEncountered,
      );
    }

    if (typeof input.correctiveAction !== 'undefined') {
      data.correctiveAction = this.normalizeOptionalString(input.correctiveAction);
    }

    if (typeof input.conductedBy !== 'undefined') {
      data.conductedBy = this.normalizeOptionalString(input.conductedBy);
    }

    if (typeof input.staffPresent !== 'undefined') {
      data.staffPresent = this.normalizeOptionalString(input.staffPresent);
    }

    if (typeof input.notes !== 'undefined') {
      data.notes = this.normalizeOptionalString(input.notes);
    }

    const updated = await this.prisma.houseFireDrill.update({
      where: { id: fireDrillId },
      data,
      select: {
        id: true,
        houseId: true,
      },
    });

    return {
      id: updated.id,
      houseId: updated.houseId,
      message: 'Fire drill updated successfully.',
    };
  }

  async getDashboard(houseId: string) {
    const house = await this.prisma.house.findUnique({
      where: { id: houseId },
    });

    if (!house) {
      throw new NotFoundException('House not found');
    }

    const residents = await this.prisma.individual.findMany({
      where: { houseId },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: {
        id: true,
        code: true,
        firstName: true,
        middleName: true,
        lastName: true,
        medicaidId: true,
        status: true,
        roomLabel: true,
        residentialPlacementType: true,
        homeVisitSchedule: true,
        housingCoverage: true,
        careRateTier: true,
        behaviorSupportLevel: true,
        appointmentLoad: true,
      },
    });

    const todayStart = this.startOfToday();
    const todayEnd = this.endOfToday();

    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        individual: {
          houseId,
        },
        scheduleDate: {
          gte: todayStart,
          lte: todayEnd,
        },
      },
      include: {
        service: true,
        individual: true,
        houseShiftStaffings: {
          include: {
            employee: true,
          },
        },
        plannedDsp: true,
        actualDsp: true,
      },
      orderBy: [{ plannedStart: 'asc' }],
    });

    const capacity = typeof house.capacity === 'number' ? house.capacity : 0;
    const residentCount = residents.length;
    const remainingBeds = Math.max(capacity - residentCount, 0);
    const occupancyStatus = this.getOccupancyStatus(residentCount, capacity);

    const behaviorIntensive = residents.filter(
      (r) => (r.behaviorSupportLevel || '').toUpperCase() === 'INTENSIVE',
    ).length;

    const missingRoomCount = residents.filter(
      (r) => !this.normalizeOptionalString(r.roomLabel),
    ).length;

    const missingCareRateTierCount = residents.filter(
      (r) => !this.normalizeOptionalString(r.careRateTier),
    ).length;

    const missingHousingCoverageCount = residents.filter(
      (r) => !this.normalizeOptionalString(r.housingCoverage),
    ).length;

    const missingHomeVisitScheduleCount = residents.filter(
      (r) =>
        r.residentialPlacementType === 'HOME_VISIT_SPLIT' &&
        !this.normalizeOptionalString(r.homeVisitSchedule),
    ).length;

    const profileGaps =
      missingRoomCount +
      missingCareRateTierCount +
      missingHousingCoverageCount +
      missingHomeVisitScheduleCount;

    const residentSnapshot = residents.map((resident) => ({
      id: resident.id,
      code: resident.code || '',
      name: this.individualFullName(resident),
      maNumber: resident.medicaidId || '',
      roomLabel: resident.roomLabel || '',
      residentialPlacementType: resident.residentialPlacementType || null,
      behaviorSupportLevel: resident.behaviorSupportLevel || 'NONE',
      appointmentLoad: resident.appointmentLoad || 'LOW',
      careRateTier: resident.careRateTier || '',
      housingCoverage: resident.housingCoverage || '',
      homeVisitSchedule: resident.homeVisitSchedule || '',
      status: resident.status || '',
      profileFlags: {
        missingRoomLabel: !this.normalizeOptionalString(resident.roomLabel),
        missingCareRateTier: !this.normalizeOptionalString(resident.careRateTier),
        missingHousingCoverage: !this.normalizeOptionalString(
          resident.housingCoverage,
        ),
        missingHomeVisitSchedule:
          resident.residentialPlacementType === 'HOME_VISIT_SPLIT' &&
          !this.normalizeOptionalString(resident.homeVisitSchedule),
      },
    }));

    const summary = {
      residents: residentCount,
      fullTime247: residents.filter(
        (r) => r.residentialPlacementType === 'FULL_TIME_247',
      ).length,
      homeVisitSplit: residents.filter(
        (r) => r.residentialPlacementType === 'HOME_VISIT_SPLIT',
      ).length,
      highNeedResidents: residents.filter(
        (r) => (r.behaviorSupportLevel || '').toUpperCase() === 'INTENSIVE',
      ).length,
      multiDspShifts: shifts.filter((s) => s.houseShiftStaffings.length >= 2).length,
      complianceScore: await this.computeComplianceScore(houseId),
      behaviorIntensive,
      capacityUsed: residentCount,
      remainingBeds,
      occupancyStatus,
      profileGaps,
    };

    const coverage = shifts.map((shift) => {
      const staffAssigned =
        shift.houseShiftStaffings.length > 0
          ? shift.houseShiftStaffings.map((hs) => ({
            name: this.employeeFullName(hs.employee),
            role: hs.roleInShift || hs.employee.role || 'DSP',
          }))
          : this.fallbackShiftStaff(shift);

      return {
        id: shift.id,
        time: `${this.toHourMinute(shift.plannedStart)} - ${this.toHourMinute(shift.plannedEnd)}`,
        service: shift.service?.serviceName || shift.service?.serviceCode || 'Service',
        shiftStatus: shift.status,
        staffAssigned,
        individualsCovered: [this.individualFullName(shift.individual)],
        staffingRatioLabel: `${staffAssigned.length} DSP : 1 Resident`,
        awakeRequired: shift.awakeMonitoringRequired,
        behaviorSupport:
          (shift.individual.behaviorSupportLevel || '').toUpperCase() === 'INTENSIVE',
        note: shift.notes || shift.backupNote || null,
      };
    });

    const alerts = await this.buildHouseAlerts(houseId, residents, shifts, {
      capacity,
      residentCount,
      remainingBeds,
      occupancyStatus,
      missingRoomCount,
      missingCareRateTierCount,
      missingHousingCoverageCount,
      missingHomeVisitScheduleCount,
    });

    const compliance = await this.buildComplianceBreakdown(houseId);
    const timeline = await this.buildTimeline(houseId);

    return {
      house: {
        id: house.id,
        code: house.code,
        name: house.name,
        address: this.formatHouseAddress(house),
        programType: house.programType || 'Residential 6400',
        county: house.county || '',
        phone: house.phone || '',
        capacity: house.capacity,
        currentResidents: residentCount,
        supervisor: await this.getPrimarySupervisorName(houseId),
      },
      summary,
      occupancy: {
        capacity,
        currentResidents: residentCount,
        remainingBeds,
        occupancyStatus,
      },
      residentSnapshot,
      coverage,
      alerts,
      compliance,
      timeline,
    };
  }

  async getResidents(houseId: string) {
    const house = await this.prisma.house.findUnique({
      where: { id: houseId },
      select: { id: true, name: true },
    });

    if (!house) {
      throw new NotFoundException('House not found');
    }

    const residents = await this.prisma.individual.findMany({
      where: { houseId },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: {
        id: true,
        code: true,
        firstName: true,
        middleName: true,
        lastName: true,
        medicaidId: true,
        dob: true,
        gender: true,
        status: true,
        roomLabel: true,
        residentialPlacementType: true,
        homeVisitSchedule: true,
        housingCoverage: true,
        careRateTier: true,
        behaviorSupportLevel: true,
        appointmentLoad: true,
        acceptedServices: true,
      },
    });

    const items = residents.map((r) => ({
      id: r.id,
      code: r.code,
      name: this.individualFullName(r),
      maNumber: r.medicaidId || '',
      age: this.ageFromDob(r.dob),
      gender: r.gender || '',
      room: r.roomLabel || '',
      residentialType: r.residentialPlacementType || null,
      homeVisitSchedule: r.homeVisitSchedule || '',
      housingCoverage: r.housingCoverage || '24/7',
      careRateTier: r.careRateTier || '',
      ispStatus: 'CURRENT',
      riskFlag:
        (r.behaviorSupportLevel || '').toUpperCase() === 'INTENSIVE'
          ? 'HIGH'
          : 'STANDARD',
      behaviorSupportLevel: r.behaviorSupportLevel || 'NONE',
      medProfile: 'DAILY',
      appointmentLoad: r.appointmentLoad || 'LOW',
      status: r.status,
    }));

    return {
      houseId: house.id,
      houseName: house.name,
      summary: {
        totalResidents: items.length,
        fullTime247: items.filter((i) => i.residentialType === 'FULL_TIME_247').length,
        homeVisitSplit: items.filter((i) => i.residentialType === 'HOME_VISIT_SPLIT').length,
        highNeed: items.filter((i) => i.riskFlag === 'HIGH').length,
        dailyMedUsers: items.length,
        behaviorIntensive: items.filter(
          (i) => (i.behaviorSupportLevel || '').toUpperCase() === 'INTENSIVE',
        ).length,
      },
      items,
    };
  }

  async getStaffing(houseId: string) {
    const house = await this.prisma.house.findUnique({
      where: { id: houseId },
      select: { id: true, name: true },
    });

    if (!house) {
      throw new NotFoundException('House not found');
    }

    const houseEmployees = await this.prisma.houseEmployee.findMany({
      where: {
        houseId,
        isActive: true,
      },
      include: {
        employee: true,
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    const todayStart = this.startOfToday();
    const todayEnd = this.endOfToday();
    const now = new Date();

    const todayShiftStaffings = await this.prisma.houseShiftStaffing.findMany({
      where: {
        houseId,
        shift: {
          scheduleDate: {
            gte: todayStart,
            lte: todayEnd,
          },
        },
      },
      include: {
        employee: true,
        shift: true,
      },
    });

    const todayScheduleShifts = await this.prisma.scheduleShift.findMany({
      where: {
        individual: {
          houseId,
        },
        scheduleDate: {
          gte: todayStart,
          lte: todayEnd,
        },
      },
      select: {
        id: true,
        plannedStart: true,
        plannedEnd: true,
        plannedDspId: true,
        actualDspId: true,
        status: true,
      },
      orderBy: [{ plannedStart: 'asc' }],
    });

    const multiDspShiftCount = this.countTodayMultiDspShifts(
      todayScheduleShifts,
      todayShiftStaffings,
    );

    const staffRows = houseEmployees.map((he) => {
      const employee = he.employee;

      const assignedTodayByHouseStaffing = todayShiftStaffings.filter(
        (s) => s.employeeId === employee.id,
      );

      const assignedTodayBySchedule = todayScheduleShifts.filter(
        (shift) =>
          shift.actualDspId === employee.id || shift.plannedDspId === employee.id,
      );

      const currentShiftFromHouseStaffing = assignedTodayByHouseStaffing[0]?.shift;
      const currentShiftFromSchedule = assignedTodayBySchedule[0];

      const resolvedShift = currentShiftFromHouseStaffing || currentShiftFromSchedule;

      const isOnDutyNow =
        assignedTodayByHouseStaffing.some((s) =>
          this.isNowWithinShiftWindow(s.shift.plannedStart, s.shift.plannedEnd, now),
        ) ||
        assignedTodayBySchedule.some((shift) =>
          this.isNowWithinShiftWindow(shift.plannedStart, shift.plannedEnd, now),
        );

      const normalizedRole = String(he.roleInHouse || employee.role || '').toUpperCase();
      const medCertified = normalizedRole.includes('MED');
      const behaviorSpecialist = normalizedRole.includes('BEHAVIOR');

      return {
        id: employee.id,
        name: this.employeeFullName(employee),
        role: he.roleInHouse || employee.role || 'DSP',
        isPrimaryStaff: Boolean(he.isPrimary),
        shiftToday: resolvedShift
          ? `${this.toHourMinute(resolvedShift.plannedStart)} - ${this.toHourMinute(resolvedShift.plannedEnd)}`
          : '',
        trainingStatus: 'CURRENT',
        medCertified,
        behaviorSpecialist,
        cpr: 'CURRENT',
        driver: 'ACTIVE',
        clearance: 'CURRENT',
        status: isOnDutyNow ? 'ON_DUTY' : 'OFF_DUTY',
      };
    });

    const specialistsCount = staffRows.filter((s) => s.behaviorSpecialist).length;

    return {
      houseId: house.id,
      houseName: house.name,
      summary: {
        assignedStaff: staffRows.length,
        onDutyNow: staffRows.filter((s) => s.status === 'ON_DUTY').length,
        multiDspShifts: multiDspShiftCount,
        behaviorSpecialistVisits: specialistsCount,
        medCertStaff: staffRows.filter((s) => s.medCertified).length,
        trainingOverdue: staffRows.filter((s) => s.trainingStatus === 'OVERDUE').length,
      },
      items: staffRows.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        isPrimaryStaff: s.isPrimaryStaff,
        shiftToday: s.shiftToday,
        trainingStatus: s.trainingStatus,
        medCertified: s.medCertified,
        cpr: s.cpr,
        driver: s.driver,
        clearance: s.clearance,
        status: s.status,
      })),
    };
  }

  async getCompliance(houseId: string) {
    const house = await this.prisma.house.findUnique({
      where: { id: houseId },
      select: {
        id: true,
        name: true,
        code: true,
        address1: true,
        address2: true,
        city: true,
        state: true,
        zip: true,
        county: true,
        phone: true,
        programType: true,
        capacity: true,
      },
    });

    if (!house) {
      throw new NotFoundException('House not found');
    }

    const [complianceRows, fireDrillRows, incidentRows] = await Promise.all([
      this.prisma.houseComplianceItem.findMany({
        where: { houseId },
        orderBy: [{ category: 'asc' }, { label: 'asc' }],
      }),
      this.prisma.houseFireDrill.findMany({
        where: { houseId },
        orderBy: [{ drillDate: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.houseComplianceIncident.findMany({
        where: { houseId, resolved: false },
        orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    const items = complianceRows.map((row) => ({
      key: row.category || row.id,
      label: row.label,
      score: row.score,
      status: row.status as 'GOOD' | 'WARNING' | 'CRITICAL',
      lastReviewed: row.lastReviewed
        ? this.toYmd(row.lastReviewed)
        : this.toYmd(row.updatedAt),
    }));

    const drills = fireDrillRows.map((row) => ({
      id: row.id,
      date: this.toYmd(row.drillDate),
      drillTimeLabel: row.drillTimeLabel || '',
      isSleepingDrill: Boolean(row.isSleepingDrill),
      isUnannounced: Boolean(row.isUnannounced),
      isUnderNormalStaffing: Boolean(row.isUnderNormalStaffing),
      evacuationTimeMinutes: row.evacuationTimeMinutes ?? null,
      allIndividualsEvacuated: Boolean(row.allIndividualsEvacuated),
      alarmType: row.alarmType || '',
      alarmOperative:
        typeof row.alarmOperative === 'boolean' ? row.alarmOperative : null,
      exitRouteUsed: row.exitRouteUsed || '',
      alternateExitUsed: Boolean(row.alternateExitUsed),
      meetingPlace: row.meetingPlace || '',
      problemsEncountered: row.problemsEncountered || '',
      correctiveAction: row.correctiveAction || '',
      conductedBy: row.conductedBy || '',
      staffPresent: row.staffPresent || '',
      notes: row.notes || '',
    }));

    let incidents = incidentRows.map((row) => ({
      id: row.id,
      title: row.title,
      detail: row.detail,
      status: row.status as 'GOOD' | 'WARNING' | 'CRITICAL',
      actionLabel: row.actionLabel || undefined,
      action: row.action || undefined,
    }));

    if (incidents.length === 0) {
      const residents = await this.prisma.individual.findMany({
        where: { houseId },
        select: {
          id: true,
          roomLabel: true,
          careRateTier: true,
          housingCoverage: true,
          homeVisitSchedule: true,
          residentialPlacementType: true,
          behaviorSupportLevel: true,
        },
      });

      const todayStart = this.startOfToday();
      const todayEnd = this.endOfToday();

      const shifts = await this.prisma.scheduleShift.findMany({
        where: {
          individual: { houseId },
          scheduleDate: {
            gte: todayStart,
            lte: todayEnd,
          },
        },
        include: {
          houseShiftStaffings: {
            select: { id: true },
          },
        },
      });

      const capacity = typeof house.capacity === 'number' ? house.capacity : 0;
      const residentCount = residents.length;
      const remainingBeds = Math.max(capacity - residentCount, 0);
      const occupancyStatus = this.getOccupancyStatus(residentCount, capacity);

      const missingRoomCount = residents.filter(
        (r) => !this.normalizeOptionalString(r.roomLabel),
      ).length;
      const missingCareRateTierCount = residents.filter(
        (r) => !this.normalizeOptionalString(r.careRateTier),
      ).length;
      const missingHousingCoverageCount = residents.filter(
        (r) => !this.normalizeOptionalString(r.housingCoverage),
      ).length;
      const missingHomeVisitScheduleCount = residents.filter(
        (r) =>
          r.residentialPlacementType === 'HOME_VISIT_SPLIT' &&
          !this.normalizeOptionalString(r.homeVisitSchedule),
      ).length;

      const alerts = await this.buildHouseAlerts(houseId, residents, shifts, {
        capacity,
        residentCount,
        remainingBeds,
        occupancyStatus,
        missingRoomCount,
        missingCareRateTierCount,
        missingHousingCoverageCount,
        missingHomeVisitScheduleCount,
      });

      incidents = alerts.map((alert) => ({
        id: alert.id,
        title: alert.title,
        detail: alert.detail,
        status:
          alert.level === 'CRITICAL'
            ? 'CRITICAL'
            : alert.level === 'WARNING'
              ? 'WARNING'
              : 'GOOD',
        actionLabel: alert.actionLabel,
        action: alert.action,
      }));
    }

    const warningItems = items.filter((i) => i.status === 'WARNING').length;
    const criticalItems = items.filter((i) => i.status === 'CRITICAL').length;
    const goodItems = items.filter((i) => i.status === 'GOOD').length;

    const overallComplianceScore =
      items.length > 0
        ? Math.round(
          (goodItems * 100 + warningItems * 75 + criticalItems * 40) /
          items.length,
        )
        : 0;

    const fireDrillSummary = this.buildFireDrillSummary(fireDrillRows);
    const availableAuditYears = this.buildAvailableAuditYears(fireDrillRows);
    const monthlyDrillMatrix = this.buildMonthlyDrillMatrix(fireDrillRows);

    return {
      houseId: house.id,
      houseName: house.name,
      house: {
        id: house.id,
        code: house.code,
        name: house.name,
        address: this.formatHouseAddress(house),
        county: house.county || '',
        phone: house.phone || '',
        programType: house.programType || 'Residential 6400',
      },
      summary: {
        overallComplianceScore,
        warningItems,
        criticalItems,
        lastReviewDate: this.todayAsYmd(),
      },
      fireDrillSummary,
      availableAuditYears,
      monthlyDrillMatrix,
      items,
      drills,
      incidents,
    };
  }

  async getAvailableIndividuals(filters: GetAvailableIndividualsFilters) {
    const search = (filters.search || '').trim();
    const statusText = (filters.status || '').trim().toUpperCase();

    const where: Prisma.IndividualWhereInput = {
      houseId: null,
    };

    const normalizedStatus = this.normalizeIndividualStatus(statusText);
    if (normalizedStatus) {
      where.status = normalizedStatus;
    }

    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { middleName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { medicaidId: { contains: search, mode: 'insensitive' } },
      ];
    }

    const items = await this.prisma.individual.findMany({
      where,
      select: {
        id: true,
        code: true,
        firstName: true,
        middleName: true,
        lastName: true,
        medicaidId: true,
        status: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });

    return {
      items: items.map((item) => ({
        id: item.id,
        code: item.code,
        name: this.individualFullName(item),
        maNumber: item.medicaidId || '',
        status: item.status || '',
      })),
      total: items.length,
    };
  }

  async getAvailableEmployees(filters: GetAvailableEmployeesFilters) {
    const search = (filters.search || '').trim();
    const houseId = (filters.houseId || '').trim();

    const employees = await this.prisma.employee.findMany({
      where: {
        ...(search
          ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { middleName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { role: { contains: search, mode: 'insensitive' } },
            ],
          }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        role: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });

    const employeeIds = employees.map((e) => e.id);

    const activeLinks =
      employeeIds.length > 0
        ? await this.prisma.houseEmployee.findMany({
          where: {
            employeeId: { in: employeeIds },
            isActive: true,
          },
          select: {
            employeeId: true,
            houseId: true,
            roleInHouse: true,
            isPrimary: true,
          },
        })
        : [];

    const activeLinkByEmployeeId = new Map(
      activeLinks.map((link) => [link.employeeId, link]),
    );

    const items = employees
      .filter((employee) => {
        const activeLink = activeLinkByEmployeeId.get(employee.id);

        if (!activeLink) return true;

        if (houseId && activeLink.houseId === houseId) {
          return false;
        }

        return false;
      })
      .map((employee) => ({
        id: employee.id,
        name: this.employeeFullName(employee),
        role: employee.role || 'DSP',
        status: 'AVAILABLE',
      }));

    return {
      items,
      total: items.length,
    };
  }

  async assignResidentToHouse(individualId: string, input: AssignResidentToHouseInput) {
    const houseId = (input.houseId || '').trim();

    if (!houseId) {
      throw new BadRequestException('houseId is required.');
    }

    const house = await this.prisma.house.findUnique({
      where: { id: houseId },
      select: {
        id: true,
        name: true,
        capacity: true,
      },
    });

    if (!house) {
      throw new NotFoundException('House not found.');
    }

    const individual = await this.prisma.individual.findUnique({
      where: { id: individualId },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        houseId: true,
        status: true,
      },
    });

    if (!individual) {
      throw new NotFoundException('Individual not found.');
    }

    if (individual.houseId === houseId) {
      return {
        id: individual.id,
        houseId,
        message: 'Resident is already assigned to this house.',
      };
    }

    if (individual.houseId) {
      throw new BadRequestException('Resident is already assigned to another house.');
    }

    const currentResidents = await this.prisma.individual.count({
      where: { houseId },
    });

    if (
      typeof house.capacity === 'number' &&
      house.capacity > 0 &&
      currentResidents >= house.capacity
    ) {
      throw new BadRequestException('This house is already at full capacity.');
    }

    const updated = await this.prisma.individual.update({
      where: { id: individualId },
      data: {
        houseId,
      },
      select: {
        id: true,
        houseId: true,
        firstName: true,
        middleName: true,
        lastName: true,
      },
    });

    return {
      id: updated.id,
      houseId: updated.houseId,
      name: this.individualFullName(updated),
      message: 'Resident assigned to house successfully.',
    };
  }

  async removeResidentFromHouse(individualId: string) {
    const individual = await this.prisma.individual.findUnique({
      where: { id: individualId },
      select: {
        id: true,
        houseId: true,
        firstName: true,
        middleName: true,
        lastName: true,
      },
    });

    if (!individual) {
      throw new NotFoundException('Individual not found.');
    }

    if (!individual.houseId) {
      return {
        id: individual.id,
        houseId: null,
        message: 'Resident is not assigned to any house.',
      };
    }

    const updated = await this.prisma.individual.update({
      where: { id: individualId },
      data: {
        houseId: null,
      },
      select: {
        id: true,
        houseId: true,
        firstName: true,
        middleName: true,
        lastName: true,
      },
    });

    return {
      id: updated.id,
      houseId: updated.houseId,
      name: this.individualFullName(updated),
      message: 'Resident removed from house successfully.',
    };
  }

  async assignStaffToHouse(employeeId: string, input: AssignStaffToHouseInput) {
    const houseId = (input.houseId || '').trim();
    const houseRole = this.normalizeHouseStaffRole(input.houseRole);
    const isPrimaryStaff = Boolean(input.isPrimaryStaff);

    if (!houseId) {
      throw new BadRequestException('houseId is required.');
    }

    if (!houseRole) {
      throw new BadRequestException('houseRole is required.');
    }

    const house = await this.prisma.house.findUnique({
      where: { id: houseId },
      select: {
        id: true,
        name: true,
      },
    });

    if (!house) {
      throw new NotFoundException('House not found.');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        role: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found.');
    }

    const activeAssignment = await this.prisma.houseEmployee.findFirst({
      where: {
        employeeId,
        isActive: true,
      },
      select: {
        id: true,
        houseId: true,
        roleInHouse: true,
        isPrimary: true,
      },
    });

    if (activeAssignment?.houseId && activeAssignment.houseId !== houseId) {
      throw new BadRequestException(
        'Employee is already assigned to another house.',
      );
    }

    const existingSameHouseAssignment = await this.prisma.houseEmployee.findFirst({
      where: {
        employeeId,
        houseId,
      },
      select: {
        id: true,
        houseId: true,
        roleInHouse: true,
        isPrimary: true,
        isActive: true,
      },
    });

    await this.prisma.$transaction(async (tx) => {
      if (isPrimaryStaff) {
        await tx.houseEmployee.updateMany({
          where: {
            houseId,
            isActive: true,
          },
          data: {
            isPrimary: false,
          },
        });
      }

      if (existingSameHouseAssignment) {
        await tx.houseEmployee.update({
          where: { id: existingSameHouseAssignment.id },
          data: {
            roleInHouse: houseRole,
            isPrimary: isPrimaryStaff,
            isActive: true,
          },
        });
      } else {
        await tx.houseEmployee.create({
          data: {
            houseId,
            employeeId,
            roleInHouse: houseRole,
            isPrimary: isPrimaryStaff,
            isActive: true,
          },
        });
      }
    });

    return {
      id: employee.id,
      houseId,
      name: this.employeeFullName(employee),
      houseRole,
      isPrimaryStaff,
      message: existingSameHouseAssignment
        ? 'Staff assignment reactivated successfully.'
        : 'Staff assigned to house successfully.',
    };
  }

  async removeStaffFromHouse(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found.');
    }

    const activeAssignment = await this.prisma.houseEmployee.findFirst({
      where: {
        employeeId,
        isActive: true,
      },
      select: {
        id: true,
        houseId: true,
      },
    });

    if (!activeAssignment) {
      return {
        id: employee.id,
        houseId: null,
        name: this.employeeFullName(employee),
        message: 'Staff is not assigned to any house.',
      };
    }

    await this.prisma.houseEmployee.update({
      where: { id: activeAssignment.id },
      data: {
        isActive: false,
        isPrimary: false,
      },
    });

    return {
      id: employee.id,
      houseId: null,
      name: this.employeeFullName(employee),
      message: 'Staff removed from house successfully.',
    };
  }

  async updateStaffHouseRole(
    employeeId: string,
    input: UpdateStaffHouseRoleInput,
  ) {
    const houseRole = this.normalizeHouseStaffRole(input.houseRole);
    const isPrimaryStaff =
      typeof input.isPrimaryStaff === 'boolean' ? input.isPrimaryStaff : undefined;

    if (!houseRole && typeof isPrimaryStaff === 'undefined') {
      throw new BadRequestException(
        'At least one of houseRole or isPrimaryStaff is required.',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found.');
    }

    const activeAssignment = await this.prisma.houseEmployee.findFirst({
      where: {
        employeeId,
        isActive: true,
      },
      select: {
        id: true,
        houseId: true,
        roleInHouse: true,
        isPrimary: true,
      },
    });

    if (!activeAssignment) {
      throw new BadRequestException(
        'Staff must be assigned to a house before updating house role.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (isPrimaryStaff === true) {
        await tx.houseEmployee.updateMany({
          where: {
            houseId: activeAssignment.houseId,
            isActive: true,
          },
          data: {
            isPrimary: false,
          },
        });
      }

      await tx.houseEmployee.update({
        where: { id: activeAssignment.id },
        data: {
          ...(houseRole ? { roleInHouse: houseRole } : {}),
          ...(typeof isPrimaryStaff === 'boolean'
            ? { isPrimary: isPrimaryStaff }
            : {}),
        },
      });
    });

    const refreshed = await this.prisma.houseEmployee.findUnique({
      where: { id: activeAssignment.id },
      select: {
        houseId: true,
        roleInHouse: true,
        isPrimary: true,
      },
    });

    return {
      id: employee.id,
      houseId: refreshed?.houseId || activeAssignment.houseId,
      name: this.employeeFullName(employee),
      houseRole: refreshed?.roleInHouse || activeAssignment.roleInHouse || 'DSP',
      isPrimaryStaff: Boolean(refreshed?.isPrimary),
      message: 'Staff house role updated successfully.',
    };
  }

  async updateResidentialProfile(
    individualId: string,
    input: UpdateResidentialProfileInput,
  ) {
    const individual = await this.prisma.individual.findUnique({
      where: { id: individualId },
      select: {
        id: true,
        houseId: true,
        firstName: true,
        middleName: true,
        lastName: true,
      },
    });

    if (!individual) {
      throw new NotFoundException('Individual not found.');
    }

    if (!individual.houseId) {
      throw new BadRequestException(
        'Resident must be assigned to a house before updating residential profile.',
      );
    }

    const residentialPlacementType = this.normalizeResidentialPlacementType(
      input.residentialPlacementType,
    );

    const behaviorSupportLevel = this.normalizeEnumValue(
      input.behaviorSupportLevel,
      ['NONE', 'MODERATE', 'INTENSIVE'],
      'behaviorSupportLevel',
    );

    const appointmentLoad = this.normalizeEnumValue(
      input.appointmentLoad,
      ['LOW', 'MODERATE', 'HIGH'],
      'appointmentLoad',
    );

    const homeVisitSchedule = this.normalizeOptionalString(input.homeVisitSchedule);
    const housingCoverage = this.normalizeOptionalString(input.housingCoverage);
    const careRateTier = this.normalizeOptionalString(input.careRateTier);
    const roomLabel = this.normalizeOptionalString(input.roomLabel);

    if (!residentialPlacementType) {
      throw new BadRequestException('residentialPlacementType is required.');
    }

    if (!homeVisitSchedule) {
      throw new BadRequestException('homeVisitSchedule is required.');
    }

    if (!housingCoverage) {
      throw new BadRequestException('housingCoverage is required.');
    }

    if (!careRateTier) {
      throw new BadRequestException('careRateTier is required.');
    }

    if (!behaviorSupportLevel) {
      throw new BadRequestException('behaviorSupportLevel is required.');
    }

    if (!appointmentLoad) {
      throw new BadRequestException('appointmentLoad is required.');
    }

    const updated = await this.prisma.individual.update({
      where: { id: individualId },
      data: {
        residentialPlacementType,
        homeVisitSchedule,
        housingCoverage,
        careRateTier,
        roomLabel,
        behaviorSupportLevel,
        appointmentLoad,
      },
      select: {
        id: true,
        houseId: true,
        firstName: true,
        middleName: true,
        lastName: true,
        residentialPlacementType: true,
        homeVisitSchedule: true,
        housingCoverage: true,
        careRateTier: true,
        roomLabel: true,
        behaviorSupportLevel: true,
        appointmentLoad: true,
      },
    });

    return {
      id: updated.id,
      houseId: updated.houseId,
      name: this.individualFullName(updated),
      residentialProfile: {
        residentialPlacementType: updated.residentialPlacementType,
        homeVisitSchedule: updated.homeVisitSchedule || '',
        housingCoverage: updated.housingCoverage || '',
        careRateTier: updated.careRateTier || '',
        roomLabel: updated.roomLabel || '',
        behaviorSupportLevel: updated.behaviorSupportLevel || 'NONE',
        appointmentLoad: updated.appointmentLoad || 'LOW',
      },
      message: 'Residential profile updated successfully.',
    };
  }

  async createHouse(input: CreateHouseInput) {
    const name = (input.name || '').trim();
    const code = (input.code || '').trim();
    const programType = (input.programType || 'Residential 6400').trim();
    const primaryOccupancyModel = (input.primaryOccupancyModel || 'SINGLE').trim();
    const county = (input.county || '').trim();
    const phone = (input.phone || '').trim();
    const address1 = (input.address1 || '').trim();
    const billingNote = (input.billingNote || '').trim();
    const careComplexityNote = (input.careComplexityNote || '').trim();

    if (!name) {
      throw new BadRequestException('House name is required.');
    }

    if (!code) {
      throw new BadRequestException('House code is required.');
    }

    const parsedCapacity =
      typeof input.capacity === 'number' ? input.capacity : Number(input.capacity || 0);

    if (!Number.isFinite(parsedCapacity) || parsedCapacity <= 0) {
      throw new BadRequestException('Capacity must be greater than 0.');
    }

    const existingCode = await this.prisma.house.findUnique({
      where: { code },
      select: { id: true },
    });

    if (existingCode) {
      throw new BadRequestException('House code already exists.');
    }

    const created = await this.prisma.house.create({
      data: {
        code,
        name,
        programType,
        status: 'ACTIVE',
        address1: address1 || null,
        county: county || null,
        phone: phone || null,
        capacity: parsedCapacity,
        primaryOccupancyModel,
        billingNote: billingNote || null,
        careComplexityNote: careComplexityNote || null,
      },
    });

    return {
      id: created.id,
      code: created.code,
      name: created.name,
      message: 'House created successfully.',
    };
  }

  async updateHouse(houseId: string, input: CreateHouseInput) {
    const existingHouse = await this.prisma.house.findUnique({
      where: { id: houseId },
      select: { id: true, code: true },
    });

    if (!existingHouse) {
      throw new NotFoundException('House not found.');
    }

    const name = (input.name || '').trim();
    const code = (input.code || '').trim();
    const programType = (input.programType || 'Residential 6400').trim();
    const primaryOccupancyModel = (input.primaryOccupancyModel || 'SINGLE').trim();
    const county = (input.county || '').trim();
    const phone = (input.phone || '').trim();
    const address1 = (input.address1 || '').trim();
    const billingNote = (input.billingNote || '').trim();
    const careComplexityNote = (input.careComplexityNote || '').trim();

    if (!name) {
      throw new BadRequestException('House name is required.');
    }

    if (!code) {
      throw new BadRequestException('House code is required.');
    }

    const parsedCapacity =
      typeof input.capacity === 'number' ? input.capacity : Number(input.capacity || 0);

    if (!Number.isFinite(parsedCapacity) || parsedCapacity <= 0) {
      throw new BadRequestException('Capacity must be greater than 0.');
    }

    const duplicateCode = await this.prisma.house.findFirst({
      where: {
        code,
        NOT: {
          id: houseId,
        },
      },
      select: { id: true },
    });

    if (duplicateCode) {
      throw new BadRequestException('House code already exists.');
    }

    const updated = await this.prisma.house.update({
      where: { id: houseId },
      data: {
        code,
        name,
        programType,
        address1: address1 || null,
        county: county || null,
        phone: phone || null,
        capacity: parsedCapacity,
        primaryOccupancyModel,
        billingNote: billingNote || null,
        careComplexityNote: careComplexityNote || null,
      },
    });

    return {
      id: updated.id,
      code: updated.code,
      name: updated.name,
      message: 'House updated successfully.',
    };
  }

  private async computeComplianceScore(houseId: string): Promise<number> {
    const realItems = await this.prisma.houseComplianceItem.findMany({
      where: { houseId },
      select: { status: true },
    });

    if (realItems.length > 0) {
      const goodItems = realItems.filter((i) => i.status === 'GOOD').length;
      const warningItems = realItems.filter((i) => i.status === 'WARNING').length;
      const criticalItems = realItems.filter((i) => i.status === 'CRITICAL').length;

      return Math.round(
        (goodItems * 100 + warningItems * 75 + criticalItems * 40) /
        realItems.length,
      );
    }

    const residentCount = await this.prisma.individual.count({
      where: { houseId },
    });

    const staffCount = await this.prisma.houseEmployee.count({
      where: { houseId, isActive: true },
    });

    const base = 75;
    const residentBonus = Math.min(residentCount * 3, 10);
    const staffBonus = Math.min(staffCount * 2, 12);

    return Math.min(base + residentBonus + staffBonus, 98);
  }

  private async computeOpenAlerts(houseId: string): Promise<number> {
    const incidentCount = await this.prisma.houseComplianceIncident.count({
      where: { houseId, resolved: false },
    });

    if (incidentCount > 0) return incidentCount;

    const residents = await this.prisma.individual.findMany({
      where: { houseId },
      select: {
        id: true,
        roomLabel: true,
        careRateTier: true,
        housingCoverage: true,
        homeVisitSchedule: true,
        residentialPlacementType: true,
        behaviorSupportLevel: true,
      },
    });

    const highNeedCount = residents.filter(
      (r) => (r.behaviorSupportLevel || '').toUpperCase() === 'INTENSIVE',
    ).length;

    const profileGapCount = residents.filter((r) => {
      if (!this.normalizeOptionalString(r.roomLabel)) return true;
      if (!this.normalizeOptionalString(r.careRateTier)) return true;
      if (!this.normalizeOptionalString(r.housingCoverage)) return true;
      if (
        r.residentialPlacementType === 'HOME_VISIT_SPLIT' &&
        !this.normalizeOptionalString(r.homeVisitSchedule)
      ) {
        return true;
      }
      return false;
    }).length;

    const combined = highNeedCount + profileGapCount;
    return combined > 0 ? combined : 1;
  }

  private async getPrimarySupervisorName(houseId: string): Promise<string> {
    const primary = await this.prisma.houseEmployee.findFirst({
      where: {
        houseId,
        isActive: true,
        OR: [
          { isPrimary: true },
          { roleInHouse: { contains: 'SUPERVISOR', mode: 'insensitive' } },
        ],
      },
      include: { employee: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    if (!primary?.employee) return '';

    return this.employeeFullName(primary.employee);
  }

  private async buildHouseAlerts(
    houseId: string,
    residents: Array<{
      behaviorSupportLevel: string | null;
      roomLabel?: string | null;
      careRateTier?: string | null;
      housingCoverage?: string | null;
      homeVisitSchedule?: string | null;
      residentialPlacementType?: string | null;
    }>,
    shifts: Array<{
      id: string;
      houseShiftStaffings: Array<{ id: string }>;
      awakeMonitoringRequired: boolean;
    }>,
    residentMetrics?: {
      capacity: number;
      residentCount: number;
      remainingBeds: number;
      occupancyStatus: 'AVAILABLE' | 'NEAR_FULL' | 'FULL';
      missingRoomCount: number;
      missingCareRateTierCount: number;
      missingHousingCoverageCount: number;
      missingHomeVisitScheduleCount: number;
    },
  ) {
    const alerts: Array<{
      id: string;
      level: 'CRITICAL' | 'WARNING' | 'INFO';
      title: string;
      detail: string;
      actionLabel: string;
      action: HouseAlertAction;
    }> = [];

    const intensiveResidents = residents.filter(
      (r) => (r.behaviorSupportLevel || '').toUpperCase() === 'INTENSIVE',
    ).length;

    if (residentMetrics?.occupancyStatus === 'FULL') {
      alerts.push({
        id: `alert-full-${houseId}`,
        level: 'CRITICAL',
        title: 'House is at full capacity',
        detail: `${residentMetrics.residentCount} of ${residentMetrics.capacity} beds are currently occupied.`,
        actionLabel: 'View Residents',
        action: 'VIEW_RESIDENTS',
      });
    } else if (residentMetrics?.occupancyStatus === 'NEAR_FULL') {
      alerts.push({
        id: `alert-near-full-${houseId}`,
        level: 'WARNING',
        title: 'House is nearing full capacity',
        detail: `${residentMetrics.remainingBeds} bed(s) remaining before this house is full.`,
        actionLabel: 'View Residents',
        action: 'VIEW_RESIDENTS',
      });
    }

    if (intensiveResidents > 0) {
      alerts.push({
        id: `alert-intensive-${houseId}`,
        level: 'CRITICAL',
        title: 'High-need resident support requires close staffing review',
        detail: `${intensiveResidents} resident(s) in this house are marked as intensive behavior support.`,
        actionLabel: 'Fix Staffing',
        action: 'VIEW_STAFFING',
      });
    }

    if ((residentMetrics?.missingRoomCount || 0) > 0) {
      alerts.push({
        id: `alert-missing-room-${houseId}`,
        level: 'WARNING',
        title: 'Some residents are missing room labels',
        detail: `${residentMetrics?.missingRoomCount} resident(s) do not have a room label assigned.`,
        actionLabel: 'View Residents',
        action: 'VIEW_RESIDENTS',
      });
    }

    if ((residentMetrics?.missingCareRateTierCount || 0) > 0) {
      alerts.push({
        id: `alert-missing-care-tier-${houseId}`,
        level: 'WARNING',
        title: 'Some residents are missing care rate tier',
        detail: `${residentMetrics?.missingCareRateTierCount} resident(s) do not have Care Rate Tier completed.`,
        actionLabel: 'View Residents',
        action: 'VIEW_RESIDENTS',
      });
    }

    if ((residentMetrics?.missingHousingCoverageCount || 0) > 0) {
      alerts.push({
        id: `alert-missing-housing-${houseId}`,
        level: 'WARNING',
        title: 'Some residents are missing housing coverage',
        detail: `${residentMetrics?.missingHousingCoverageCount} resident(s) do not have Housing Coverage completed.`,
        actionLabel: 'View Residents',
        action: 'VIEW_RESIDENTS',
      });
    }

    if ((residentMetrics?.missingHomeVisitScheduleCount || 0) > 0) {
      alerts.push({
        id: `alert-missing-home-visit-${houseId}`,
        level: 'WARNING',
        title: 'Some split-placement residents are missing home visit schedule',
        detail: `${residentMetrics?.missingHomeVisitScheduleCount} HOME_VISIT_SPLIT resident(s) do not have Home Visit Schedule completed.`,
        actionLabel: 'View Residents',
        action: 'VIEW_RESIDENTS',
      });
    }

    const underCoveredShifts = shifts.filter(
      (s) => s.houseShiftStaffings.length === 0,
    ).length;

    if (underCoveredShifts > 0) {
      alerts.push({
        id: `alert-understaffed-${houseId}`,
        level: 'WARNING',
        title: 'Some shifts do not have house staffing assignments',
        detail: `${underCoveredShifts} shift(s) need HouseShiftStaffing records.`,
        actionLabel: 'Fix Staffing',
        action: 'VIEW_STAFFING',
      });
    }

    const awakeShifts = shifts.filter((s) => s.awakeMonitoringRequired).length;

    if (awakeShifts > 0) {
      alerts.push({
        id: `alert-awake-${houseId}`,
        level: 'INFO',
        title: 'Awake monitoring shift detected',
        detail: `${awakeShifts} shift(s) today require awake monitoring.`,
        actionLabel: 'View Coverage',
        action: 'VIEW_COVERAGE',
      });
    }

    if (alerts.length === 0) {
      alerts.push({
        id: `alert-default-${houseId}`,
        level: 'INFO',
        title: 'No major operational alerts',
        detail: 'House is currently stable based on the available data.',
        actionLabel: 'View Dashboard',
        action: 'VIEW_DASHBOARD',
      });
    }

    return alerts;
  }

  private async buildComplianceBreakdown(houseId: string) {
    const realItems = await this.prisma.houseComplianceItem.findMany({
      where: { houseId },
      orderBy: [{ category: 'asc' }, { label: 'asc' }],
    });

    if (realItems.length > 0) {
      return realItems.map((row) => ({
        key: row.category || row.id,
        label: row.label,
        score: row.score,
        status: row.status as 'GOOD' | 'WARNING' | 'CRITICAL',
        lastReviewed: row.lastReviewed
          ? this.toYmd(row.lastReviewed)
          : this.toYmd(row.updatedAt),
      }));
    }

    const score = await this.computeComplianceScore(houseId);

    return [
      {
        key: 'fire',
        label: 'Fire Drill',
        score: Math.max(score - 5, 70),
        status: this.mapScoreToStatus(Math.max(score - 5, 70)),
        lastReviewed: this.todayAsYmd(),
      },
      {
        key: 'safety',
        label: 'Safety & Environment',
        score: Math.max(score, 72),
        status: this.mapScoreToStatus(Math.max(score, 72)),
        lastReviewed: this.todayAsYmd(),
      },
      {
        key: 'docs',
        label: 'House Documentation',
        score: Math.max(score - 8, 68),
        status: this.mapScoreToStatus(Math.max(score - 8, 68)),
        lastReviewed: this.todayAsYmd(),
      },
      {
        key: 'training',
        label: 'Staff Training',
        score: Math.max(score - 3, 72),
        status: this.mapScoreToStatus(Math.max(score - 3, 72)),
        lastReviewed: this.todayAsYmd(),
      },
      {
        key: 'med',
        label: 'Medication Documentation',
        score: Math.max(score, 74),
        status: this.mapScoreToStatus(Math.max(score, 74)),
        lastReviewed: this.todayAsYmd(),
      },
      {
        key: 'behavior',
        label: 'Behavior Support Documentation',
        score: Math.max(score - 4, 70),
        status: this.mapScoreToStatus(Math.max(score - 4, 70)),
        lastReviewed: this.todayAsYmd(),
      },
    ];
  }

  private async buildTimeline(houseId: string) {
    const recentShifts = await this.prisma.scheduleShift.findMany({
      where: {
        individual: {
          houseId,
        },
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 4,
      include: {
        individual: true,
      },
    });

    if (recentShifts.length === 0) {
      return [
        {
          id: `timeline-empty-${houseId}`,
          at: 'No recent activity',
          title: 'House timeline is empty',
          description: 'No recent shift updates were found for this house.',
          level: 'INFO',
        },
      ];
    }

    return recentShifts.map((shift) => ({
      id: shift.id,
      at: shift.updatedAt.toISOString(),
      title: `Shift updated for ${this.individualFullName(shift.individual)}`,
      description: `Status: ${shift.status}. Planned ${this.toHourMinute(shift.plannedStart)} - ${this.toHourMinute(shift.plannedEnd)}.`,
      level: shift.awakeMonitoringRequired ? 'WARNING' : 'INFO',
    }));
  }

  private countTodayMultiDspShifts(
    todayScheduleShifts: Array<{
      id: string;
      plannedDspId: string | null;
      actualDspId: string | null;
    }>,
    todayShiftStaffings: Array<{
      shiftId: string;
      employeeId: string;
    }>,
  ): number {
    const shiftToEmployees = new Map<string, Set<string>>();

    for (const shift of todayScheduleShifts) {
      const employeeSet = shiftToEmployees.get(shift.id) || new Set<string>();

      if (shift.plannedDspId) employeeSet.add(shift.plannedDspId);
      if (shift.actualDspId) employeeSet.add(shift.actualDspId);

      shiftToEmployees.set(shift.id, employeeSet);
    }

    for (const staffing of todayShiftStaffings) {
      const employeeSet =
        shiftToEmployees.get(staffing.shiftId) || new Set<string>();
      employeeSet.add(staffing.employeeId);
      shiftToEmployees.set(staffing.shiftId, employeeSet);
    }

    return Array.from(shiftToEmployees.values()).filter(
      (employeeSet) => employeeSet.size >= 2,
    ).length;
  }

  private isNowWithinShiftWindow(
    start: Date,
    end: Date,
    now: Date,
  ): boolean {
    const nowMs = now.getTime();
    const startMs = start.getTime();
    const endMs = end.getTime();

    if (endMs >= startMs) {
      return nowMs >= startMs && nowMs <= endMs;
    }

    const adjustedEnd = endMs + 24 * 60 * 60 * 1000;
    const adjustedNow =
      nowMs < startMs ? nowMs + 24 * 60 * 60 * 1000 : nowMs;

    return adjustedNow >= startMs && adjustedNow <= adjustedEnd;
  }

  private getOccupancyStatus(
    residentCount: number,
    capacity: number,
  ): 'AVAILABLE' | 'NEAR_FULL' | 'FULL' {
    if (!capacity || capacity <= 0) return 'AVAILABLE';
    if (residentCount >= capacity) return 'FULL';
    if (residentCount >= capacity - 1) return 'NEAR_FULL';
    return 'AVAILABLE';
  }

  private mapScoreToRisk(score: number): 'GOOD' | 'WARNING' | 'CRITICAL' {
    if (score >= 90) return 'GOOD';
    if (score >= 80) return 'WARNING';
    return 'CRITICAL';
  }

  private mapScoreToStatus(score: number): 'GOOD' | 'WARNING' | 'CRITICAL' {
    if (score >= 90) return 'GOOD';
    if (score >= 80) return 'WARNING';
    return 'CRITICAL';
  }

  private formatHouseAddress(house: {
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  }) {
    return [
      house.address1,
      house.address2,
      [house.city, house.state].filter(Boolean).join(', '),
      house.zip,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private employeeFullName(employee: {
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
  }) {
    return [employee.firstName, employee.middleName, employee.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  private individualFullName(individual: {
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
  }) {
    return [individual.firstName, individual.middleName, individual.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  private fallbackShiftStaff(shift: {
    plannedDsp?: {
      firstName?: string | null;
      middleName?: string | null;
      lastName?: string | null;
    } | null;
    actualDsp?: {
      firstName?: string | null;
      middleName?: string | null;
      lastName?: string | null;
    } | null;
  }) {
    const staff: Array<{ name: string; role: string }> = [];

    if (shift.actualDsp) {
      staff.push({
        name: this.employeeFullName(shift.actualDsp),
        role: 'Actual DSP',
      });
    }

    if (shift.plannedDsp) {
      const plannedName = this.employeeFullName(shift.plannedDsp);
      if (!staff.some((s) => s.name === plannedName)) {
        staff.push({
          name: plannedName,
          role: 'Planned DSP',
        });
      }
    }

    return staff;
  }

  private ageFromDob(dob?: string | null): number {
    if (!dob) return 0;

    const d = new Date(dob);
    if (Number.isNaN(d.getTime())) return 0;

    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const monthDiff = now.getMonth() - d.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < d.getDate())) {
      age -= 1;
    }

    return age;
  }

  private normalizeOptionalString(value?: string | null): string | null {
    const trimmed = (value || '').trim();
    return trimmed ? trimmed : null;
  }

  private normalizeEnumValue(
    value: string | undefined,
    allowedValues: string[],
    fieldName: string,
  ): string | null {
    const normalized = (value || '').trim().toUpperCase();

    if (!normalized) return null;

    if (!allowedValues.includes(normalized)) {
      throw new BadRequestException(
        `${fieldName} must be one of: ${allowedValues.join(', ')}.`,
      );
    }

    return normalized;
  }

  private normalizeHouseStaffRole(value?: string | null): string | null {
    const normalized = (value || '').trim().toUpperCase();

    if (!normalized) return null;

    const allowedValues = [
      'DSP',
      'SUPERVISOR',
      'BEHAVIOR SPECIALIST',
      'MED CERTIFIED',
    ];

    if (!allowedValues.includes(normalized)) {
      throw new BadRequestException(
        `houseRole must be one of: ${allowedValues.join(', ')}.`,
      );
    }

    return normalized;
  }

  private normalizeIndividualStatus(
    value?: string | null,
  ): IndividualStatus | undefined {
    const normalized = (value || '').trim().toUpperCase();

    if (!normalized || normalized === 'ALL') return undefined;

    if (normalized === IndividualStatus.ACTIVE) return IndividualStatus.ACTIVE;
    if (normalized === IndividualStatus.INACTIVE) return IndividualStatus.INACTIVE;
    if (normalized === IndividualStatus.PENDING) return IndividualStatus.PENDING;

    throw new BadRequestException(
      'status must be one of: ACTIVE, INACTIVE, PENDING.',
    );
  }

  private normalizeResidentialPlacementType(
    value?: string | null,
  ): ResidentialPlacementType | null {
    const normalized = (value || '').trim().toUpperCase();

    if (!normalized) return null;

    if (normalized === ResidentialPlacementType.FULL_TIME_247) {
      return ResidentialPlacementType.FULL_TIME_247;
    }

    if (normalized === ResidentialPlacementType.HOME_VISIT_SPLIT) {
      return ResidentialPlacementType.HOME_VISIT_SPLIT;
    }

    throw new BadRequestException(
      'residentialPlacementType must be one of: FULL_TIME_247, HOME_VISIT_SPLIT.',
    );
  }

  private buildFireDrillSummary(
    fireDrillRows: Array<{
      drillDate: Date;
      isSleepingDrill: boolean;
    }>,
  ) {
    const sorted = [...fireDrillRows].sort(
      (a, b) => b.drillDate.getTime() - a.drillDate.getTime(),
    );

    const lastDrill = sorted[0] || null;
    const lastSleepingDrill =
      sorted.find((row) => row.isSleepingDrill) || null;

    const now = new Date();

    const monthlyCompliant =
      !!lastDrill &&
      lastDrill.drillDate.getFullYear() === now.getFullYear() &&
      lastDrill.drillDate.getMonth() === now.getMonth();

    const sleepingDrillOverdue = lastSleepingDrill
      ? this.monthDiff(lastSleepingDrill.drillDate, now) >= 6
      : true;

    return {
      monthlyCompliant,
      sleepingDrillOverdue,
      lastDrillDate: lastDrill ? this.toYmd(lastDrill.drillDate) : '',
      lastSleepingDrillDate: lastSleepingDrill
        ? this.toYmd(lastSleepingDrill.drillDate)
        : '',
    };
  }

  private buildAvailableAuditYears(
    fireDrillRows: Array<{
      drillDate: Date;
    }>,
  ): number[] {
    const baseYear = 2026;
    const currentYear = new Date().getFullYear();
    const maxDataYear =
      fireDrillRows.length > 0
        ? Math.max(...fireDrillRows.map((row) => row.drillDate.getFullYear()))
        : currentYear;

    const lastYear = Math.max(maxDataYear, baseYear);
    const years: number[] = [];

    for (let year = lastYear; year >= baseYear; year -= 1) {
      years.push(year);
    }

    return years;
  }

  private buildMonthlyDrillMatrix(
    fireDrillRows: Array<{
      drillDate: Date;
      isSleepingDrill: boolean;
    }>,
  ) {
    const currentYear = new Date().getFullYear();
    const latestDrillDate =
      fireDrillRows.length > 0
        ? [...fireDrillRows].sort(
          (a, b) => b.drillDate.getTime() - a.drillDate.getTime(),
        )[0].drillDate
        : new Date();

    const targetYear = Math.max(latestDrillDate.getFullYear(), 2026, currentYear);

    const rows: Array<{
      year: number;
      month: number;
      label: string;
      hasDrill: boolean;
      hasSleepingDrill: boolean;
      status: 'OK' | 'MISSING' | 'SLEEPING_DONE';
    }> = [];

    for (let month = 0; month < 12; month += 1) {
      const monthlyRows = fireDrillRows.filter(
        (row) =>
          row.drillDate.getFullYear() === targetYear &&
          row.drillDate.getMonth() === month,
      );

      const hasDrill = monthlyRows.length > 0;
      const hasSleepingDrill = monthlyRows.some((row) => row.isSleepingDrill);

      const d = new Date(targetYear, month, 1);

      rows.push({
        year: targetYear,
        month: month + 1,
        label: d.toLocaleString('en-US', {
          month: 'short',
          year: 'numeric',
        }),
        hasDrill,
        hasSleepingDrill,
        status: hasSleepingDrill
          ? 'SLEEPING_DONE'
          : hasDrill
            ? 'OK'
            : 'MISSING',
      });
    }

    return rows;
  }

  async getOperations(houseId: string) {
    const house = await this.prisma.house.findUnique({
      where: { id: houseId },
      select: { id: true, name: true },
    });

    if (!house) {
      throw new NotFoundException('House not found');
    }

    const todayStart = this.startOfToday();
    const todayEnd = this.endOfToday();
    const now = new Date();

    // =========================
    // Residents
    // =========================
    const residents = await this.prisma.individual.findMany({
      where: { houseId },
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        behaviorSupportLevel: true,
      },
    });

    // =========================
    // Shifts today
    // =========================
    const shifts = await this.prisma.scheduleShift.findMany({
      where: {
        individual: { houseId },
        scheduleDate: {
          gte: todayStart,
          lte: todayEnd,
        },
      },
      include: {
        service: true,
        individual: true,
        houseShiftStaffings: {
          include: {
            employee: true,
          },
        },
        plannedDsp: true,
        actualDsp: true,
      },
      orderBy: [{ plannedStart: 'asc' }],
    });

    // =========================
    // Staff (for on-duty calc)
    // =========================
    const todayShiftStaffings = await this.prisma.houseShiftStaffing.findMany({
      where: {
        houseId,
        shift: {
          scheduleDate: {
            gte: todayStart,
            lte: todayEnd,
          },
        },
      },
      include: {
        employee: true,
        shift: true,
      },
    });

    // =========================
    // Incidents
    // =========================
    const incidents = await this.prisma.houseComplianceIncident.findMany({
      where: { houseId, resolved: false },
      orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
    });

    // =========================
    // Derived metrics
    // =========================
    const intensiveResidents = residents.filter(
      (r) => (r.behaviorSupportLevel || '').toUpperCase() === 'INTENSIVE',
    ).length;

    const awakeShifts = shifts.filter((s) => s.awakeMonitoringRequired).length;

    const unstaffedShifts = shifts.filter(
      (s) => s.houseShiftStaffings.length === 0,
    ).length;

    const onDutyStaffIds = new Set<string>();

    for (const s of todayShiftStaffings) {
      if (
        this.isNowWithinShiftWindow(
          s.shift.plannedStart,
          s.shift.plannedEnd,
          now,
        )
      ) {
        onDutyStaffIds.add(s.employeeId);
      }
    }

    // =========================
    // Coverage
    // =========================
    const coverage = shifts.map((shift) => {
      const staff =
        shift.houseShiftStaffings.length > 0
          ? shift.houseShiftStaffings.map((hs) =>
            this.employeeFullName(hs.employee),
          )
          : this.fallbackShiftStaff(shift).map((s) => s.name);

      return {
        id: shift.id,
        time: `${this.toHourMinute(shift.plannedStart)} - ${this.toHourMinute(
          shift.plannedEnd,
        )}`,
        service:
          shift.service?.serviceName ||
          shift.service?.serviceCode ||
          'Service',
        resident: this.individualFullName(shift.individual),
        staff,
        status: shift.status,
        awake: Boolean(shift.awakeMonitoringRequired),
        note: shift.notes || shift.backupNote || null,
      };
    });

    // =========================
    // Awake Monitoring
    // =========================
    const awakeMonitoring = coverage
      .filter((c) => c.awake)
      .map((c) => ({
        id: c.id,
        resident: c.resident,
        time: c.time,
        staff: c.staff,
        note: c.note,
      }));

    // =========================
    // Notes (from shifts)
    // =========================
    const notes = shifts
      .filter((s) => s.notes || s.backupNote)
      .slice(0, 6)
      .map((s) => ({
        id: s.id,
        time: s.updatedAt.toISOString(),
        title: `Update for ${this.individualFullName(s.individual)}`,
        detail:
          s.notes ||
          s.backupNote ||
          'Shift updated with no additional details.',
        level: s.awakeMonitoringRequired ? 'WARNING' : 'INFO',
      }));

    // =========================
    // Incidents map
    // =========================
    const mappedIncidents = incidents.map((i) => ({
      id: i.id,
      title: i.title,
      detail: i.detail,
      status: i.status as 'GOOD' | 'WARNING' | 'CRITICAL',
    }));

    // =========================
    // Summary
    // =========================
    const summary = {
      todayShifts: shifts.length,
      awakeShifts,
      onDutyStaff: onDutyStaffIds.size,
      intensiveResidents,
      openIncidents: mappedIncidents.length,
      unstaffedShifts,
    };

    // =========================
    // Phase 2 modules
    // =========================
    const phase2 = [
      {
        key: 'meals',
        label: 'Meals',
        description: 'Meal tracking not connected yet',
      },
      {
        key: 'medications',
        label: 'Medication',
        description: 'Medication administration not connected yet',
      },
      {
        key: 'appointments',
        label: 'Appointments',
        description: 'Appointment records not connected yet',
      },
      {
        key: 'chores',
        label: 'Chores',
        description: 'House routine tracking not connected yet',
      },
      {
        key: 'specialists',
        label: 'Specialist Visits',
        description: 'Specialist visit tracking not connected yet',
      },
    ];

    return {
      houseId: house.id,
      houseName: house.name,
      summary,
      coverage,
      awakeMonitoring,
      notes,
      incidents: mappedIncidents,
      phase2,
    };
  }

  private monthDiff(from: Date, to: Date): number {
    return (
      (to.getFullYear() - from.getFullYear()) * 12 +
      (to.getMonth() - from.getMonth())
    );
  }

  private toHourMinute(date: Date): string {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  private toYmd(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private startOfToday(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  }

  private endOfToday(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  }

  private todayAsYmd(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}