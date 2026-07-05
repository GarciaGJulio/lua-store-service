import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class CreateCategoryDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

@Injectable()
class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.category.findMany({
      include: {
        subcategories: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  create(dto: CreateCategoryDto) {
    return this.prisma.category.create({
      data: {
        description: dto.description,
        name: dto.name,
      },
    });
  }
}

@Controller('categories')
class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll() {
    return this.categoriesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }
}

@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService],
})
export class CategoriesModule {}
