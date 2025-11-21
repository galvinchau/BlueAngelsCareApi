// src/prisma/prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global() // Để tất cả module khác có thể inject PrismaService mà không cần import lặp lại
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
