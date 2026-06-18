import { Module } from '@nestjs/common';
import { DashboardsService } from './dashboards.service';
import { DashboardsController } from './dashboards.controller';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';

@Module({
  controllers: [DashboardsController],
  providers: [DashboardsService, OptionalJwtAuthGuard],
  exports: [DashboardsService],
})
export class DashboardsModule {}
