import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ScheduleModule } from '@nestjs/schedule';
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

// ✅ VISITED MAINTENANCE
import { VisitedMaintenanceModule } from './visited-maintenance/visited-maintenance.module';

// ✅ SERVICE RATES
import { ServiceRatesModule } from './service-rates/service-rates.module';

// ✅ AWAKE CRON
import { AwakeModule } from './awake/awake.module';

// ✅ HOUSE MANAGEMENT
import { HouseManagementModule } from './house-management/house-management.module';

@Module({
  imports: [
    // ✅ Enable Nest cron / scheduler
    ScheduleModule.forRoot(),

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

    // ✅ VISITED MAINTENANCE
    VisitedMaintenanceModule,

    // ✅ SERVICE RATES
    ServiceRatesModule,

    // ✅ Awake Monitoring cron
    AwakeModule,

    // ✅ HOUSE MANAGEMENT
    HouseManagementModule,
  ],
  controllers: [
    AppController,
    HealthController, // ✅ ADD
  ],
  providers: [AppService],
})
export class AppModule {}