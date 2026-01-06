import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TimeKeepingController } from './time-keeping.controller';
import { TimeKeepingService } from './time-keeping.service';

@Module({
  imports: [PrismaModule],
  controllers: [TimeKeepingController],
  providers: [TimeKeepingService],
})
export class TimeKeepingModule {}
