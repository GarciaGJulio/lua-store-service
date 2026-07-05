import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { IsDateString, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class CreateTaxDto {
  @IsString()
  name!: string;

  @IsString()
  code!: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  rate!: number;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;
}

@Injectable()
class TaxesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.tax.findMany({
      orderBy: { rate: 'asc' },
    });
  }

  create(dto: CreateTaxDto) {
    return this.prisma.tax.create({
      data: {
        code: dto.code,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
        effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : undefined,
        name: dto.name,
        rate: dto.rate,
      },
    });
  }
}

@Controller('taxes')
class TaxesController {
  constructor(private readonly taxesService: TaxesService) {}

  @Get()
  findAll() {
    return this.taxesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateTaxDto) {
    return this.taxesService.create(dto);
  }
}

@Module({
  controllers: [TaxesController],
  providers: [TaxesService],
})
export class TaxesModule {}
