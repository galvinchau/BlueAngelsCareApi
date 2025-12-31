import { Controller, Get, Query } from '@nestjs/common';
import { MobileService } from '../mobile/mobile.service';

@Controller()
export class IndividualsController {
  constructor(private readonly mobileService: MobileService) {}

  // ✅ Alias to avoid 404 if someone hits /individuals?search=...
  @Get('individuals')
  async searchIndividuals(@Query('search') search?: string) {
    const q = (search || '').trim();
    const items = await this.mobileService.searchIndividuals(q);
    return { items };
  }
}
