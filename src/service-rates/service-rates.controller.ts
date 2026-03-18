import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { BillingPayer } from '@prisma/client';
import { CreateServiceRateDto } from './dto/create-service-rate.dto';
import { UpdateServiceRateDto } from './dto/update-service-rate.dto';
import { ServiceRatesService } from './service-rates.service';

@Controller('service-rates')
export class ServiceRatesController {
  constructor(private readonly serviceRatesService: ServiceRatesService) {}

  // Lookup cho UI Rate Setup
  @Get('lookups')
  getLookups() {
    return this.serviceRatesService.getServiceLookup();
  }

  // List tất cả rate, optional filter payer=ODP
  @Get()
  findAll(@Query('payer') payer?: BillingPayer) {
    return this.serviceRatesService.findAll(payer);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.serviceRatesService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateServiceRateDto) {
    return this.serviceRatesService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateServiceRateDto) {
    return this.serviceRatesService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.serviceRatesService.remove(id);
  }
}