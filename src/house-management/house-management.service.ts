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

type AssignResidentToHouseInput = {
  houseId?: string;
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

@Injectable()
export class HouseManagementService {
  constructor(private readonly prisma: PrismaService) {}

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
      orderBy: [{ createdAt: 'asc' }],
    });

    const todayStart = this.startOfToday();
    const todayEnd = this.endOfToday();

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

    const staffRows = houseEmployees.map((he) => {
      const employee = he.employee;
      const assignedToday = todayShiftStaffings.filter(
        (s) => s.employeeId === employee.id,
      );

      const currentShift = assignedToday[0]?.shift;

      return {
        id: employee.id,
        name: this.employeeFullName(employee),
        role: he.roleInHouse || employee.role || 'DSP',
        shiftToday: currentShift
          ? `${this.toHourMinute(currentShift.plannedStart)} - ${this.toHourMinute(currentShift.plannedEnd)}`
          : '',
        trainingStatus: 'CURRENT',
        medCertified: true,
        cpr: 'CURRENT',
        driver: 'ACTIVE',
        clearance: 'CURRENT',
        status: assignedToday.length > 0 ? 'ON_DUTY' : 'OFF_DUTY',
      };
    });

    const specialistsCount = staffRows.filter((s) =>
      String(s.role).toUpperCase().includes('BEHAVIOR'),
    ).length;

    const multiDspShiftCount = await this.countMultiDspShifts(houseId);

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
      items: staffRows,
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
        actionLabel: 'Open Dashboard',
      });
    } else if (residentMetrics?.occupancyStatus === 'NEAR_FULL') {
      alerts.push({
        id: `alert-near-full-${houseId}`,
        level: 'WARNING',
        title: 'House is nearing full capacity',
        detail: `${residentMetrics.remainingBeds} bed(s) remaining before this house is full.`,
        actionLabel: 'Open Dashboard',
      });
    }

    if (intensiveResidents > 0) {
      alerts.push({
        id: `alert-intensive-${houseId}`,
        level: 'CRITICAL',
        title: 'High-need resident support requires close staffing review',
        detail: `${intensiveResidents} resident(s) in this house are marked as intensive behavior support.`,
        actionLabel: 'Open Staffing',
      });
    }

    if ((residentMetrics?.missingRoomCount || 0) > 0) {
      alerts.push({
        id: `alert-missing-room-${houseId}`,
        level: 'WARNING',
        title: 'Some residents are missing room labels',
        detail: `${residentMetrics?.missingRoomCount} resident(s) do not have a room label assigned.`,
        actionLabel: 'Open Residents',
      });
    }

    if ((residentMetrics?.missingCareRateTierCount || 0) > 0) {
      alerts.push({
        id: `alert-missing-care-tier-${houseId}`,
        level: 'WARNING',
        title: 'Some residents are missing care rate tier',
        detail: `${residentMetrics?.missingCareRateTierCount} resident(s) do not have Care Rate Tier completed.`,
        actionLabel: 'Open Residents',
      });
    }

    if ((residentMetrics?.missingHousingCoverageCount || 0) > 0) {
      alerts.push({
        id: `alert-missing-housing-${houseId}`,
        level: 'WARNING',
        title: 'Some residents are missing housing coverage',
        detail: `${residentMetrics?.missingHousingCoverageCount} resident(s) do not have Housing Coverage completed.`,
        actionLabel: 'Open Residents',
      });
    }

    if ((residentMetrics?.missingHomeVisitScheduleCount || 0) > 0) {
      alerts.push({
        id: `alert-missing-home-visit-${houseId}`,
        level: 'WARNING',
        title: 'Some split-placement residents are missing home visit schedule',
        detail: `${residentMetrics?.missingHomeVisitScheduleCount} HOME_VISIT_SPLIT resident(s) do not have Home Visit Schedule completed.`,
        actionLabel: 'Open Residents',
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
        actionLabel: 'Open Dashboard',
      });
    }

    const awakeShifts = shifts.filter((s) => s.awakeMonitoringRequired).length;

    if (awakeShifts > 0) {
      alerts.push({
        id: `alert-awake-${houseId}`,
        level: 'INFO',
        title: 'Awake monitoring shift detected',
        detail: `${awakeShifts} shift(s) today require awake monitoring.`,
        actionLabel: 'Open Dashboard',
      });
    }

    if (alerts.length === 0) {
      alerts.push({
        id: `alert-default-${houseId}`,
        level: 'INFO',
        title: 'No major operational alerts',
        detail: 'House is currently stable based on the available data.',
        actionLabel: 'View Dashboard',
      });
    }

    return alerts;
  }

  private async buildComplianceBreakdown(houseId: string) {
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

  private async countMultiDspShifts(houseId: string): Promise<number> {
    const rows = await this.prisma.houseShiftStaffing.groupBy({
      by: ['shiftId'],
      where: { houseId },
      _count: {
        shiftId: true,
      },
    });

    return rows.filter((r) => (r._count.shiftId || 0) >= 2).length;
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
    return [house.address1, house.address2, [house.city, house.state].filter(Boolean).join(', '), house.zip]
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

  private toHourMinute(date: Date): string {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
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