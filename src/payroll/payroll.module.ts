import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

@Module({
  imports: [PrismaModule],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
