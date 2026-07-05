import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';

@Injectable()
class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}

@Controller('audit')
class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  findAll() {
    return this.auditService.findAll();
  }
}

@Module({
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}
