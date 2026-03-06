// src/prisma/prisma.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      // ✅ Optional: bật log khi DEV để debug nhanh (không ảnh hưởng production nếu anh không muốn)
      log:
        process.env.NODE_ENV === "production"
          ? []
          : ["query", "info", "warn", "error"],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}