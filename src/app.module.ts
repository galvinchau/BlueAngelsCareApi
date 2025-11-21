// src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MobileModule } from './mobile/mobile.module';
import { PrismaModule } from './prisma/prisma.module'; // 👈 thêm dòng này

@Module({
  imports: [
    PrismaModule, // 👈 và thêm PrismaModule vào đây
    MobileModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
