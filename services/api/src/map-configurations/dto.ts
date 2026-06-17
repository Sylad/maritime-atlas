import { IsObject, IsString, MaxLength, MinLength } from 'class-validator';
import type { MapConfigSnapshot } from '../db/schema';

/**
 * DTO create/update d'une config de carte. La forme fine du snapshot est
 * validée côté frontend (source de vérité du modèle) ; ici on garde une
 * validation de surface (nom + objet snapshot présent) volontairement
 * permissive pour ne pas coupler l'API à chaque évolution du snapshot.
 */
export class MapConfigDto {
  @IsString()
  @MinLength(1) @MaxLength(60)
  name!: string;

  @IsObject()
  snapshot!: MapConfigSnapshot;
}
