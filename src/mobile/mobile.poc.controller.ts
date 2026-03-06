// src/mobile/mobile.poc.controller.ts
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MobilePocService } from './mobile.poc.service';

@Controller('mobile/poc')
export class MobilePocController {
  constructor(private readonly svc: MobilePocService) {}

  /**
   * GET /mobile/poc/duties?shiftId=...
   */
  @Get('duties')
  async getDuties(@Query('shiftId') shiftId?: string) {
    return this.svc.getDutiesByShiftId(shiftId);
  }

  /**
   * GET /mobile/poc/daily-log?shiftId=...&date=YYYY-MM-DD
   */
  @Get('daily-log')
  async getDailyLog(
    @Query('shiftId') shiftId?: string,
    @Query('date') date?: string,
  ) {
    return this.svc.getDailyLog(shiftId, date);
  }

  /**
   * POST /mobile/poc/daily-log
   */
  @Post('daily-log')
  async saveDailyLog(@Body() body: any) {
    return this.svc.saveDailyLog(body);
  }
}