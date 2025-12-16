// src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { MobileModule } from './mobile/mobile.module';
import { MobileAuthModule } from './mobile/mobile-auth/mobile-auth.module';
import { ReportsModule } from './reports/reports.module';

// ✅ ADD
import { HealthController } from './health/health.controller';

@Module({
  imports: [PrismaModule, MobileModule, MobileAuthModule, ReportsModule],
  controllers: [
    AppController,
    HealthController, // ✅ ADD
  ],
  providers: [AppService],
})
export class AppModule {}
