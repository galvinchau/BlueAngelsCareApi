// ======================================================
//  bac-hms/bac-api/src/awake/awake.module.ts
// ======================================================

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PushModule } from '../push/push.module';
import { AwakeCronService } from './awake.cron';

@Module({
  imports: [PrismaModule, PushModule],
  providers: [AwakeCronService],
  exports: [AwakeCronService],
})
export class AwakeModule {}