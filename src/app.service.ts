import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      service: 'lua-store-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
