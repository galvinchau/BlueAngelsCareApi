// src/app.module.ts
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { MobileModule } from './mobile/mobile.module';
import { MobileAuthModule } from './mobile/mobile-auth/mobile-auth.module';
import { ReportsModule } from './reports/reports.module';

// ✅ ADD
import { HealthController } from './health/health.controller';

// ✅ NEW modules
import { TimeKeepingModule } from './time-keeping/time-keeping.module';
import { EmployeesModule } from './employees/employees.module';

// ✅ PAYROLL
import { PayrollModule } from './payroll/payroll.module';

// ✅ MAIL (NEW)
import { MailModule } from './mail/mail.module';

@Module({
  imports: [
    // ✅ Serve /exports/* from local folder: uploads/exports
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads', 'exports'),
      serveRoot: '/exports',
    }),

    PrismaModule,

    // ✅ Mobile API
    MobileModule,
    MobileAuthModule,

    ReportsModule,

    // ✅ NEW
    TimeKeepingModule,
    EmployeesModule,

    // ✅ PAYROLL
    PayrollModule,

    // ✅ MAIL (NEW)
    MailModule,
  ],
  controllers: [
    AppController,
    HealthController, // ✅ ADD
  ],
  providers: [AppService],
})
export class AppModule {}