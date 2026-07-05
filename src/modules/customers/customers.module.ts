import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { IsEmail, IsOptional, IsString } from 'class-validator';
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

@Injectable()
class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  create(dto: CreateCustomerDto) {
    return this.prisma.customer.create({
      data: {
        address: dto.address,
        email: dto.email,
        fullName: dto.fullName,
        identificationNumber: dto.identificationNumber,
        identificationType: dto.identificationType,
        phone: dto.phone,
      },
    });
  }
}

@Controller('customers')
class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  findAll() {
    return this.customersService.findAll();
  }

  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }
}

@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
