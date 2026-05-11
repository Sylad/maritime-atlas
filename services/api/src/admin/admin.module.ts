import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin.controller';

@Module({
  controllers: [AdminUsersController],
})
export class AdminModule {}
