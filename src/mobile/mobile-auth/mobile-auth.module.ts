// src/mobile/mobile-auth/mobile-auth.module.ts
import { Module } from '@nestjs/common';
import { MobileAuthController } from './mobile-auth.controller';
import { MobileAuthService } from './mobile-auth.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [MobileAuthController],
  providers: [MobileAuthService],
  exports: [MobileAuthService],
})
export class MobileAuthModule {}
