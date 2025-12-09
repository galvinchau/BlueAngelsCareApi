// src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { MobileModule } from './mobile/mobile.module';
import { MobileAuthModule } from './mobile/mobile-auth/mobile-auth.module'; // 👈 ĐÚNG theo path thật

@Module({
  imports: [
    PrismaModule,
    MobileModule,
    MobileAuthModule, // 👈 module OTP
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
