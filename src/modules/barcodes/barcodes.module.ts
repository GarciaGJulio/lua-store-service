import { Body, Controller, Get, Injectable, Module, Post, StreamableFile } from '@nestjs/common';
import { BarcodeSourceType } from '@prisma/client';
import { IsArray, IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';
import { BarcodePdfService } from './barcode-pdf.service';

class CreateBarcodeDto {
  @IsString()
  code!: string;

  @IsString()
  description!: string;

  @IsNumber()
  @Min(0)
  publicPrice!: number;

  @IsOptional()
  @IsEnum(BarcodeSourceType)
  sourceType?: BarcodeSourceType;
}

class CreateBarcodeLabelsDto {
  @IsArray()
  @IsString({ each: true })
  codes!: string[];

  @IsOptional()
  @IsString()
  labelTitle!: string;
}

@Injectable()
class BarcodesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.barcode.findMany({
      include: {
        variant: {
          include: {
            product: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(dto: CreateBarcodeDto) {
    return this.prisma.barcode.create({
      data: {
        code: dto.code.trim(),
        description: dto.description.trim(),
        publicPrice: dto.publicPrice,
        sourceType: dto.sourceType ?? BarcodeSourceType.EXTERNAL,
      },
    });
  }
}

@Controller('barcodes')
class BarcodesController {
  constructor(
    private readonly barcodesService: BarcodesService,
    private readonly barcodePdfService: BarcodePdfService,
  ) {}

  @Get()
  findAll() {
    return this.barcodesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateBarcodeDto) {
    return this.barcodesService.create(dto);
  }

  @Post('labels/pdf')
  async renderPdf(@Body() dto: CreateBarcodeLabelsDto) {
    const buffer = await this.barcodePdfService.renderLabels(dto.codes, dto.labelTitle);

    return new StreamableFile(buffer, {
      disposition: 'inline; filename="barcode-labels.pdf"',
      type: 'application/pdf',
    });
  }
}

@Module({
  controllers: [BarcodesController],
  providers: [BarcodesService, BarcodePdfService],
})
export class BarcodesModule {}
