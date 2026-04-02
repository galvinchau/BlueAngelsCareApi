import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';

import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { GoogleReportsService } from '../reports/google-reports.service';

// ✅ Medications endpoints for Mobile
import { MobileMedicationsController } from './mobile.medications.controller';
import { MobileMedicationsService } from './mobile.medications.service';

// ✅ POC endpoints for Mobile
import { MobilePocController } from './mobile.poc.controller';
import { MobilePocService } from './mobile.poc.service';

// ✅ Push module
import { PushModule } from '../push/push.module';

@Module({
  imports: [PrismaModule, PushModule],
  controllers: [
    MobileController,
    MobileMedicationsController,
    MobilePocController,
  ],
  providers: [
    MobileService,
    MobileMedicationsService,
    MobilePocService,
    GoogleReportsService,
  ],
})
export class MobileModule {}