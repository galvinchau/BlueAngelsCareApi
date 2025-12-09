// src/mobile/mobile-auth/mobile-auth.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';

const MAIL_HOST = 'smtp.gmail.com';
const MAIL_PORT = 587;
const MAIL_USER = 'payroll.blueangelscare@gmail.com';
const MAIL_PASS = 'okoohnneznacdqut'; // App Password
const MAIL_FROM =
  '"Blue Angels Care Mobile" <payroll.blueangelscare@gmail.com>';

const OTP_EXPIRES_MINUTES = 10;

@Injectable()
export class MobileAuthService {
  constructor(private readonly prisma: PrismaService) {}

  // Nodemailer transporter dùng Gmail
  private transporter = nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: false, // dùng STARTTLS trên port 587
    auth: {
      user: MAIL_USER,
      pass: MAIL_PASS,
    },
  });

  // Tạo code 4 số, ví dụ 1234
  private generateOtpCode(): string {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  /**
   * Gửi OTP login tới email DSP
   */
  async requestOtp(email: string) {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      throw new BadRequestException('Email is required');
    }

    // 1. Tìm employee có email + isMobileUser = true
    const staff = await this.prisma.employee.findFirst({
      where: {
        email: trimmedEmail,
        isMobileUser: true,
      },
    });

    if (!staff) {
      throw new NotFoundException(
        'Mobile user not found. Please contact the office.',
      );
    }

    // 2. Tạo OTP + lưu vào bảng MobileLoginOtp
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

    // 3. Gửi email
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
   * Xác thực OTP login
   */
  async verifyOtp(email: string, code: string) {
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCode = code.trim();

    if (!trimmedEmail || !trimmedCode) {
      throw new BadRequestException('Email and code are required');
    }

    const now = new Date();

    // 1. Tìm OTP còn hạn, chưa dùng
    const otp = await this.prisma.mobileLoginOtp.findFirst({
      where: {
        email: trimmedEmail,
        code: trimmedCode,
        usedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!otp) {
      throw new BadRequestException('Invalid or expired code');
    }

    // 2. Lấy lại thông tin nhân viên
    const staff = await this.prisma.employee.findUnique({
      where: { id: otp.staffId },
    });

    if (!staff) {
      throw new NotFoundException('Employee not found');
    }

    // 3. Đánh dấu OTP đã dùng
    await this.prisma.mobileLoginOtp.update({
      where: { id: otp.id },
      data: { usedAt: now },
    });

    // 4. Trả về info cho Mobile (staffId, staffName, email)
    const staffName = `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim();

    return {
      staffId: staff.id,
      staffName,
      email: trimmedEmail,
    };
  }
}
