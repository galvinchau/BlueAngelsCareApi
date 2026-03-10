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

export type SendCiConclusionSubmittedEmailArgs = {
  to: string;

  supervisorName?: string | null;
  ciName?: string | null;
  individualName?: string | null;
  incidentType?: string | null;
  reportDateLocal?: string | null;
  link?: string | null;
};

export type SendCaseClosedSummaryEmailArgs = {
  to: string | string[];

  individualName?: string | null;
  dspName?: string | null;
  ciName?: string | null;
  incidentType?: string | null;
  reportDateLocal?: string | null;

  finalDecision?: string | null;
  finalSummary?: string | null;

  closedByName?: string | null;
  closedDateLocal?: string | null;

  link?: string | null;
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

  private normalizeRecipients(input: string | string[]): string[] {
    const arr = Array.isArray(input) ? input : [input];
    return Array.from(
      new Set(
        arr
          .map((x) => String(x || '').trim())
          .filter(Boolean)
          .map((x) => x.toLowerCase()),
      ),
    );
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
    if (_link) {
      lines.push('');
      lines.push(`Case Link: ${_link}`);
    }

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

  // =========================
  // CI submitted investigation -> notify Supervisor
  // =========================
  async sendCiConclusionSubmittedEmail(
    args: SendCiConclusionSubmittedEmailArgs,
  ) {
    this.ensureTransporter();

    const to = String(args.to || '').trim();
    if (!to) throw new Error('Missing "to" email');

    const supervisorName = (args.supervisorName ?? '').toString().trim();
    const ciName = (args.ciName ?? '').toString().trim();
    const individualName = (args.individualName ?? '').toString().trim();
    const incidentType = (args.incidentType ?? '').toString().trim();
    const dateLocal = (args.reportDateLocal ?? '').toString().trim();
    const link = (args.link ?? '').toString().trim();

    const subject = `Blue Angels Care – Investigation Submitted${
      individualName ? ` – ${individualName}` : ''
    }`;

    const lines: string[] = [];
    lines.push(`Dear ${supervisorName || 'Supervisor'},`);
    lines.push('');
    lines.push(
      'The assigned Certified Investigator has submitted the investigation findings for review.',
    );
    lines.push('');

    if (individualName) lines.push(`Individual: ${individualName}`);
    if (ciName) lines.push(`Certified Investigator: ${ciName}`);
    if (incidentType) lines.push(`Incident Type: ${incidentType}`);
    if (dateLocal) lines.push(`Report Date: ${dateLocal}`);

    if (link) {
      lines.push('');
      lines.push(`Case Link: ${link}`);
    }

    lines.push('');
    lines.push(
      'Please review the submitted investigation and determine the next appropriate action, including whether the case should be closed or require additional follow-up.',
    );
    lines.push('');
    lines.push('Sincerely,');
    lines.push('Blue Angels Care');

    const text = lines.join('\n');

    await this.transporter!.sendMail({
      from: this.fromHeader(),
      to,
      subject,
      text,
    });

    return { ok: true };
  }

  // =========================
  // Case closed summary
  // =========================
  async sendCaseClosedSummaryEmail(args: SendCaseClosedSummaryEmailArgs) {
    this.ensureTransporter();

    const recipients = this.normalizeRecipients(args.to);
    if (!recipients.length) throw new Error('Missing "to" email');

    const individualName = (args.individualName ?? '').toString().trim();
    const dspName = (args.dspName ?? '').toString().trim();
    const ciName = (args.ciName ?? '').toString().trim();
    const incidentType = (args.incidentType ?? '').toString().trim();
    const dateLocal = (args.reportDateLocal ?? '').toString().trim();
    const finalDecision = (args.finalDecision ?? '').toString().trim();
    const finalSummary = (args.finalSummary ?? '').toString().trim();
    const closedByName = (args.closedByName ?? '').toString().trim();
    const closedDateLocal = (args.closedDateLocal ?? '').toString().trim();
    const link = (args.link ?? '').toString().trim();

    const subject = `Blue Angels Care – Case Closed${
      individualName ? ` – ${individualName}` : ''
    }`;

    const lines: string[] = [];
    lines.push('Hello,');
    lines.push('');
    lines.push(
      'This email is to formally notify you that a Health & Incident case has been reviewed and closed by Blue Angels Care.',
    );
    lines.push('');

    if (individualName) lines.push(`Individual: ${individualName}`);
    if (dspName) lines.push(`Reporter (DSP): ${dspName}`);
    if (ciName) lines.push(`Certified Investigator: ${ciName}`);
    if (incidentType) lines.push(`Incident Type: ${incidentType}`);
    if (dateLocal) lines.push(`Report Date: ${dateLocal}`);
    if (finalDecision) lines.push(`Final Decision: ${finalDecision}`);
    if (finalSummary) lines.push(`Final Summary: ${finalSummary}`);
    if (closedByName) lines.push(`Closed By: ${closedByName}`);
    if (closedDateLocal) lines.push(`Closed At: ${closedDateLocal}`);

    if (link) {
      lines.push('');
      lines.push(`Case Link: ${link}`);
    }

    lines.push('');
    lines.push(
      'This notification confirms that the case has completed the internal investigation process in accordance with applicable standards and regulatory requirements, including those established by relevant federal and state authorities, the Office of Developmental Programs (ODP), Administrative Entities (AE), and other applicable oversight bodies.',
    );
    lines.push('');
    lines.push(
      'All case details, investigative findings, supporting documentation, and internal processing outcomes are maintained confidentially within the appropriate departments of Blue Angels Care.',
    );
    lines.push('');
    lines.push(
      'When deemed necessary, Blue Angels Care may conduct follow-up internal reviews or meetings involving relevant individuals, departments, and parties associated with the case in order to reach final internal conclusions, implement corrective actions if applicable, provide retraining when necessary, and establish preventive measures to reduce the likelihood of similar incidents in the future.',
    );
    lines.push('');
    lines.push(
      'This email serves as a notification of case closure only and does not disclose the full investigative record.',
    );
    lines.push('');
    lines.push(
      'For any questions related to this matter, please contact the Blue Angels Care company office:',
    );
    lines.push('Blue Angels Care, LLC');
    lines.push('3107 Beale Avenue, Altoona, PA 16601');
    lines.push('Phone: (814) 600-2313');
    lines.push('Email: admin@blueangelscare.org');
    lines.push('');
    lines.push('Sincerely,');
    lines.push('Blue Angels Care');

    const text = lines.join('\n');

    await this.transporter!.sendMail({
      from: this.fromHeader(),
      to: recipients.join(', '),
      subject,
      text,
    });

    return { ok: true };
  }
}