import { Body, Controller, Get, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { IsInt, IsNumber, IsString, Min } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class CreateVariantDto {
  @IsString()
  productId!: string;

  @IsString()
  sizeLabel!: string;

  @IsString()
  colorLabel!: string;

  @IsString()
  barcodeId!: string;

  @IsInt()
  @Min(0)
  stock!: number;

  @IsNumber()
  @Min(0)
  cost!: number;

  @IsNumber()
  @Min(0)
  price!: number;
}

class AdjustStockDto {
  @IsInt()
  quantity!: number;
}

@Injectable()
class VariantsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.variant.findMany({
      include: {
        barcode: true,
        product: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(dto: CreateVariantDto) {
    return this.prisma.variant.create({
      data: {
        barcodeId: dto.barcodeId,
        colorLabel: dto.colorLabel.trim(),
        cost: dto.cost,
        price: dto.price,
        productId: dto.productId,
        sizeLabel: dto.sizeLabel.trim(),
        stock: dto.stock,
      },
      include: {
        barcode: true,
        product: true,
      },
    });
  }

  updateStock(id: string, dto: AdjustStockDto) {
    return this.prisma.variant.update({
      data: {
        stock: {
          increment: dto.quantity,
        },
      },
      where: { id },
    });
  }
}

@Controller('variants')
class VariantsController {
  constructor(private readonly variantsService: VariantsService) {}

  @Get()
  findAll() {
    return this.variantsService.findAll();
  }

  @Post()
  create(@Body() dto: CreateVariantDto) {
    return this.variantsService.create(dto);
  }

  @Patch(':id/stock')
  updateStock(@Param('id') id: string, @Body() dto: AdjustStockDto) {
    return this.variantsService.updateStock(id, dto);
  }
}

@Module({
  controllers: [VariantsController],
  providers: [VariantsService],
})
export class VariantsModule {}
