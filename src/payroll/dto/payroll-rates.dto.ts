import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RateUpsertItemDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rate!: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  trainingRate!: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  mileageRate!: number | null;
}

export class PayrollRatesUpsertDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RateUpsertItemDto)
  items!: RateUpsertItemDto[];
}
