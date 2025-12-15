// src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { MobileModule } from './mobile/mobile.module';
import { MobileAuthModule } from './mobile/mobile-auth/mobile-auth.module';

// ✅ Reports module (Phase 1)
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    PrismaModule,
    MobileModule,
    MobileAuthModule,
    ReportsModule, // ✅ enable /reports/daily-notes endpoint
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
