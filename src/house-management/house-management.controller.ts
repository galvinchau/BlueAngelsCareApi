// bac-hms/bac-api/src/house-management/house-management.controller.ts
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { HouseManagementService } from './house-management.service';

@Controller('house-management')
export class HouseManagementController {
  constructor(private readonly houseManagementService: HouseManagementService) {}

  @Get('houses')
  async getHouses(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('county') county?: string,
    @Query('risk') risk?: string,
  ) {
    return this.houseManagementService.getHouses({
      search,
      status,
      county,
      risk,
    });
  }

  @Get('dashboard/:houseId')
  async getDashboard(@Param('houseId') houseId: string) {
    return this.houseManagementService.getDashboard(houseId);
  }

  @Get('residents/:houseId')
  async getResidents(@Param('houseId') houseId: string) {
    return this.houseManagementService.getResidents(houseId);
  }

  @Get('staffing/:houseId')
  async getStaffing(@Param('houseId') houseId: string) {
    return this.houseManagementService.getStaffing(houseId);
  }

  @Get('compliance/:houseId')
  async getCompliance(@Param('houseId') houseId: string) {
    return this.houseManagementService.getCompliance(houseId);
  }

  @Get('available-individuals')
  async getAvailableIndividuals(
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.houseManagementService.getAvailableIndividuals({
      search,
      status,
    });
  }

  @Get('available-employees')
  async getAvailableEmployees(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('houseId') houseId?: string,
  ) {
    return this.houseManagementService.getAvailableEmployees({
      search,
      status,
      houseId,
    });
  }

  @Post('houses')
  async createHouse(
    @Body()
    body: {
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
    },
  ) {
    return this.houseManagementService.createHouse(body);
  }

  @Patch('houses/:houseId')
  async updateHouse(
    @Param('houseId') houseId: string,
    @Body()
    body: {
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
    },
  ) {
    return this.houseManagementService.updateHouse(houseId, body);
  }

  @Patch('residents/:individualId/assign-house')
  async assignResidentToHouse(
    @Param('individualId') individualId: string,
    @Body()
    body: {
      houseId?: string;
    },
  ) {
    return this.houseManagementService.assignResidentToHouse(individualId, body);
  }

  @Patch('residents/:individualId/remove-house')
  async removeResidentFromHouse(@Param('individualId') individualId: string) {
    return this.houseManagementService.removeResidentFromHouse(individualId);
  }

  @Patch('residents/:individualId/residential-profile')
  async updateResidentialProfile(
    @Param('individualId') individualId: string,
    @Body()
    body: {
      residentialPlacementType?: string;
      homeVisitSchedule?: string;
      housingCoverage?: string;
      careRateTier?: string;
      roomLabel?: string;
      behaviorSupportLevel?: string;
      appointmentLoad?: string;
    },
  ) {
    return this.houseManagementService.updateResidentialProfile(individualId, body);
  }

  @Patch('staff/:employeeId/assign-house')
  async assignStaffToHouse(
    @Param('employeeId') employeeId: string,
    @Body()
    body: {
      houseId?: string;
      houseRole?: string;
      isPrimaryStaff?: boolean;
    },
  ) {
    return this.houseManagementService.assignStaffToHouse(employeeId, body);
  }

  @Patch('staff/:employeeId/remove-house')
  async removeStaffFromHouse(@Param('employeeId') employeeId: string) {
    return this.houseManagementService.removeStaffFromHouse(employeeId);
  }

  @Patch('staff/:employeeId/house-role')
  async updateStaffHouseRole(
    @Param('employeeId') employeeId: string,
    @Body()
    body: {
      houseRole?: string;
      isPrimaryStaff?: boolean;
    },
  ) {
    return this.houseManagementService.updateStaffHouseRole(employeeId, body);
  }

  @Post('fire-drills')
  async createFireDrill(
    @Body()
    body: {
      houseId?: string;
      drillDate?: string;
      drillType?: string;
      shiftTime?: string;
      result?: string;
      conductedBy?: string;
      source?: string;
      location?: string;
      notes?: string;
    },
  ) {
    return this.houseManagementService.createFireDrill(body);
  }

  @Patch('fire-drills/:fireDrillId')
  async updateFireDrill(
    @Param('fireDrillId') fireDrillId: string,
    @Body()
    body: {
      drillDate?: string;
      drillType?: string;
      shiftTime?: string;
      result?: string;
      conductedBy?: string;
      source?: string;
      location?: string;
      notes?: string;
    },
  ) {
    return this.houseManagementService.updateFireDrill(fireDrillId, body);
  }
}