import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '@/database/prisma.service';

class CreateUserDto {
  @IsString()
  username!: string;

  @IsString()
  fullName!: string;

  @IsEmail()
  email!: string;

  @IsEnum(UserRole)
  role!: UserRole;

  @IsString()
  @MinLength(6)
  password!: string;
}

@Injectable()
class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        email: true,
        fullName: true,
        id: true,
        isActive: true,
        role: true,
        username: true,
      },
    });
  }

  async create(dto: CreateUserDto) {
    const passwordHash = await bcrypt.hash(dto.password, 10);

    return this.prisma.user.create({
      data: {
        email: dto.email,
        fullName: dto.fullName,
        passwordHash,
        role: dto.role,
        username: dto.username,
      },
      select: {
        createdAt: true,
        email: true,
        fullName: true,
        id: true,
        role: true,
        username: true,
      },
    });
  }
}

@Controller('users')
class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
