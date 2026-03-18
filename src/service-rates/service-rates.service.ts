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

  private async ensureServiceExists(serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        serviceCode: true,
        serviceName: true,
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
      orderBy: [{ payer: 'asc' }, { service: { category: 'asc' } }, { service: { serviceCode: 'asc' } }],
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
      items: rows.map((row) => ({
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
        notes: row.notes,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
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
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async create(dto: CreateServiceRateDto) {
    const payer = this.normalizePayer(dto.payer);
    const service = await this.ensureServiceExists(dto.serviceId);

    try {
      const created = await this.prisma.serviceRate.create({
        data: {
          payer,
          serviceId: dto.serviceId,
          rate: Number(dto.rate),
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
        item: {
          id: created.id,
          payer: created.payer,
          serviceId: created.serviceId,
          serviceCode: created.service.serviceCode,
          serviceName: created.service.serviceName,
          billingCode: created.service.billingCode,
          category: created.service.category,
          serviceStatus: created.service.status,
          billable: created.service.billable,
          rate: created.rate,
          notes: created.notes,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      };
    } catch (error: any) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `Rate already exists for payer ${payer} and service ${service.serviceCode}.`,
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

    try {
      const updated = await this.prisma.serviceRate.update({
        where: { id },
        data: {
          payer: nextPayer,
          serviceId: nextServiceId,
          rate: dto.rate !== undefined ? Number(dto.rate) : undefined,
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
        item: {
          id: updated.id,
          payer: updated.payer,
          serviceId: updated.serviceId,
          serviceCode: updated.service.serviceCode,
          serviceName: updated.service.serviceName,
          billingCode: updated.service.billingCode,
          category: updated.service.category,
          serviceStatus: updated.service.status,
          billable: updated.service.billable,
          rate: updated.rate,
          notes: updated.notes,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      };
    } catch (error: any) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Another service rate already exists for this payer and service.',
        );
      }
      throw error;
    }
  }

  async remove(id: string) {
    const existing = await this.prisma.serviceRate.findUnique({
      where: { id },
      select: {
        id: true,
        payer: true,
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
      },
    };
  }
}