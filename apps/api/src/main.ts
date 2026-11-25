import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SessionsController } from './sessions';
import { ProductsController } from './products';
import { FeishuController } from './feishu';

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'price-drop-api' };
  }
}

@Module({
  controllers: [HealthController, ProductsController, SessionsController, FeishuController],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  await app.listen(3001, '127.0.0.1');
}
void bootstrap();
