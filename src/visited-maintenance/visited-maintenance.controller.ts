// bac-hms/bac-api/src/visited-maintenance/visited-maintenance.controller.ts

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { VisitedMaintenanceService } from './visited-maintenance.service';

@Controller('visited-maintenance')
export class VisitedMaintenanceController {
  constructor(
    private readonly visitedMaintenanceService: VisitedMaintenanceService,
  ) {}

  @Get('visits')
  async listVisits() {
    return this.visitedMaintenanceService.listVisits();
  }

  @Get('visits/:id/gps')
  async getVisitGps(@Param('id') id: string) {
    return this.visitedMaintenanceService.getVisitGps(id);
  }

  @Post('visits/:id/review')
  async markReviewed(@Param('id') id: string) {
    return this.visitedMaintenanceService.markReviewed(id);
  }

  @Post('visits/review-bulk')
  async markReviewedBulk(@Body() body: { visitIds: string[] }) {
    return this.visitedMaintenanceService.markReviewedBulk(body.visitIds || []);
  }
}