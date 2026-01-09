import { IsString, Matches } from 'class-validator';

const DATE_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

export class PayrollGenerateDto {
  @IsString()
  @Matches(DATE_YYYY_MM_DD)
  from!: string;

  @IsString()
  @Matches(DATE_YYYY_MM_DD)
  to!: string;
}
