import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { Prisma } from '@prisma/client';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  Max,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class CreateProductVariantDto {
  @IsString()
  sizeLabel!: string;

  @IsString()
  colorLabel!: string;

  @IsString()
  barcode!: string;

  @IsNumber()
  @Min(0)
  stock!: number;

  @IsNumber()
  @Min(0)
  cost!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;
}

class UpdateProductVariantDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  sizeLabel!: string;

  @IsString()
  colorLabel!: string;

  @IsString()
  barcode!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  stock?: number;

  @IsNumber()
  @Min(0)
  cost!: number;

  @IsNumber()
  @Min(0)
  price!: number;
}

class CreateProductDto {
  @IsString()
  sku!: string;

  @IsString()
  name!: string;

  @IsString()
  categoryId!: string;

  @IsString()
  subcategoryId!: string;

  @IsString()
  taxId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultPrice?: number;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateProductVariantDto)
  variants!: CreateProductVariantDto[];
}

class UpdateProductDto {
  @IsString()
  sku!: string;

  @IsString()
  name!: string;

  @IsString()
  categoryId!: string;

  @IsString()
  subcategoryId!: string;

  @IsString()
  taxId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultPrice?: number;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpdateProductVariantDto)
  variants!: UpdateProductVariantDto[];
}

class FindInventoryProductsQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

const productDetailsInclude = {
  category: true,
  subcategory: true,
  tax: true,
  variants: {
    include: {
      barcode: true,
    },
    orderBy: [{ sizeLabel: 'asc' }, { colorLabel: 'asc' }],
  },
} satisfies Prisma.ProductInclude;

type NormalizedVariantPayload = {
  id?: string;
  barcode: string;
  colorLabel: string;
  cost: number;
  price: number;
  sizeLabel: string;
  stock: number;
};

@Injectable()
class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.product.findMany({
      include: productDetailsInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findInventoryPage(query: FindInventoryProductsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const where = this.buildInventoryWhere(query);

    const [items, totalItems, stockSummary] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        include: productDetailsInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        where,
      }),
      this.prisma.product.count({ where }),
      this.prisma.product.aggregate({
        _sum: { totalStock: true },
        where,
      }),
    ]);

    return {
      items,
      meta: {
        limit,
        page,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      },
      summary: {
        totalProducts: totalItems,
        totalStock: stockSummary._sum.totalStock ?? 0,
      },
    };
  }

  async create(dto: CreateProductDto) {
    const sku = dto.sku.trim();
    const name = dto.name.trim();
    const variants = dto.variants.map((variant) => ({
      barcode: variant.barcode.trim(),
      colorLabel: variant.colorLabel.trim(),
      cost: variant.cost,
      price: variant.price ?? dto.defaultPrice ?? 0,
      sizeLabel: variant.sizeLabel.trim(),
      stock: variant.stock,
    }));

    this.validateVariants(variants);

    try {
      const product = await this.prisma.$transaction(async (transaction) => {
        const defaults = this.getProductDefaultsFromVariants(
          variants,
          dto.defaultCost,
          dto.defaultPrice,
        );

        const createdProduct = await transaction.product.create({
          data: {
            categoryId: dto.categoryId,
            defaultCost: defaults.defaultCost,
            defaultPrice: defaults.defaultPrice,
            imageUrl: dto.imageUrl?.trim() || undefined,
            name,
            sku,
            subcategoryId: dto.subcategoryId,
            taxId: dto.taxId,
            totalStock: variants.reduce((sum, variant) => sum + variant.stock, 0),
          },
        });

        for (const variant of variants) {
          const barcode = await transaction.barcode.create({
            data: {
              code: variant.barcode,
              description: this.buildBarcodeDescription(
                name,
                variant.sizeLabel,
                variant.colorLabel,
              ),
              publicPrice: variant.price,
            },
          });

          await transaction.variant.create({
            data: {
              barcodeId: barcode.id,
              colorLabel: variant.colorLabel,
              cost: variant.cost,
              price: variant.price,
              productId: createdProduct.id,
              sizeLabel: variant.sizeLabel,
              stock: variant.stock,
            },
          });
        }

        return transaction.product.findUniqueOrThrow({
          include: productDetailsInclude,
          where: { id: createdProduct.id },
        });
      });

      return product;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(this.getUniqueConstraintMessage(error, sku));
      }

      throw error;
    }
  }

  async update(productId: string, dto: UpdateProductDto) {
    const existingProduct = await this.prisma.product.findUnique({
      include: productDetailsInclude,
      where: { id: productId },
    });

    if (!existingProduct) {
      throw new NotFoundException('El producto solicitado no existe.');
    }

    const sku = dto.sku.trim();
    const name = dto.name.trim();
    const normalizedVariants = this.normalizeUpdateVariants(dto.variants, existingProduct);

    this.validateVariants(normalizedVariants);

    try {
      const product = await this.prisma.$transaction(async (transaction) => {
        for (const variant of normalizedVariants) {
          if (variant.id) {
            const existingVariant = existingProduct.variants.find(
              (currentVariant) => currentVariant.id === variant.id,
            );

            if (!existingVariant) {
              throw new BadRequestException(
                'Una de las variantes enviadas no pertenece al producto.',
              );
            }

            await transaction.barcode.update({
              data: {
                code: variant.barcode,
                description: this.buildBarcodeDescription(
                  name,
                  variant.sizeLabel,
                  variant.colorLabel,
                ),
                publicPrice: variant.price,
              },
              where: { id: existingVariant.barcode.id },
            });

            await transaction.variant.update({
              data: {
                colorLabel: variant.colorLabel,
                cost: variant.cost,
                price: variant.price,
                sizeLabel: variant.sizeLabel,
                stock: variant.stock,
              },
              where: { id: variant.id },
            });

            continue;
          }

          const barcode = await transaction.barcode.create({
            data: {
              code: variant.barcode,
              description: this.buildBarcodeDescription(
                name,
                variant.sizeLabel,
                variant.colorLabel,
              ),
              publicPrice: variant.price,
            },
          });

          await transaction.variant.create({
            data: {
              barcodeId: barcode.id,
              colorLabel: variant.colorLabel,
              cost: variant.cost,
              price: variant.price,
              productId,
              sizeLabel: variant.sizeLabel,
              stock: variant.stock,
            },
          });
        }

        const currentVariants = await transaction.variant.findMany({
          select: {
            cost: true,
            price: true,
            stock: true,
          },
          where: { productId },
        });

        const defaults = this.getProductDefaultsFromVariants(
          currentVariants.map((variant) => ({
            barcode: '',
            colorLabel: '',
            cost: Number(variant.cost),
            price: Number(variant.price),
            sizeLabel: '',
            stock: variant.stock,
          })),
          dto.defaultCost,
          dto.defaultPrice,
        );

        await transaction.product.update({
          data: {
            categoryId: dto.categoryId,
            defaultCost: defaults.defaultCost,
            defaultPrice: defaults.defaultPrice,
            imageUrl: dto.imageUrl?.trim() || undefined,
            name,
            sku,
            subcategoryId: dto.subcategoryId,
            taxId: dto.taxId,
            totalStock: currentVariants.reduce((sum, variant) => sum + variant.stock, 0),
          },
          where: { id: productId },
        });

        return transaction.product.findUniqueOrThrow({
          include: productDetailsInclude,
          where: { id: productId },
        });
      });

      return product;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(this.getUniqueConstraintMessage(error, sku));
      }

      throw error;
    }
  }

  private buildInventoryWhere(
    query: FindInventoryProductsQueryDto,
  ): Prisma.ProductWhereInput {
    const search = query.search?.trim();
    const where: Prisma.ProductWhereInput = {};

    if (query.categoryId && query.categoryId !== 'all') {
      where.categoryId = query.categoryId;
    }

    if (!search) {
      return where;
    }

    where.OR = [
      { sku: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      {
        category: {
          name: { contains: search, mode: 'insensitive' },
        },
      },
      {
        subcategory: {
          name: { contains: search, mode: 'insensitive' },
        },
      },
      {
        variants: {
          some: {
            OR: [
              { sizeLabel: { contains: search, mode: 'insensitive' } },
              { colorLabel: { contains: search, mode: 'insensitive' } },
              {
                barcode: {
                  code: { contains: search, mode: 'insensitive' },
                },
              },
            ],
          },
        },
      },
    ];

    return where;
  }

  private normalizeUpdateVariants(
    variants: UpdateProductDto['variants'],
    existingProduct: Prisma.ProductGetPayload<{
      include: typeof productDetailsInclude;
    }>,
  ) {
    return variants.map<NormalizedVariantPayload>((variant) => {
      const sizeLabel = variant.sizeLabel.trim();
      const colorLabel = variant.colorLabel.trim();
      const barcode = variant.barcode.trim();

      if (variant.id) {
        const existingVariant = existingProduct.variants.find(
          (currentVariant) => currentVariant.id === variant.id,
        );

        if (!existingVariant) {
          throw new BadRequestException(
            'Una de las variantes enviadas no pertenece al producto.',
          );
        }

        if (variant.stock === undefined) {
          throw new BadRequestException(
            'Las variantes existentes deben incluir el stock actual.',
          );
        }

        return {
          barcode,
          colorLabel,
          cost: variant.cost,
          id: variant.id,
          price: variant.price,
          sizeLabel,
          stock: variant.stock,
        };
      }

      if (variant.stock === undefined) {
        throw new BadRequestException(
          'Las nuevas variantes deben incluir el stock inicial.',
        );
      }

      return {
        barcode,
        colorLabel,
        cost: variant.cost,
        price: variant.price,
        sizeLabel,
        stock: variant.stock,
      };
    });
  }

  private buildBarcodeDescription(
    productName: string,
    sizeLabel: string,
    colorLabel: string,
  ) {
    return `${productName} - ${sizeLabel} - ${colorLabel}`.slice(0, 200);
  }

  private getProductDefaultsFromVariants(
    variants: Array<Pick<NormalizedVariantPayload, 'cost' | 'price'>>,
    providedDefaultCost?: number,
    providedDefaultPrice?: number,
  ) {
    const defaultCost =
      providedDefaultCost ??
      (variants.length > 0
        ? Math.min(...variants.map((variant) => variant.cost))
        : 0);
    const defaultPrice =
      providedDefaultPrice ??
      (variants.length > 0
        ? Math.min(...variants.map((variant) => variant.price))
        : 0);

    return {
      defaultCost,
      defaultPrice,
    };
  }

  private getUniqueConstraintMessage(
    error: Prisma.PrismaClientKnownRequestError,
    sku: string,
  ) {
    const target = Array.isArray(error.meta?.target) ? error.meta.target : [];

    if (target.includes('internal_code')) {
      return `Ya existe un producto con el SKU "${sku}". Usa un SKU diferente.`;
    }

    if (target.includes('code')) {
      return 'Uno de los codigos de barras ya existe. Verifica las variantes antes de guardar.';
    }

    if (
      target.includes('product_id') &&
      target.includes('size_label') &&
      target.includes('color_label')
    ) {
      return 'No puedes repetir la misma combinacion de talla y color dentro del producto.';
    }

    return 'No se pudo guardar el producto porque uno de sus datos ya existe.';
  }

  private validateVariants(variants: Array<NormalizedVariantPayload>) {
    if (variants.length === 0) {
      throw new BadRequestException(
        'Debes registrar al menos una variante para guardar el producto.',
      );
    }

    const usedCombinations = new Set<string>();
    const usedBarcodes = new Set<string>();

    for (const [index, variant] of variants.entries()) {
      const variantLabel = `Variante ${index + 1}`;

      if (!variant.sizeLabel || !variant.colorLabel || !variant.barcode) {
        throw new BadRequestException(
          `${variantLabel}: talla, color y codigo de barras son obligatorios.`,
        );
      }

      if (variant.stock < 0 || variant.cost < 0 || variant.price < 0) {
        throw new BadRequestException(
          `${variantLabel}: stock, costo y precio deben ser valores iguales o mayores a cero.`,
        );
      }

      const normalizedCombination = `${variant.sizeLabel.toLowerCase()}::${variant.colorLabel.toLowerCase()}`;
      if (usedCombinations.has(normalizedCombination)) {
        throw new BadRequestException(
          'No puedes repetir la misma combinacion de talla y color dentro del producto.',
        );
      }

      const normalizedBarcode = variant.barcode.toLowerCase();
      if (usedBarcodes.has(normalizedBarcode)) {
        throw new BadRequestException(
          'No puedes repetir el mismo codigo de barras dentro del producto.',
        );
      }

      usedCombinations.add(normalizedCombination);
      usedBarcodes.add(normalizedBarcode);
    }
  }
}

@Controller('products')
class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll() {
    return this.productsService.findAll();
  }

  @Get('inventory')
  findInventoryPage(@Query() query: FindInventoryProductsQueryDto) {
    return this.productsService.findInventoryPage(query);
  }

  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }
}

@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
