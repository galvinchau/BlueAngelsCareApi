import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BillingPayer, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceRateDto } from './dto/create-service-rate.dto';
import { UpdateServiceRateDto } from './dto/update-service-rate.dto';

@Injectable()
export class ServiceRatesService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizePayer(payer?: BillingPayer): BillingPayer {
    const finalPayer = payer ?? BillingPayer.ODP;

    if (finalPayer !== BillingPayer.ODP) {
      throw new BadRequestException('Rate Setup currently supports ODP only.');
    }

    return finalPayer;
  }

  private normalizeStartOfDay(value?: string | Date | null): Date {
    if (!value) {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      return now;
    }

    const dt = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(dt.getTime())) {
      throw new BadRequestException('Effective From is invalid.');
    }

    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  private normalizeEndOfDay(value?: string | Date | null): Date | null {
    if (!value) return null;

    const dt = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(dt.getTime())) {
      throw new BadRequestException('Effective To is invalid.');
    }

    dt.setHours(23, 59, 59, 999);
    return dt;
  }

  private validateEffectiveRange(
    effectiveFrom: Date,
    effectiveTo: Date | null,
  ) {
    if (effectiveTo && effectiveTo.getTime() < effectiveFrom.getTime()) {
      throw new BadRequestException(
        'Effective To cannot be earlier than Effective From.',
      );
    }
  }

  private async ensureServiceExists(serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        serviceCode: true,
        serviceName: true,
        billingCode: true,
        status: true,
        billable: true,
        category: true,
      },
    });

    if (!service) {
      throw new NotFoundException('Service not found.');
    }

    return service;
  }

  private mapRateRow(row: {
    id: string;
    payer: BillingPayer;
    serviceId: string;
    rate: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    isActive: boolean;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    service: {
      id: string;
      serviceCode: string;
      serviceName: string;
      billingCode: string | null;
      category: string;
      status: string;
      billable: boolean;
    };
  }) {
    return {
      id: row.id,
      payer: row.payer,
      serviceId: row.serviceId,
      serviceCode: row.service.serviceCode,
      serviceName: row.service.serviceName,
      billingCode: row.service.billingCode,
      category: row.service.category,
      serviceStatus: row.service.status,
      billable: row.service.billable,
      rate: row.rate,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      isActive: row.isActive,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async getServiceLookup() {
    const services = await this.prisma.service.findMany({
      where: {
        status: 'Active',
      },
      orderBy: [{ category: 'asc' }, { serviceCode: 'asc' }],
      select: {
        id: true,
        serviceCode: true,
        serviceName: true,
        billingCode: true,
        category: true,
        status: true,
        billable: true,
      },
    });

    return {
      payerOptions: [BillingPayer.ODP],
      services,
    };
  }

  async findAll(payer?: BillingPayer) {
    const finalPayer = payer ? this.normalizePayer(payer) : undefined;

    const rows = await this.prisma.serviceRate.findMany({
      where: finalPayer ? { payer: finalPayer } : undefined,
      orderBy: [
        { payer: 'asc' },
        { service: { category: 'asc' } },
        { service: { serviceCode: 'asc' } },
        { effectiveFrom: 'desc' },
      ],
      include: {
        service: {
          select: {
            id: true,
            serviceCode: true,
            serviceName: true,
            billingCode: true,
            category: true,
            status: true,
            billable: true,
          },
        },
      },
    });

    return {
      items: rows.map((row) => this.mapRateRow(row)),
    };
  }

  async findOne(id: string) {
    const row = await this.prisma.serviceRate.findUnique({
      where: { id },
      include: {
        service: {
          select: {
            id: true,
            serviceCode: true,
            serviceName: true,
            billingCode: true,
            category: true,
            status: true,
            billable: true,
          },
        },
      },
    });

    if (!row) {
      throw new NotFoundException('Service rate not found.');
    }

    return this.mapRateRow(row);
  }

  async create(dto: CreateServiceRateDto) {
    const payer = this.normalizePayer(dto.payer);
    const service = await this.ensureServiceExists(dto.serviceId);

    const effectiveFrom = this.normalizeStartOfDay((dto as any).effectiveFrom);
    const effectiveTo = this.normalizeEndOfDay((dto as any).effectiveTo);
    const isActive =
      typeof (dto as any).isActive === 'boolean' ? (dto as any).isActive : true;

    this.validateEffectiveRange(effectiveFrom, effectiveTo);

    try {
      const created = await this.prisma.serviceRate.create({
        data: {
          payer,
          serviceId: dto.serviceId,
          rate: Number(dto.rate),
          effectiveFrom,
          effectiveTo,
          isActive,
          notes: dto.notes?.trim() || null,
        },
        include: {
          service: {
            select: {
              id: true,
              serviceCode: true,
              serviceName: true,
              billingCode: true,
              category: true,
              status: true,
              billable: true,
            },
          },
        },
      });

      return {
        message: 'Service rate created successfully.',
        item: this.mapRateRow(created),
      };
    } catch (error: any) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `Rate already exists for payer ${payer}, service ${service.serviceCode}, and effective date.`,
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateServiceRateDto) {
    const existing = await this.prisma.serviceRate.findUnique({
      where: { id },
      include: {
        service: {
          select: {
            id: true,
            serviceCode: true,
            serviceName: true,
          },
        },
      },
    });

    if (!existing) {
      throw new NotFoundException('Service rate not found.');
    }

    const nextPayer = this.normalizePayer(dto.payer ?? existing.payer);
    const nextServiceId = dto.serviceId ?? existing.serviceId;

    await this.ensureServiceExists(nextServiceId);

    const nextEffectiveFrom =
      (dto as any).effectiveFrom !== undefined
        ? this.normalizeStartOfDay((dto as any).effectiveFrom)
        : existing.effectiveFrom;

    const nextEffectiveTo =
      (dto as any).effectiveTo !== undefined
        ? this.normalizeEndOfDay((dto as any).effectiveTo)
        : existing.effectiveTo;

    const nextIsActive =
      typeof (dto as any).isActive === 'boolean'
        ? (dto as any).isActive
        : existing.isActive;

    this.validateEffectiveRange(nextEffectiveFrom, nextEffectiveTo);

    try {
      const updated = await this.prisma.serviceRate.update({
        where: { id },
        data: {
          payer: nextPayer,
          serviceId: nextServiceId,
          rate: dto.rate !== undefined ? Number(dto.rate) : undefined,
          effectiveFrom: nextEffectiveFrom,
          effectiveTo: nextEffectiveTo,
          isActive: nextIsActive,
          notes: dto.notes !== undefined ? dto.notes.trim() || null : undefined,
        },
        include: {
          service: {
            select: {
              id: true,
              serviceCode: true,
              serviceName: true,
              billingCode: true,
              category: true,
              status: true,
              billable: true,
            },
          },
        },
      });

      return {
        message: 'Service rate updated successfully.',
        item: this.mapRateRow(updated),
      };
    } catch (error: any) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Another service rate already exists for this payer, service, and effective date.',
        );
      }
      throw error;
    }
  }

  async remove(id: string) {
    const existing = await this.prisma.serviceRate.findUnique({
      where: { id },
      include: {
        service: {
          select: {
            serviceCode: true,
            serviceName: true,
          },
        },
      },
    });

    if (!existing) {
      throw new NotFoundException('Service rate not found.');
    }

    await this.prisma.serviceRate.delete({
      where: { id },
    });

    return {
      message: 'Service rate deleted successfully.',
      deleted: {
        id: existing.id,
        payer: existing.payer,
        serviceCode: existing.service.serviceCode,
        serviceName: existing.service.serviceName,
        effectiveFrom: existing.effectiveFrom,
      },
    };
  }
}