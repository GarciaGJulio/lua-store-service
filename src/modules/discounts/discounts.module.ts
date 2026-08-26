import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CouponDiscountType, CouponScope, Prisma } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination-query.dto';
import { PrismaService } from '@/database/prisma.service';

class FindDiscountsQueryDto extends PaginationQueryDto {}

class FindAvailableCouponsQueryDto {
  @IsOptional()
  @IsEnum(CouponScope)
  scope?: CouponScope;
}

class CreateDiscountDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsEnum(CouponScope)
  scope!: CouponScope;

  @IsEnum(CouponDiscountType)
  discountType!: CouponDiscountType;

  @IsNumber()
  @Min(0.01)
  discountValue!: number;

  @IsDateString()
  validFrom!: string;

  @IsDateString()
  validTo!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class UpdateDiscountDto extends CreateDiscountDto {}

const DEFAULT_COUPONS = [
  {
    discountType: CouponDiscountType.AMOUNT,
    discountValue: 1,
    name: 'Item $1.00',
    scope: CouponScope.ITEM,
  },
  {
    discountType: CouponDiscountType.AMOUNT,
    discountValue: 0.5,
    name: 'Item $0.50',
    scope: CouponScope.ITEM,
  },
  {
    discountType: CouponDiscountType.AMOUNT,
    discountValue: 0.25,
    name: 'Item $0.25',
    scope: CouponScope.ITEM,
  },
  {
    discountType: CouponDiscountType.AMOUNT,
    discountValue: 1,
    name: 'Carrito $1.00',
    scope: CouponScope.CART,
  },
  {
    discountType: CouponDiscountType.AMOUNT,
    discountValue: 0.5,
    name: 'Carrito $0.50',
    scope: CouponScope.CART,
  },
  {
    discountType: CouponDiscountType.AMOUNT,
    discountValue: 0.25,
    name: 'Carrito $0.25',
    scope: CouponScope.CART,
  },
] as const;

@Injectable()
class DiscountsService {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(query: FindDiscountsQueryDto) {
    await this.ensureDefaultCoupons();

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = query.search?.trim();
    const normalizedSearch = search?.toUpperCase();
    const scopeSearch =
      normalizedSearch === CouponScope.ITEM || normalizedSearch === CouponScope.CART
        ? (normalizedSearch as CouponScope)
        : null;
    const discountTypeSearch =
      normalizedSearch === CouponDiscountType.AMOUNT ||
      normalizedSearch === CouponDiscountType.PERCENTAGE
        ? (normalizedSearch as CouponDiscountType)
        : null;
    const where: Prisma.StoreCouponWhereInput = search
      ? {
          OR: [
            {
              name: {
                contains: search,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            ...(scopeSearch ? [{ scope: { equals: scopeSearch } }] : []),
            ...(discountTypeSearch
              ? [{ discountType: { equals: discountTypeSearch } }]
              : []),
          ],
        }
      : {};

    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.storeCoupon.findMany({
        orderBy: [{ scope: 'asc' }, { discountValue: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        where,
      }),
      this.prisma.storeCoupon.count({ where }),
    ]);

    return {
      items: items.map((coupon) => ({
        ...coupon,
        discountValue: Number(coupon.discountValue),
      })),
      meta: {
        limit,
        page,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      },
      summary: {
        activeCoupons: items.filter((coupon) => coupon.isActive).length,
        totalCoupons: totalItems,
      },
    };
  }

  async findAvailable(query: FindAvailableCouponsQueryDto) {
    await this.ensureDefaultCoupons();

    const now = this.normalizeDay(new Date().toISOString());
    const items = await this.prisma.storeCoupon.findMany({
      orderBy: [{ scope: 'asc' }, { discountValue: 'desc' }, { name: 'asc' }],
      where: {
        isActive: true,
        scope: query.scope,
        validFrom: {
          lte: now,
        },
        validTo: {
          gte: now,
        },
      },
    });

    return items.map((coupon) => ({
      ...coupon,
      discountValue: Number(coupon.discountValue),
    }));
  }

  async create(dto: CreateDiscountDto) {
    const payload = this.normalizeDiscountPayload(dto);
    let coupon: Awaited<ReturnType<typeof this.prisma.storeCoupon.create>>;

    try {
      coupon = await this.prisma.storeCoupon.create({
        data: payload,
      });
    } catch (error) {
      throw this.mapDiscountPersistenceError(error, 'crear');
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'create_coupon',
        entityId: coupon.id,
        entityName: 'store_coupon',
        metadata: {
          ...payload,
        },
        module: 'discounts',
      },
    });

    return {
      ...coupon,
      discountValue: Number(coupon.discountValue),
    };
  }

  async update(couponId: string, dto: UpdateDiscountDto) {
    const payload = this.normalizeDiscountPayload(dto);
    let coupon: Awaited<ReturnType<typeof this.prisma.storeCoupon.update>>;

    try {
      coupon = await this.prisma.storeCoupon.update({
        where: { id: couponId },
        data: payload,
      });
    } catch (error) {
      throw this.mapDiscountPersistenceError(error, 'actualizar');
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'update_coupon',
        entityId: coupon.id,
        entityName: 'store_coupon',
        metadata: {
          ...payload,
        },
        module: 'discounts',
      },
    });

    return {
      ...coupon,
      discountValue: Number(coupon.discountValue),
    };
  }

  async remove(couponId: string) {
    let coupon: Awaited<ReturnType<typeof this.prisma.storeCoupon.delete>>;

    try {
      coupon = await this.prisma.storeCoupon.delete({
        where: { id: couponId },
      });
    } catch (error) {
      throw this.mapDiscountPersistenceError(error, 'eliminar');
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'delete_coupon',
        entityId: coupon.id,
        entityName: 'store_coupon',
        metadata: {
          deletedCouponName: coupon.name,
        },
        module: 'discounts',
      },
    });

    return {
      success: true,
    };
  }

  private async ensureDefaultCoupons() {
    const validFrom = new Date('2026-01-01T00:00:00.000Z');
    const validTo = new Date('2099-12-31T00:00:00.000Z');

    await this.prisma.storeCoupon.createMany({
      data: DEFAULT_COUPONS.map((coupon) => ({
        ...coupon,
        validFrom,
        validTo,
      })),
      skipDuplicates: true,
    });
  }

  private normalizeDay(value: string) {
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  }

  private normalizeDiscountPayload(dto: CreateDiscountDto | UpdateDiscountDto) {
    const name = dto.name.trim();

    if (!name) {
      throw new BadRequestException('Debes ingresar el nombre del cupon.');
    }

    if (dto.discountType === CouponDiscountType.PERCENTAGE && dto.discountValue > 100) {
      throw new BadRequestException(
        'Los cupones de porcentaje no pueden superar el 100%.',
      );
    }

    const validFrom = this.normalizeDay(dto.validFrom);
    const validTo = this.normalizeDay(dto.validTo);

    if (validTo.getTime() < validFrom.getTime()) {
      throw new BadRequestException('La fecha hasta no puede ser menor a la fecha desde.');
    }

    return {
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      isActive: dto.isActive ?? true,
      name,
      scope: dto.scope,
      validFrom,
      validTo,
    };
  }

  private mapDiscountPersistenceError(error: unknown, action: 'crear' | 'actualizar' | 'eliminar') {
    if (error instanceof BadRequestException) {
      return error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return new BadRequestException('Ya existe un cupon registrado con ese nombre.');
      }

      if (error.code === 'P2025') {
        return new BadRequestException(`No se encontro el cupon que intentas ${action}.`);
      }
    }

    return new BadRequestException(`No se pudo ${action} el cupon.`);
  }
}

@Controller('discounts')
class DiscountsController {
  constructor(private readonly discountsService: DiscountsService) {}

  @Get()
  findPage(@Query() query: FindDiscountsQueryDto) {
    return this.discountsService.findPage(query);
  }

  @Get('available')
  findAvailable(@Query() query: FindAvailableCouponsQueryDto) {
    return this.discountsService.findAvailable(query);
  }

  @Post()
  create(@Body() dto: CreateDiscountDto) {
    return this.discountsService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDiscountDto) {
    return this.discountsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.discountsService.remove(id);
  }
}

@Module({
  controllers: [DiscountsController],
  providers: [DiscountsService],
  exports: [DiscountsService],
})
export class DiscountsModule {}
