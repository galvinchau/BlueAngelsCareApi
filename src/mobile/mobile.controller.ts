// src/mobile/mobile.controller.ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

// Import type-only để tránh lỗi TS1272
import type { MobileDailyNotePayload } from './mobile.service';
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
   * POST /mobile/daily-notes
   */
  @Post('daily-notes')
  submitDailyNote(@Body() payload: MobileDailyNotePayload) {
    return this.mobileService.submitDailyNote(payload);
  }

  /**
   * POST /mobile/shifts/:id/check-in
   * Body: { staffId: "STAFF_DEMO", clientTime?: "2025-11-21T03:15:04.324Z" }
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
   * Body: { staffId: "STAFF_DEMO", clientTime?: "2025-11-21T05:55:10.000Z" }
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
