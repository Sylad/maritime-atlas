import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PgService } from './pg.service';
import { RabbitMqConsumer } from './rabbitmq-consumer.service';
import { AisDecoderService } from './ais-decoder.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [PgService, RabbitMqConsumer, AisDecoderService],
})
export class AppModule {}
