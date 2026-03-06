// src/mobile/mobile.medications.controller.ts
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MobileMedicationsService } from './mobile.medications.service';

@Controller('mobile/medications')
export class MobileMedicationsController {
  constructor(private readonly svc: MobileMedicationsService) {}

  /**
   * GET /mobile/medications/orders?shiftId=...
   * - Resolve shift -> individualId -> active MedicationOrder list
   */
  @Get('orders')
  async getOrders(@Query('shiftId') shiftId?: string) {
    return this.svc.getOrdersByShiftId(shiftId || '');
  }

  /**
   * GET /mobile/medications/mar?shiftId=...&date=YYYY-MM-DD(optional)
   * - Resolve shift -> individualId -> MedicationAdministration for that date (local day)
   */
  @Get('mar')
  async getMar(@Query('shiftId') shiftId?: string, @Query('date') date?: string) {
    return this.svc.getMarByShiftId(shiftId || '', date);
  }

  /**
   * POST /mobile/medications/mar
   * Body: { shiftId, orderId, scheduledDateTime, status, ... }
   */
  @Post('mar')
  async createMar(@Body() body: any) {
    return this.svc.createAdministration(body);
  }
}