import { Body, Controller, Get, Injectable, Module, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PassportStrategy } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { Request } from 'express';
import * as bcrypt from 'bcrypt';
import { AuthGuard } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { StringValue } from 'ms';
import { PrismaService } from '@/database/prisma.service';

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

type AuthenticatedRequest = Request & {
  user: {
    email: string;
    fullName: string;
    id: string;
    role: UserRole;
  };
};

@Injectable()
class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException(
        'Usuario no encontrado. Crea primero un usuario desde /api/v1/users.',
      );
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Acceso bloqueado. El usuario esta inactivo.');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciales invalidas.');
    }

    const payload = {
      email: user.email,
      role: user.role,
      sub: user.id,
    };

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
      },
    });

    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: {
        email: user.email,
        fullName: user.fullName,
        id: user.id,
        role: user.role,
      },
    };
  }

  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        fullName: true,
        id: true,
        isActive: true,
        role: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Token invalido o usuario ya no existe.');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('La sesion ya no es valida para este usuario.');
    }

    const { isActive: _isActive, ...safeUser } = user;

    return safeUser;
  }
}

@Injectable()
class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      ignoreExpiration: false,
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.get<string>('JWT_SECRET') ?? 'change-me',
    });
  }

  async validate(payload: { sub: string }) {
    return this.authService.validateUser(payload.sub);
  }
}

@Controller('auth')
class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('profile')
  profile(@Req() request: AuthenticatedRequest) {
    return request.user;
  }
}

@Module({
  controllers: [AuthController],
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') ?? 'change-me',
        signOptions: {
          expiresIn:
            (configService.get<string>('JWT_EXPIRES_IN') ?? '8h') as StringValue,
        },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
