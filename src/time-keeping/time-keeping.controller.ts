import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Body,
  ForbiddenException,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { TimeKeepingService } from './time-keeping.service';

type CheckBody = {
  staffId?: string; // ✅ allow optional (resolve by email)
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  source?: 'WEB' | 'MOBILE';
  clientTime?: string;

  // optional: permission context fallback
  userType?: string;
  userEmail?: string;
  userId?: string;
};

function readCtx(
  req: Request,
  fallback?: { userType?: string; userEmail?: string; userId?: string },
) {
  const hUserType = (req.headers['x-user-type'] as string) || '';
  const hUserEmail = (req.headers['x-user-email'] as string) || '';
  const hUserId = (req.headers['x-user-id'] as string) || '';

  const userType =
    (hUserType || fallback?.userType || '').toString() || 'ADMIN';
  const userEmail =
    (hUserEmail || fallback?.userEmail || '').toString() || 'admin@local';
  const userId = (hUserId || fallback?.userId || '').toString() || 'admin';

  return { userType, userEmail, userId };
}

@Controller('time-keeping')
export class TimeKeepingController {
  constructor(private readonly svc: TimeKeepingService) {}

  // ---------- Office self endpoints ----------
  @Get('status')
  async getStatus(
    @Req() req: Request,
    @Query('staffId') staffId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    // fallback ctx (optional)
    @Query('userType') userTypeFromQuery?: string,
    @Query('userEmail') userEmailFromQuery?: string,
    @Query('userId') userIdFromQuery?: string,
  ) {
    if (!from || !to) throw new BadRequestException('Missing from/to');

    const ctx = readCtx(req, {
      userType: userTypeFromQuery,
      userEmail: userEmailFromQuery,
      userId: userIdFromQuery,
    });

    // ✅ staffId can be omitted; service will resolve by ctx.userEmail
    return this.svc.getStatus({ staffId, from, to, ctx });
  }

  @Get('attendance')
  async getAttendance(
    @Req() req: Request,
    @Query('staffId') staffId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    // fallback ctx (optional)
    @Query('userType') userTypeFromQuery?: string,
    @Query('userEmail') userEmailFromQuery?: string,
    @Query('userId') userIdFromQuery?: string,
  ) {
    if (!from || !to) throw new BadRequestException('Missing from/to');

    const ctx = readCtx(req, {
      userType: userTypeFromQuery,
      userEmail: userEmailFromQuery,
      userId: userIdFromQuery,
    });

    return this.svc.getAttendance({ staffId, from, to, ctx });
  }

  @Post('check-in')
  async checkIn(@Req() req: Request, @Body() body: CheckBody) {
    const ctx = readCtx(req, {
      userType: body.userType,
      userEmail: body.userEmail,
      userId: body.userId,
    });

    // ✅ staffId optional; resolve by ctx.userEmail
    return this.svc.checkIn({
      staffId: body.staffId,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy,
      source: body.source || 'WEB',
      clientTime: body.clientTime,
      ctx,
    });
  }

  @Post('check-out')
  async checkOut(@Req() req: Request, @Body() body: CheckBody) {
    const ctx = readCtx(req, {
      userType: body.userType,
      userEmail: body.userEmail,
      userId: body.userId,
    });

    return this.svc.checkOut({
      staffId: body.staffId,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy,
      source: body.source || 'WEB',
      clientTime: body.clientTime,
      ctx,
    });
  }

  // ---------- Admin/HR approval endpoints ----------
  @Get('admin/weekly')
  async adminWeekly(
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('status') status?: 'PENDING' | 'APPROVED' | 'ALL',
    @Query('userType') userTypeFromQuery?: string, // keep fallback
    @Query('userEmail') userEmailFromQuery?: string,
    @Query('userId') userIdFromQuery?: string,
  ) {
    if (!from || !to) throw new BadRequestException('Missing from/to');
    const ctx = readCtx(req, {
      userType: userTypeFromQuery,
      userEmail: userEmailFromQuery,
      userId: userIdFromQuery,
    });

    return this.svc.adminListWeekly({
      from,
      to,
      q: q || '',
      status: status || 'ALL',
      ctx,
    });
  }

  @Get('admin/weekly/:staffId')
  async adminWeeklyDetail(
    @Req() req: Request,
    @Param('staffId') staffId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userType') userTypeFromQuery?: string,
    @Query('userEmail') userEmailFromQuery?: string,
    @Query('userId') userIdFromQuery?: string,
  ) {
    if (!from || !to) throw new BadRequestException('Missing from/to');
    const ctx = readCtx(req, {
      userType: userTypeFromQuery,
      userEmail: userEmailFromQuery,
      userId: userIdFromQuery,
    });

    return this.svc.adminGetWeeklyDetail({ staffId, from, to, ctx });
  }

  @Post('admin/weekly/:staffId/adjust')
  async adminAdjust(
    @Req() req: Request,
    @Param('staffId') staffId: string,
    @Body()
    body: {
      from: string;
      to: string;
      adjustedMinutes: number;
      reason?: string;

      // fallback ctx
      userType?: string;
      userEmail?: string;
      userId?: string;
    },
  ) {
    if (!body?.from || !body?.to)
      throw new BadRequestException('Missing from/to');
    if (!Number.isFinite(body.adjustedMinutes) || body.adjustedMinutes < 0) {
      throw new BadRequestException('adjustedMinutes must be >= 0');
    }

    const ctx = readCtx(req, {
      userType: body.userType,
      userEmail: body.userEmail,
      userId: body.userId,
    });

    return this.svc.adminAdjustWeekly({
      staffId,
      from: body.from,
      to: body.to,
      adjustedMinutes: Math.round(body.adjustedMinutes),
      reason: body.reason || '',
      ctx,
    });
  }

  @Post('admin/weekly/:staffId/approve')
  async adminApprove(
    @Req() req: Request,
    @Param('staffId') staffId: string,
    @Body()
    body: {
      from: string;
      to: string;
      reason?: string;

      // fallback ctx
      userType?: string;
      userEmail?: string;
      userId?: string;
    },
  ) {
    if (!body?.from || !body?.to)
      throw new BadRequestException('Missing from/to');

    const ctx = readCtx(req, {
      userType: body.userType,
      userEmail: body.userEmail,
      userId: body.userId,
    });

    return this.svc.adminApproveWeekly({
      staffId,
      from: body.from,
      to: body.to,
      reason: body.reason || '',
      ctx,
    });
  }

  @Post('admin/weekly/:staffId/unlock')
  async adminUnlock(
    @Req() req: Request,
    @Param('staffId') staffId: string,
    @Body()
    body: {
      from: string;
      to: string;
      reason?: string;

      // fallback ctx
      userType?: string;
      userEmail?: string;
      userId?: string;
    },
  ) {
    if (!body?.from || !body?.to)
      throw new BadRequestException('Missing from/to');
    if (!body.reason || body.reason.trim().length < 3) {
      throw new ForbiddenException('Unlock requires a reason.');
    }

    const ctx = readCtx(req, {
      userType: body.userType,
      userEmail: body.userEmail,
      userId: body.userId,
    });

    return this.svc.adminUnlockWeekly({
      staffId,
      from: body.from,
      to: body.to,
      reason: body.reason,
      ctx,
    });
  }
}
