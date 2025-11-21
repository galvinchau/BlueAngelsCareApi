// src/prisma/prisma.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  // Kết nối DB khi module được khởi tạo
  async onModuleInit() {
    await this.$connect();
  }

  // Đóng kết nối khi app shutdown
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
