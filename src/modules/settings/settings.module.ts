import { Body, Controller, Get, Injectable, Module, Param, Put } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsObject } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class UpsertSettingDto {
  @IsObject()
  value!: Record<string, unknown>;
}

@Injectable()
class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.setting.findMany({
      orderBy: { key: 'asc' },
    });
  }

  upsert(key: string, dto: UpsertSettingDto) {
    return this.prisma.setting.upsert({
      where: { key },
      update: {
        value: dto.value as Prisma.InputJsonValue,
      },
      create: {
        key,
        value: dto.value as Prisma.InputJsonValue,
      },
    });
  }
}

@Controller('settings')
class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  findAll() {
    return this.settingsService.findAll();
  }

  @Put(':key')
  upsert(@Param('key') key: string, @Body() dto: UpsertSettingDto) {
    return this.settingsService.upsert(key, dto);
  }
}

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
