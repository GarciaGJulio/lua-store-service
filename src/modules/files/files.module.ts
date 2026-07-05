import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class CreateFileDto {
  @IsString()
  filename!: string;

  @IsString()
  mimeType!: string;

  @IsString()
  module!: string;

  @IsString()
  path!: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  size?: number;
}

@Injectable()
class FilesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.fileAsset.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  create(dto: CreateFileDto) {
    return this.prisma.fileAsset.create({ data: dto });
  }
}

@Controller('files')
class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Get()
  findAll() {
    return this.filesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateFileDto) {
    return this.filesService.create(dto);
  }
}

@Module({
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
