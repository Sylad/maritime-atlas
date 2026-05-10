import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { VALID_LAYER_KINDS } from '../db/schema';

export class StopDto {
  @IsNumber()
  quantity!: number;

  @IsString()
  @MinLength(4) @MaxLength(9)   // #rgb, #rrggbb, #rrggbbaa
  color!: string;

  @IsNumber() @Min(0) @Max(1)
  opacity!: number;

  @IsOptional() @IsString() @MaxLength(80)
  label?: string;
}

export class PaletteDto {
  @IsString()
  @MinLength(1) @MaxLength(60)
  name!: string;

  @IsString() @IsIn(VALID_LAYER_KINDS as unknown as string[])
  layerKind!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => StopDto)
  stops!: StopDto[];

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  opacity?: number;
}
