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
  /** Historique des N dernières positions (lon, lat) pour dessiner une
   *  traînée polyline propre, sans cumul de fade qui parasite la couleur.
   *  Permet de remplacer le `destination-in fadeAlpha` (qui produisait
   *  des trails pâles "blanchâtres" sur fond sombre). */
  history: Array<[number, number]>;
}

export interface WindParticlesOptions {
  /** Number of particles to draw simultaneously. ~2000 default. */
  numParticles?: number;
  /** Particle TTL frames before respawn. ~80 default. */
  maxTtl?: number;
  /** Multiplier applied to U/V before advecting (lon/lat per frame). ~0.015 default. */
  advectScale?: number;
  /** Legacy : ignoré depuis V2 polyline-history refactor. Garde la propriété
   *  pour compat avec les call sites existants. */
  fadeAlpha?: number;
  /** V2 (2026-05-12) : longueur de la traînée par particule (en frames).
   *  Default 28 (~470ms à 60fps). Plus court = particules quasi-points.
   *  Plus long = trails plus visibles mais "salissent" map au pan/zoom. */
  trailLength?: number;
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
      maxTtl: opts.maxTtl ?? 200,        // ↑ pour compenser advectScale réduit (sprint 8b)
      advectScale: opts.advectScale ?? 0.0035,  // ↓ ~4× plus lent, plus lisible (sprint 8b)
      // Legacy fadeAlpha ignoré depuis V2 (refactor polyline-history).
      fadeAlpha: opts.fadeAlpha ?? 0,
      // V2 trail length en frames d'historique. 28 frames ≈ 470ms à 60fps
      // → trails bien visibles, sans cumul blanchâtre parasite.
      trailLength: opts.trailLength ?? 28,
      lineWidth: opts.lineWidth ?? 1.5,
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
    if (!this.bbox) return { lon: 0, lat: 0, prevLon: 0, prevLat: 0, ttl: 0, maxTtl: 1, history: [] };
    const lon = this.bbox.minLon + Math.random() * (this.bbox.maxLon - this.bbox.minLon);
    const lat = this.bbox.minLat + Math.random() * (this.bbox.maxLat - this.bbox.minLat);
    return {
      lon, lat, prevLon: lon, prevLat: lat,
      ttl: Math.floor(Math.random() * this.opts.maxTtl),
      maxTtl: this.opts.maxTtl,
      history: [],
    };
  }

  /**
   * IDW interpolation sur les 4 plus proches voisins (sprint 8b).
   *
   * Sans interp, le `nearestWind` snap brusquement d'une cellule grille à
   * l'autre → la particule fait un angle brutal à chaque traversée de
   * frontière (visible comme des "zigzags" sur les trails). IDW pondère
   * par 1/d² → champ vectoriel C¹ continu, trajectoires lisses.
   *
   * Complexité : O(N) par particule comme nearestWind, juste plus de
   * bookkeeping (top-4 au lieu de top-1). À 300 grid points × 1500
   * particules × 60fps ≈ 27M comparaisons/sec, OK V8.
   */
  private interpolateWind(lon: number, lat: number): WindPoint | null {
    if (this.grid.length === 0) return null;
    // Top-4 linear scan
    const top: { p: WindPoint; d2: number }[] = [];
    for (const p of this.grid) {
      const d2 = (p.lon - lon) ** 2 + (p.lat - lat) ** 2;
      if (top.length < 4) {
        top.push({ p, d2 });
        // small array, insertion sort suffit
        for (let i = top.length - 1; i > 0 && top[i].d2 < top[i - 1].d2; i--) {
          [top[i], top[i - 1]] = [top[i - 1], top[i]];
        }
      } else if (d2 < top[3].d2) {
        top[3] = { p, d2 };
        for (let i = 3; i > 0 && top[i].d2 < top[i - 1].d2; i--) {
          [top[i], top[i - 1]] = [top[i - 1], top[i]];
        }
      }
    }
    if (top[0].d2 > 1.0) return null;        // particule hors couverture
    // IDW : weights = 1/(d² + ε)
    let totalW = 0, u = 0, v = 0, speed = 0;
    for (const { p, d2 } of top) {
      const w = 1 / (d2 + 1e-6);
      totalW += w;
      u += p.u * w;
      v += p.v * w;
      speed += p.speed * w;
    }
    return { lon, lat, u: u / totalW, v: v / totalW, speed: speed / totalW };
  }

  private colorForSpeed(speed: number): string {
    if (speed <= 3)  return 'rgba(186, 230, 253, 0.5)';
    if (speed <= 6)  return 'rgba(56, 189, 248, 0.55)';
    if (speed <= 10) return 'rgba(34, 197, 94, 0.6)';
    if (speed <= 14) return 'rgba(253, 224, 71, 0.7)';
    if (speed <= 18) return 'rgba(251, 146, 60, 0.8)';
    return 'rgba(220, 38, 38, 0.9)';
  }

  /** Longueur d'historique (frames) gardée par particule pour dessiner
   *  la traînée. Configurable via opts.trailLength. */
  private get trailLength(): number {
    return Math.max(2, Math.min(60, this.opts.trailLength));
  }

  private step(): void {
    const ctx = this.ctx;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    // V2 (2026-05-12) : clear net chaque frame. Plus de fade-cumul
    // (qui produisait des trails blanchâtres/grisées sur fond sombre).
    // À la place, chaque particule garde un `history[]` de N positions
    // qu'on dessine en polyline → trail nette, colorée, sans bave.
    ctx.clearRect(0, 0, w, h);

    if (this.grid.length === 0 || !this.bbox) return;

    ctx.lineWidth = this.opts.lineWidth;
    ctx.lineCap = 'round';

    const trailLen = this.trailLength;

    for (const p of this.particles) {
      const wind = this.interpolateWind(p.lon, p.lat);
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
      // Push current position dans history + trim
      p.history.push([p.lon, p.lat]);
      if (p.history.length > trailLen) p.history.shift();

      if (p.history.length < 2) continue;

      // Project all history points + draw polyline. On skip si TOUS les
      // points sont hors viewport (cull pas-cher).
      const pts: Array<[number, number]> = [];
      let allOutside = true;
      for (const [hLon, hLat] of p.history) {
        const px = this.project(hLon, hLat);
        if (!px) continue;
        pts.push(px);
        if (px[0] >= 0 && px[0] <= w && px[1] >= 0 && px[1] <= h) {
          allOutside = false;
        }
      }
      if (pts.length < 2 || allOutside) continue;

      // V2.2 (2026-05-12) : gradient d'alpha tail → head pour reproduire
      // le look "trail qui s'estompe" de l'ancien fadeAlpha sans cumul
      // blanchâtre. Tail (frames anciens) = alpha 0.05 ; head (frame
      // courant) = alpha 1.0. On rend segment par segment pour faire
      // varier alpha le long du polyline.
      const baseColor = this.colorForSpeed(wind.speed);
      for (let i = 1; i < pts.length; i++) {
        const t = i / (pts.length - 1);  // 0 (tail) → 1 (head)
        ctx.globalAlpha = t;              // gradient transparence
        ctx.strokeStyle = baseColor;
        ctx.beginPath();
        ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
        ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
}
