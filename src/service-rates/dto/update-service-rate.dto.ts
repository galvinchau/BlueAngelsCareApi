import { BillingPayer } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateServiceRateDto {
  @IsOptional()
  @IsEnum(BillingPayer)
  payer?: BillingPayer;

  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rate?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}