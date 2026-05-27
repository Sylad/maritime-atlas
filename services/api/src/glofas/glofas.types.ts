export interface GlofasTimeSeriesPoint {
  ts: string;       // ISO-8601 UTC, e.g. "2026-05-28T00:00:00Z"
  Q5: number | null;
  Q20: number | null;
  Q50: number | null;
}

export interface GlofasTimeSeriesResponse {
  available: boolean;
  lon: number;
  lat: number;
  run: string | null;  // ISO-8601 of the GloFAS run reference (today 00:00 UTC)
  series: GlofasTimeSeriesPoint[];
}
