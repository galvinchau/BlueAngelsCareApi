// src/mobile/mobile.controller.ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

// Import type-only để tránh lỗi TS1272
import type {
  MobileDailyNotePayload,
  MobileIndividualLite,
} from './mobile.service';

// Import class service như bình thường
import { MobileService } from './mobile.service';

@Controller('mobile')
export class MobileController {
  constructor(private readonly mobileService: MobileService) {}

  /**
   * GET /mobile/shifts/today?staffId=...&date=YYYY-MM-DD
   */
  @Get('shifts/today')
  getTodayShifts(
    @Query('staffId') staffId: string,
    @Query('date') date: string,
  ) {
    return this.mobileService.getTodayShifts(staffId, date);
  }

  /**
   * ✅ Search Individuals
   * GET /mobile/individuals?search=...
   */
  @Get('individuals')
  async searchIndividuals(
    @Query('search') search?: string,
  ): Promise<{ items: MobileIndividualLite[] }> {
    const q = String(search ?? '').trim();
    const items = await this.mobileService.searchIndividuals(q);
    return { items };
  }

  /**
   * ✅ Today shifts for a specific individual
   * GET /mobile/individuals/:id/shifts/today?date=YYYY-MM-DD&staffId=...
   * staffId is optional (if provided, show only that DSP's visits/status)
   */
  @Get('individuals/:id/shifts/today')
  async getTodayShiftsForIndividual(
    @Param('id') individualId: string,
    @Query('date') date: string,
    @Query('staffId') staffId?: string,
  ) {
    return this.mobileService.getTodayShiftsForIndividual(
      individualId,
      date,
      staffId,
    );
  }

  /**
   * POST /mobile/daily-notes
   */
  @Post('daily-notes')
  submitDailyNote(@Body() payload: MobileDailyNotePayload) {
    return this.mobileService.submitDailyNote(payload);
  }

  /**
   * POST /mobile/shifts/:id/check-in
   */
  @Post('shifts/:id/check-in')
  checkIn(
    @Param('id') shiftId: string,
    @Body('staffId') staffId: string,
    @Body('clientTime') clientTime?: string,
  ) {
    return this.mobileService.checkInShift(shiftId, staffId, clientTime);
  }

  /**
   * POST /mobile/shifts/:id/check-out
   */
  @Post('shifts/:id/check-out')
  checkOut(
    @Param('id') shiftId: string,
    @Body('staffId') staffId: string,
    @Body('clientTime') clientTime?: string,
  ) {
    return this.mobileService.checkOutShift(shiftId, staffId, clientTime);
  }
}
