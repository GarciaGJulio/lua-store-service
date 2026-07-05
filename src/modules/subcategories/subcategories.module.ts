import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class CreateSubcategoryDto {
  @IsString()
  categoryId!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

@Injectable()
class SubcategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.subcategory.findMany({
      include: {
        category: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  create(dto: CreateSubcategoryDto) {
    return this.prisma.subcategory.create({
      data: {
        categoryId: dto.categoryId,
        description: dto.description,
        name: dto.name,
      },
    });
  }
}

@Controller('subcategories')
class SubcategoriesController {
  constructor(private readonly subcategoriesService: SubcategoriesService) {}

  @Get()
  findAll() {
    return this.subcategoriesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateSubcategoryDto) {
    return this.subcategoriesService.create(dto);
  }
}

@Module({
  controllers: [SubcategoriesController],
  providers: [SubcategoriesService],
})
export class SubcategoriesModule {}
