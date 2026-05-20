import { Module } from '@nestjs/common';
import { OutdoorController } from './outdoor.controller';

@Module({
  controllers: [OutdoorController],
})
export class OutdoorModule {}
