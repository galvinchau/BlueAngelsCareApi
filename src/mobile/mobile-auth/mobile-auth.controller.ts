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
    return this.mobileAuthService.verifyOtp(body.email, body.code);
  }

  /**
   * ✅ Remember login (90 days)
   * POST /mobile/auth/refresh
   * body: { refreshToken: string }
   */
  @Post('refresh')
  async refresh(@Body('refreshToken') refreshToken: string) {
    return this.mobileAuthService.refreshSession(refreshToken);
  }

  /**
   * ✅ Logout (revoke token)
   * POST /mobile/auth/logout
   * body: { refreshToken: string }
   */
  @Post('logout')
  async logout(@Body('refreshToken') refreshToken: string) {
    await this.mobileAuthService.logout(refreshToken);
    return { ok: true };
  }
}
