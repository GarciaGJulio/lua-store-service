import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = Number(configService.get<string>('PORT', '3000'));
  const corsOrigins = configService.get<string>('CORS_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim());

  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());
  app.enableCors({
    credentials: true,
    origin: corsOrigins,
  });
  app.setGlobalPrefix('api');
  app.enableVersioning({
    defaultVersion: '1',
    type: VersioningType.URI,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      whitelist: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Lua Store Service')
    .setDescription(
      'Base NestJS para auth, inventario, facturacion, cartera, caja, archivos y auditoria.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Lua Store Service Docs',
  });

  try {
    await app.listen(port);
    Logger.log(`Lua Store Service corriendo en http://localhost:${port}/api/v1`, 'Bootstrap');
  } catch (error) {
    const portError = error as NodeJS.ErrnoException;

    if (portError.code === 'EADDRINUSE') {
      Logger.error(
        `No se pudo iniciar Lua Store Service porque el puerto ${port} ya esta en uso. Cierra la otra instancia del backend o cambia PORT en tu .env antes de volver a iniciar.`,
        undefined,
        'Bootstrap',
      );
      await app.close();
      process.exit(1);
    }

    throw error;
  }
}

void bootstrap();
