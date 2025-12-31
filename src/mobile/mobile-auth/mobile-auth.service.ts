// src/mobile/mobile-auth/mobile-auth.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import * as crypto from 'crypto';

const MAIL_HOST = process.env.MOBILE_MAIL_HOST || 'smtp.gmail.com';
const MAIL_PORT = Number(process.env.MOBILE_MAIL_PORT || 587);
const MAIL_USER =
  process.env.MOBILE_MAIL_USER || 'payroll.blueangelscare@gmail.com';
const MAIL_PASS = process.env.MOBILE_MAIL_PASS || 'okoohnneznacdqut'; // fallback for current setup
const MAIL_FROM =
  process.env.MOBILE_MAIL_FROM ||
  '"Blue Angels Care Mobile" <payroll.blueangelscare@gmail.com>';

const OTP_EXPIRES_MINUTES = 10;

// ✅ 90 days remember-login
const REFRESH_TOKEN_DAYS = 90;

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function genRefreshTokenPlain(): string {
  // 48 bytes => long enough, URL-safe base64
  return crypto.randomBytes(48).toString('base64url');
}

@Injectable()
export class MobileAuthService {
  constructor(private readonly prisma: PrismaService) {}

  private transporter = nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: false,
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });

  private generateOtpCode(): string {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  async requestOtp(email: string) {
    const trimmedEmail = String(email || '')
      .trim()
      .toLowerCase();
    if (!trimmedEmail) throw new BadRequestException('Email is required');

    const staff = await this.prisma.employee.findFirst({
      where: { email: trimmedEmail, isMobileUser: true },
    });

    if (!staff) {
      throw new NotFoundException(
        'Mobile user not found. Please contact the office.',
      );
    }

    const code = this.generateOtpCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OTP_EXPIRES_MINUTES * 60 * 1000);

    await this.prisma.mobileLoginOtp.create({
      data: {
        email: trimmedEmail,
        code,
        staffId: staff.id,
        staffName: `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim(),
        expiresAt,
      },
    });

    const displayName =
      `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim();

    const textBody =
      `Hello ${displayName || 'DSP'},\n\n` +
      `Your 4-digit login code for Blue Angels Care Mobile is: ${code}\n` +
      `This code will expire in ${OTP_EXPIRES_MINUTES} minutes.\n\n` +
      `If you did not request this code, please contact the Blue Angels Care office.`;

    const htmlBody =
      `<p>Hello ${displayName || 'DSP'},</p>` +
      `<p>Your 4-digit login code for <b>Blue Angels Care Mobile</b> is:</p>` +
      `<p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${code}</p>` +
      `<p>This code will expire in ${OTP_EXPIRES_MINUTES} minutes.</p>` +
      `<p>If you did not request this code, please contact the Blue Angels Care office.</p>`;

    try {
      await this.transporter.sendMail({
        from: MAIL_FROM,
        to: trimmedEmail,
        subject: 'Your Blue Angels Care Mobile login code',
        text: textBody,
        html: htmlBody,
      });
    } catch (err) {
      console.error('[MobileAuthService] sendMail error:', err);
      throw new InternalServerErrorException('Failed to send OTP email');
    }

    return { ok: true };
  }

  /**
   * ✅ Verify OTP -> issue refresh token (90 days)
   */
  async verifyOtp(email: string, code: string) {
    const trimmedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const trimmedCode = String(code || '').trim();

    if (!trimmedEmail || !trimmedCode) {
      throw new BadRequestException('Email and code are required');
    }

    const now = new Date();

    const otp = await this.prisma.mobileLoginOtp.findFirst({
      where: {
        email: trimmedEmail,
        code: trimmedCode,
        usedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) throw new BadRequestException('Invalid or expired code');

    const staff = await this.prisma.employee.findUnique({
      where: { id: otp.staffId },
    });
    if (!staff) throw new NotFoundException('Employee not found');

    await this.prisma.mobileLoginOtp.update({
      where: { id: otp.id },
      data: { usedAt: now },
    });

    // ✅ Create refresh token row
    const refreshToken = genRefreshTokenPlain();
    const tokenHash = sha256Hex(refreshToken);
    const expiresAt = addDays(now, REFRESH_TOKEN_DAYS);

    // Optional: revoke old tokens for this staff (clean-up)
    await this.prisma.mobileRefreshToken.updateMany({
      where: {
        staffId: staff.id,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    await this.prisma.mobileRefreshToken.create({
      data: {
        staffId: staff.id,
        email: trimmedEmail,
        tokenHash,
        expiresAt,
      },
    });

    const staffName = `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim();

    return {
      staffId: staff.id,
      staffName,
      email: trimmedEmail,

      // ✅ return remember token to device
      refreshToken,
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * ✅ Refresh session without OTP
   * - validate tokenHash exists, not revoked, not expired
   * - rotate token (best practice)
   */
  async refreshSession(refreshToken: string) {
    const token = String(refreshToken || '').trim();
    if (!token) throw new BadRequestException('refreshToken is required');

    const now = new Date();
    const tokenHash = sha256Hex(token);

    const row = await this.prisma.mobileRefreshToken.findUnique({
      where: { tokenHash },
    });

    if (!row || row.revokedAt) {
      throw new BadRequestException('Invalid refresh token');
    }
    if (row.expiresAt <= now) {
      // expire -> force OTP
      throw new BadRequestException('Refresh token expired');
    }

    const staff = await this.prisma.employee.findUnique({
      where: { id: row.staffId },
    });
    if (!staff) throw new NotFoundException('Employee not found');

    // ✅ rotate token + extend expiry to 90 days from now
    const newToken = genRefreshTokenPlain();
    const newHash = sha256Hex(newToken);
    const newExpiresAt = addDays(now, REFRESH_TOKEN_DAYS);

    try {
      await this.prisma.mobileRefreshToken.update({
        where: { tokenHash },
        data: {
          tokenHash: newHash,
          expiresAt: newExpiresAt,
          revokedAt: null,
        },
      });
    } catch (err) {
      // If unique collision (extremely unlikely), fail safe
      console.error('[MobileAuthService] refresh rotate failed:', err);
      throw new InternalServerErrorException('Failed to refresh session');
    }

    const staffName = `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim();

    return {
      staffId: staff.id,
      staffName,
      email: row.email,

      refreshToken: newToken,
      refreshExpiresAt: newExpiresAt.toISOString(),
    };
  }

  /**
   * ✅ Logout: revoke refresh token
   */
  async logout(refreshToken: string) {
    const token = String(refreshToken || '').trim();
    if (!token) throw new BadRequestException('refreshToken is required');

    const now = new Date();
    const tokenHash = sha256Hex(token);

    await this.prisma.mobileRefreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now },
    });

    return { ok: true };
  }
}
