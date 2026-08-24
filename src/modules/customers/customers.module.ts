import {
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
import { IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class CreateCustomerDto {
  @IsString()
  identificationType!: string;

  @IsString()
  identificationNumber!: string;

  @IsString()
  fullName!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  address?: string;
}

class UpdateCustomerDto {
  @IsString()
  identificationType!: string;

  @IsString()
  identificationNumber!: string;

  @IsString()
  fullName!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  address?: string;
}

class FindCustomersPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 15;

  @IsOptional()
  @IsString()
  search?: string;
}

@Injectable()
class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findPage(query: FindCustomersPageQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 15;
    const search = query.search?.trim();
    const where: Prisma.CustomerWhereInput = search
      ? {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            { identificationNumber: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [items, totalItems, activeCustomers] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.customer.count({ where }),
      this.prisma.customer.count({
        where: {
          ...where,
          isActive: true,
        },
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
        activeCustomers,
        totalCustomers: totalItems,
      },
    };
  }

  create(dto: CreateCustomerDto) {
    return this.persistCustomer(async () =>
      this.prisma.customer.create({
        data: {
          address: dto.address,
          email: dto.email,
          fullName: dto.fullName,
          identificationNumber: dto.identificationNumber,
          identificationType: dto.identificationType,
          phone: dto.phone,
        },
      }),
    );
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.ensureCustomerExists(id);

    return this.persistCustomer(async () =>
      this.prisma.customer.update({
        where: { id },
        data: {
          address: dto.address,
          email: dto.email,
          fullName: dto.fullName,
          identificationNumber: dto.identificationNumber,
          identificationType: dto.identificationType,
          phone: dto.phone,
          updatedAt: new Date(),
        },
      }),
    );
  }

  async deactivate(id: string) {
    return this.setActiveState(id, false);
  }

  async activate(id: string) {
    return this.setActiveState(id, true);
  }

  private async setActiveState(id: string, isActive: boolean) {
    await this.ensureCustomerExists(id);

    return this.prisma.customer.update({
      where: { id },
      data: {
        isActive,
        updatedAt: new Date(),
      },
    });
  }

  private async ensureCustomerExists(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!customer) {
      throw new NotFoundException('El cliente indicado no existe.');
    }
  }

  private async persistCustomer<T>(callback: () => Promise<T>) {
    try {
      return await callback();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya existe un cliente registrado con esa identificacion.',
        );
      }

      throw error;
    }
  }
}

@Controller('customers')
class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  findAll() {
    return this.customersService.findAll();
  }

  @Get('directory')
  findPage(@Query() query: FindCustomersPageQueryDto) {
    return this.customersService.findPage(query);
  }

  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customersService.update(id, dto);
  }

  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.customersService.deactivate(id);
  }

  @Patch(':id/activate')
  activate(@Param('id') id: string) {
    return this.customersService.activate(id);
  }
}

@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
