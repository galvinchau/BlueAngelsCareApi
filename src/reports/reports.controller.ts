// src/reports/reports.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService, DailyNotesFilter } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('daily-notes')
  async getDailyNotes(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('staffId') staffId?: string,
    @Query('individualId') individualId?: string,
  ) {
    const filter: DailyNotesFilter = { from, to, staffId, individualId };
    const notes = await this.reportsService.getDailyNotes(filter);
    return { items: notes };
  }
}
