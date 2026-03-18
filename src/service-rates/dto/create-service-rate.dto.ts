import { BillingPayer } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateServiceRateDto {
  @IsOptional()
  @IsEnum(BillingPayer)
  payer?: BillingPayer = BillingPayer.ODP;

  @IsString()
  @IsNotEmpty()
  serviceId!: string;

  @IsNumber()
  @Min(0)
  rate!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}