import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HouseManagementController } from './house-management.controller';
import { HouseManagementService } from './house-management.service';

@Module({
  imports: [PrismaModule],
  controllers: [HouseManagementController],
  providers: [HouseManagementService],
  exports: [HouseManagementService],
})
export class HouseManagementModule {}