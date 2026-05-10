/**
 * Wind particles overlay — pattern windy.com simplifié.
 *
 * Pour chaque trame d'animation :
 *   1. On garde un canvas off-screen "fade" qu'on assombrit légèrement
 *      (alpha 0.97) → les anciennes positions des particules laissent
 *      une traînée qui disparait progressivement
 *   2. Pour chaque particule :
 *      - lookup nearest wind grid point
 *      - calcule U = speed × sin(dirTo_rad), V = speed × cos(dirTo_rad)
 *      - advection : particle.lonLat += (U, V) × dt × scale
 *      - dessine un segment du dernier point au nouveau
 *      - décrémente TTL, respawn quand TTL=0 ou hors viewport
 *   3. Couleur du segment selon la magnitude (palette Beaufort-like)
 *
 * Pas de WebGL pour rester portable (OL Tile renderer ne joue pas
 * super avec WebGL custom). Canvas 2D + ~2000 particules tient
 * 60fps sur desktop, 30fps sur mobile.
 */

export interface WindPoint {
  lon: number;
  lat: number;
  u: number;       // east component, m/s
  v: number;       // north component, m/s
  speed: number;
}

interface Particle {
  lon: number;
  lat: number;
  prevLon: number;
  prevLat: number;
  ttl: number;       // frames remaining
  maxTtl: number;
}

export interface WindParticlesOptions {
  /** Number of particles to draw simultaneously. ~2000 default. */
  numParticles?: number;
  /** Particle TTL frames before respawn. ~80 default. */
  maxTtl?: number;
  /** Multiplier applied to U/V before advecting (lon/lat per frame). ~0.015 default. */
  advectScale?: number;
  /** Fade factor applied to canvas each frame (1.0 = no trails, 0.95 = long trails). ~0.97. */
  fadeAlpha?: number;
  /** Line width (px). ~1.2. */
  lineWidth?: number;
}

/**
 * Convert speed + dirTo (compass deg) → U/V components.
 * dirTo = 0=N: V positive  /  90=E: U positive
 */
export function speedDirToUv(speed: number, dirToDeg: number): { u: number; v: number } {
  const rad = (dirToDeg * Math.PI) / 180;
  return {
    u: speed * Math.sin(rad),
    v: speed * Math.cos(rad),
  };
}

/**
 * Engine isolé de OpenLayers — testable. Reçoit le canvas + un projecteur
 * (lon/lat) → (canvas px) injecté par le wrapper OL.
 */
export class WindParticleEngine {
  private particles: Particle[] = [];
  private grid: WindPoint[] = [];
  private rafId: number | null = null;
  private opts: Required<WindParticlesOptions>;
  private bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number } | null = null;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly project: (lon: number, lat: number) => [number, number] | null,
    opts: WindParticlesOptions = {},
  ) {
    this.opts = {
      numParticles: opts.numParticles ?? 1500,
      maxTtl: opts.maxTtl ?? 80,
      advectScale: opts.advectScale ?? 0.012,
      fadeAlpha: opts.fadeAlpha ?? 0.96,
      lineWidth: opts.lineWidth ?? 1.2,
    };
  }

  /** Replace the wind grid (called when new GeoJSON arrives). */
  setGrid(grid: WindPoint[]): void {
    this.grid = grid;
    if (grid.length > 0) {
      this.bbox = {
        minLon: Math.min(...grid.map((p) => p.lon)),
        maxLon: Math.max(...grid.map((p) => p.lon)),
        minLat: Math.min(...grid.map((p) => p.lat)),
        maxLat: Math.max(...grid.map((p) => p.lat)),
      };
      this.respawnAll();
    }
  }

  start(): void {
    if (this.rafId !== null) return;
    const loop = () => {
      this.step();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Resize the engine — call when canvas dimensions change. */
  resize(_w: number, _h: number): void {
    // No-op : canvas dimensions used directly via this.ctx.canvas.
  }

  private respawnAll(): void {
    this.particles = [];
    for (let i = 0; i < this.opts.numParticles; i++) {
      this.particles.push(this.spawn());
    }
  }

  private spawn(): Particle {
    if (!this.bbox) return { lon: 0, lat: 0, prevLon: 0, prevLat: 0, ttl: 0, maxTtl: 1 };
    const lon = this.bbox.minLon + Math.random() * (this.bbox.maxLon - this.bbox.minLon);
    const lat = this.bbox.minLat + Math.random() * (this.bbox.maxLat - this.bbox.minLat);
    return {
      lon, lat, prevLon: lon, prevLat: lat,
      ttl: Math.floor(Math.random() * this.opts.maxTtl),
      maxTtl: this.opts.maxTtl,
    };
  }

  /** Find nearest grid point — O(N) scan, N=~300 OK at 60fps. */
  private nearestWind(lon: number, lat: number): WindPoint | null {
    if (this.grid.length === 0) return null;
    let best = this.grid[0];
    let bestD2 = (best.lon - lon) ** 2 + (best.lat - lat) ** 2;
    for (const p of this.grid) {
      const d2 = (p.lon - lon) ** 2 + (p.lat - lat) ** 2;
      if (d2 < bestD2) { best = p; bestD2 = d2; }
    }
    if (Math.sqrt(bestD2) > 1.0) return null; // > 1° = too far
    return best;
  }

  private colorForSpeed(speed: number): string {
    if (speed <= 3)  return 'rgba(186, 230, 253, 0.5)';
    if (speed <= 6)  return 'rgba(56, 189, 248, 0.55)';
    if (speed <= 10) return 'rgba(34, 197, 94, 0.6)';
    if (speed <= 14) return 'rgba(253, 224, 71, 0.7)';
    if (speed <= 18) return 'rgba(251, 146, 60, 0.8)';
    return 'rgba(220, 38, 38, 0.9)';
  }

  private step(): void {
    const ctx = this.ctx;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    // Fade existing trails by drawing a semi-transparent black rect
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0, 0, 0, ${this.opts.fadeAlpha})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    if (this.grid.length === 0 || !this.bbox) return;

    ctx.lineWidth = this.opts.lineWidth;
    ctx.lineCap = 'round';

    for (const p of this.particles) {
      const wind = this.nearestWind(p.lon, p.lat);
      if (!wind || p.ttl <= 0) {
        Object.assign(p, this.spawn());
        continue;
      }
      // Advect
      p.prevLon = p.lon;
      p.prevLat = p.lat;
      p.lon += wind.u * this.opts.advectScale;
      p.lat += wind.v * this.opts.advectScale;
      p.ttl--;

      const pPrev = this.project(p.prevLon, p.prevLat);
      const pCurr = this.project(p.lon, p.lat);
      if (!pPrev || !pCurr) continue;

      // Skip if both points outside viewport (cheap cull)
      if ((pCurr[0] < 0 || pCurr[0] > w || pCurr[1] < 0 || pCurr[1] > h) &&
          (pPrev[0] < 0 || pPrev[0] > w || pPrev[1] < 0 || pPrev[1] > h)) {
        continue;
      }

      ctx.strokeStyle = this.colorForSpeed(wind.speed);
      ctx.beginPath();
      ctx.moveTo(pPrev[0], pPrev[1]);
      ctx.lineTo(pCurr[0], pCurr[1]);
      ctx.stroke();
    }
  }
}
