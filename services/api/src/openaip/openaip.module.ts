import { Module } from '@nestjs/common';
import { OpenAIPController } from './openaip.controller';
import { OpenAIPService } from './openaip.service';

/**
 * G66f (2026-05-27) — Module OpenAIP. Proxy server-side pour les data
 * publiques OpenAIP (FIR + UIR airspaces). Cache 24h in-memory.
 */
@Module({
  controllers: [OpenAIPController],
  providers: [OpenAIPService],
  exports: [OpenAIPService],
})
export class OpenAIPModule {}
