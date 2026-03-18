import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ServiceRatesController } from './service-rates.controller';
import { ServiceRatesService } from './service-rates.service';

@Module({
  controllers: [ServiceRatesController],
  providers: [ServiceRatesService, PrismaService],
})
export class ServiceRatesModule {}