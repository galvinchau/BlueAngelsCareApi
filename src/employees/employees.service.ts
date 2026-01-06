import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async getMeByEmail(email: string) {
    const emp = await this.prisma.employee.findFirst({
      where: { email: email.trim().toLowerCase() },
      select: {
        employeeId: true,
        firstName: true,
        lastName: true,
        role: true,
        address1: true,
        address2: true,
        city: true,
        state: true,
        zip: true,
        phone: true,
        email: true,
      },
    });

    if (!emp) return null;

    return {
      staffId: emp.employeeId, // IMPORTANT: use employeeId as staffId for office time keeping
      firstName: emp.firstName,
      lastName: emp.lastName,
      position: emp.role || 'Office',
      address: [emp.address1, emp.address2, emp.city, emp.state, emp.zip]
        .filter(Boolean)
        .join(', '),
      phone: emp.phone || '',
      email: emp.email,
    };
  }
}
