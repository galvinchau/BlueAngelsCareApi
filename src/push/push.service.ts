// ======================================================
//  bac-hms/bac-api/src/push/push.service.ts
// ======================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: 'default' | null;
};

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: 'default';
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expoPushUrl = 'https://exp.host/--/api/v2/push/send';

  constructor(private readonly prisma: PrismaService) {}

  isExpoPushToken(token?: string | null): boolean {
    const value = String(token || '').trim();
    return (
      value.startsWith('ExponentPushToken[') ||
      value.startsWith('ExpoPushToken[')
    );
  }

  private async sendExpoMessages(messages: ExpoPushMessage[]) {
    if (!messages.length) return { data: [] };

    const res = await fetch(this.expoPushUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const text = await res.text();

    if (!res.ok) {
      this.logger.error(
        `[PushService] Expo push send failed (${res.status}): ${text}`,
      );
      throw new Error(
        `Expo push send failed (${res.status}): ${text || res.statusText}`,
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  async getActiveTokensForStaff(staffId: string): Promise<string[]> {
    const rows = await this.prisma.mobilePushToken.findMany({
      where: {
        staffId,
        isActive: true,
        revokedAt: null,
      },
      select: {
        expoPushToken: true,
      },
    });

    return rows
      .map((r) => String(r.expoPushToken || '').trim())
      .filter((token) => this.isExpoPushToken(token));
  }

  async sendToStaff(
    staffId: string,
    payload: PushPayload,
  ): Promise<{ sent: number; tokens: string[]; response?: any }> {
    const tokens = await this.getActiveTokensForStaff(staffId);

    if (!tokens.length) {
      this.logger.warn(
        `[PushService] No active push tokens found for staffId=${staffId}`,
      );
      return { sent: 0, tokens: [] };
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: {
        ...(payload.data ?? {}),
        priority: 'high',
      },
      ...(payload.sound === 'default' ? { sound: 'default' } : {}),
      priority: 'high',
      channelId: 'default',
    }));

    const response = await this.sendExpoMessages(messages);

    this.logger.log(
      `[PushService] Sent push to staffId=${staffId}, tokens=${tokens.length}`,
    );

    return {
      sent: tokens.length,
      tokens,
      response,
    };
  }

  async sendTestToStaff(staffId: string) {
    return this.sendToStaff(staffId, {
      title: 'BAC Test Notification',
      body: 'Push notifications are connected successfully.',
      sound: 'default',
      data: {
        type: 'TEST_PUSH',
        ts: new Date().toISOString(),
      },
    });
  }
}