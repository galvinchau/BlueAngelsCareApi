// src/mobile/mobile-auth/mobile-auth.module.ts
import { Module } from '@nestjs/common';
import { MobileAuthController } from './mobile-auth.controller';
import { MobileAuthService } from './mobile-auth.service';

@Module({
  controllers: [MobileAuthController],
  providers: [MobileAuthService],
})
export class MobileAuthModule {}
