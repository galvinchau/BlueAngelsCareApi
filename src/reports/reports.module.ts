// src/reports/reports.module.ts
import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { FileReportsService } from './file-reports.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ReportsController],
  providers: [ReportsService, FileReportsService],
})
export class ReportsModule {}
