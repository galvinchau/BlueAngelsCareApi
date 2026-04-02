// ======================================================
//  bac-hms/bac-api/src/awake/awake.module.ts
// ======================================================

import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AwakeCronService } from './awake.cron';

@Module({
  providers: [PrismaService, AwakeCronService],
  exports: [AwakeCronService],
})
export class AwakeModule {}