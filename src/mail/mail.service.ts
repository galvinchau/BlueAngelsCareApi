// src/mail/mail.service.ts
import { Injectable } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

export type SendCiAssignmentEmailArgs = {
  to: string;

  ciName?: string | null;

  individualName?: string | null;
  dspName?: string | null;
  incidentType?: string | null;
  reportDateLocal?: string | null;

  link?: string | null;

  // ✅ NEW
  attachments?: MailAttachment[];
};

@Injectable()
export class MailService {
  private transporter: Transporter | null = null;

  constructor() {
    const host = String(process.env.SMTP_HOST || '').trim();
    const portRaw = String(process.env.SMTP_PORT || '').trim();
    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASS || '').trim();

    if (!host || !portRaw || !user || !pass) {
      // keep system running even if smtp missing
      // eslint-disable-next-line no-console
      console.warn(
        '[MailService] SMTP not configured. Missing SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS',
      );
      this.transporter = null;
      return;
    }

    const port = Number(portRaw);
    const secure = port === 465; // 465 => secure, 587 => STARTTLS

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      tls: {
        // Gmail STARTTLS works fine; keep default strictness
        // rejectUnauthorized: true,
      },
    });
  }

  private fromHeader(): string {
    const from = String(process.env.EMAIL_FROM || '').trim();
    if (from) return from;

    const user = String(process.env.SMTP_USER || '').trim();
    return user ? `Blue Angels Care <${user}>` : 'Blue Angels Care';
  }

  private ensureTransporter() {
    if (!this.transporter) {
      throw new Error('SMTP transporter not configured');
    }
  }

  // =========================
  // CI Assignment email (with optional attachments)
  // =========================
  async sendCiAssignmentEmail(args: SendCiAssignmentEmailArgs) {
    this.ensureTransporter();

    const to = String(args.to || '').trim();
    if (!to) throw new Error('Missing "to" email');

    const ciName = (args.ciName ?? '').toString().trim();
    const individualName = (args.individualName ?? '').toString().trim();
    const dspName = (args.dspName ?? '').toString().trim();
    const incidentType = (args.incidentType ?? '').toString().trim();
    const dateLocal = (args.reportDateLocal ?? '').toString().trim();
    const _link = (args.link ?? '').toString().trim();

    const subject = `Blue Angels Care – CI Assignment${
      individualName ? ` – ${individualName}` : ''
    }`;

    const lines: string[] = [];
    lines.push(`Dear ${ciName || 'CI'},`);
    lines.push('');
    lines.push(
      'You are receiving this email based on the direction of your manager regarding a case that requires investigation.',
    );
    lines.push('');
    lines.push(
      'Please review the attached Health & Incident Report for the assigned case information.',
    );
    lines.push('');

    if (individualName) lines.push(`Individual: ${individualName}`);
    if (dspName) lines.push(`Reporter (DSP): ${dspName}`);
    if (incidentType) lines.push(`Incident Type: ${incidentType}`);
    if (dateLocal) lines.push(`Report Date: ${dateLocal}`);

    lines.push('');
    lines.push(
      'Please ensure that all investigation and follow-up activities are completed fully in compliance with the required procedures and professional standards of the company.',
    );
    lines.push('');
    lines.push(
      'If you encounter any difficulties or need consultation or support, please contact the company manager for guidance.',
    );
    lines.push('');
    lines.push('Sincerely,');
    lines.push('Blue Angels Care');

    const text = lines.join('\n');

    // ✅ attachments: pass-through to nodemailer
    const attachments =
      (args.attachments || []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType || 'application/octet-stream',
      })) || [];

    await this.transporter!.sendMail({
      from: this.fromHeader(),
      to,
      subject,
      text,
      attachments,
    });

    return { ok: true };
  }
}