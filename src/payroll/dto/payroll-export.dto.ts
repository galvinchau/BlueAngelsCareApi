import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

const DATE_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

export class PayrollExportDto {
  @IsString()
  @IsNotEmpty()
  runId!: string;

  @IsString()
  @Matches(DATE_YYYY_MM_DD)
  periodFrom!: string;

  @IsString()
  @Matches(DATE_YYYY_MM_DD)
  periodTo!: string;

  @IsString()
  @IsIn(['ALL', 'DSP', 'OFFICE'])
  staffTypeFilter!: 'ALL' | 'DSP' | 'OFFICE';

  @IsOptional()
  @IsObject()
  weeklyExtras?: Record<
    string,
    {
      trainingHours?: number;
      sickHours?: number;
      holidayHours?: number;
      ptoHours?: number;
      mileage?: number;
    }
  >;
}
