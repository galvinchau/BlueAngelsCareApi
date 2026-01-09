import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';

import { PayrollService } from './payroll.service';
import { PayrollGenerateDto } from './dto/payroll-generate.dto';
import { PayrollExportDto } from './dto/payroll-export.dto';
import { PayrollRatesUpsertDto } from './dto/payroll-rates.dto';

@Controller('payroll')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class PayrollController {
  constructor(private readonly svc: PayrollService) {}

  @Post('generate')
  async generate(@Body() dto: PayrollGenerateDto) {
    return this.svc.generate(dto.from, dto.to);
  }

  @Get('employees')
  async employees() {
    return this.svc.getEmployeesLite();
  }

  @Post('rates/upsert')
  async upsertRates(@Body() dto: PayrollRatesUpsertDto) {
    return this.svc.upsertRates(dto.items);
  }

  @Post('export/doc')
  async exportDoc(@Req() req: Request, @Body() dto: PayrollExportDto) {
    const baseUrl = this.svc.getBaseUrl(req);
    const docUrl = await this.svc.exportDoc(dto, baseUrl);
    return { docUrl };
  }

  @Post('export/pdf')
  async exportPdf() {
    // Follow-up after DOC is stable
    return { pdfUrl: null };
  }
}
