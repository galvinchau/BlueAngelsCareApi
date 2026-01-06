import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly svc: EmployeesService) {}

  @Get('me')
  async me(@Headers('x-user-email') userEmail?: string) {
    if (!userEmail) {
      throw new BadRequestException('Missing x-user-email');
    }

    const profile = await this.svc.getMeByEmail(userEmail);
    if (!profile) throw new NotFoundException('Employee profile not found');
    return profile;
  }
}
