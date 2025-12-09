// src/mobile/mobile-auth/mobile-auth.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { MobileAuthService } from './mobile-auth.service';

@Controller('mobile/auth')
export class MobileAuthController {
  constructor(private readonly mobileAuthService: MobileAuthService) {}

  @Post('request-otp')
  async requestOtp(@Body('email') email: string) {
    await this.mobileAuthService.requestOtp(email);
    return { message: 'OTP sent' };
  }

  @Post('verify-otp')
  async verifyOtp(@Body() body: { email: string; code: string }) {
    const result = await this.mobileAuthService.verifyOtp(
      body.email,
      body.code,
    );
    return result;
  }
}
