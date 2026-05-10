import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RabbitMqService } from './rabbitmq.service';
import { AisIngesterService } from './ais-ingester.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [RabbitMqService, AisIngesterService],
})
export class AppModule {}
