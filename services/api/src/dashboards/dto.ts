import { IsArray, IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';
import type { DashboardWidget } from '../db/schema';

/**
 * Create/update d'un dashboard. La forme fine des widgets est validée côté
 * frontend (source de vérité) ; ici validation de surface (nom + array).
 */
export class DashboardDto {
  @IsString()
  @MinLength(1) @MaxLength(80)
  name!: string;

  @IsArray()
  widgets!: DashboardWidget[];
}

export class VisibilityDto {
  @IsBoolean()
  isPublic!: boolean;
}
