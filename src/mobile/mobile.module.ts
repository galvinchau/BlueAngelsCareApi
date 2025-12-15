// src/mobile/mobile.module.ts
import { Module } from '@nestjs/common';
import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { GoogleReportsService } from '../reports/google-reports.service';

@Module({
  controllers: [MobileController],
  providers: [MobileService, GoogleReportsService],
})
export class MobileModule {}
