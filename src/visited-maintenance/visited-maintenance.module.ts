import { Module } from '@nestjs/common';
import { VisitedMaintenanceController } from './visited-maintenance.controller';
import { VisitedMaintenanceService } from './visited-maintenance.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [VisitedMaintenanceController],
  providers: [VisitedMaintenanceService],
})
export class VisitedMaintenanceModule {}