import { BillingPayer } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateServiceRateDto {
  @IsOptional()
  @IsEnum(BillingPayer)
  payer?: BillingPayer = BillingPayer.ODP;

  @IsString()
  @IsNotEmpty()
  serviceId!: string;

  // ✅ Fix: convert string -> number automatically
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rate!: number;

  @IsOptional()
  @IsString()
  notes?: string;

  // ✅ UI gửi yyyy-mm-dd là OK
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  // ✅ Fix: convert "true"/"false" -> boolean
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;
}