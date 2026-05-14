import { Injectable, signal, computed, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, Observable } from 'rxjs';

/**
 * Animation Player — orchestre une lecture séquentielle de timestamps
 * pour pilot le slider temps de la map.
 *
 * Spec validée 2026-05-14 (Sylvain) :
 *   - Step fixe 1h arrondie (match granularité native modèles AROME/
 *     ARPEGE/GFS/WaveWatch et garde animation lisible 7j × 24 = 168
 *     frames max).
 *   - 4 vitesses : 1x (1000ms/frame), 2x (500ms), 4x (250ms), 8x (125ms).
 *   - 4 durées preset : 6h, 24h, 3j, 7j.
 *   - 3 directions : past, future, auto (auto = future si au moins une
 *     couche forecast active, sinon past).
 *   - Loop infinie optionnelle.
 *   - Sliding window auto-refresh : à chaque fin de loop, on demande au
 *     consumer si la fenêtre doit suivre le temps réel — typiquement
 *     en re-fetchant GS GetCapabilities pour les derniers granules.
 *
 * Architecture : le service est headless. Il ne touche pas à OL ou au
 * DOM. Il expose un Observable `frameTime$` que map.component consume
 * pour avancer la View. Le map est responsable de re-render les
 * sources WMS à chaque frame via son `onTimeChange()` existant.
 */

export type AnimationSpeed = 1 | 2 | 4 | 8;
export type AnimationDuration = '6h' | '24h' | '3d' | '7d';
export type AnimationDirection = 'past' | 'future' | 'auto';

export interface AnimationOptions {
  /** Instant de départ choisi par l'utilisateur (curseur slider au moment du clic Lancer). */
  anchor: Date;
  duration: AnimationDuration;
  direction: AnimationDirection;
  speed: AnimationSpeed;
  loop: boolean;
  /** Si true, au début de chaque loop on demande au consumer une nouvelle
   *  fenêtre temporelle (typiquement plus récente). */
  followRealTime: boolean;
  /** Auto-detect direction "auto" : true si au moins une couche
   *  forecast est active au moment du lancement. */
  forecastActive: boolean;
}

type PlayerState = 'idle' | 'playing' | 'paused';

const HOUR_MS = 3_600_000;

const DURATION_HOURS: Record<AnimationDuration, number> = {
  '6h':  6,
  '24h': 24,
  '3d':  72,
  '7d':  168,
};

const SPEED_INTERVAL_MS: Record<AnimationSpeed, number> = {
  1: 1000,
  2: 500,
  4: 250,
  8: 125,
};

@Injectable({ providedIn: 'root' })
export class AnimationPlayerService {
  private readonly destroyRef = inject(DestroyRef);

  /** État courant. Exposé en signal pour le binding UI. */
  readonly state = signal<PlayerState>('idle');
  readonly config = signal<AnimationOptions | null>(null);

  /** Frame courante (1-based) / total frames calculé depuis duration. */
  readonly frameIndex = signal<number>(0);
  readonly totalFrames = computed<number>(() => {
    const cfg = this.config();
    return cfg ? DURATION_HOURS[cfg.duration] : 0;
  });

  /** Vitesse courante (peut être ajustée pendant la lecture). */
  readonly currentSpeed = signal<AnimationSpeed>(4);

  /** Émis à chaque frame avec le Date à appliquer côté map. */
  private readonly frameTimeSubject = new Subject<Date>();
  readonly frameTime$: Observable<Date> = this.frameTimeSubject.asObservable();

  /** Émis quand l'animation termine naturellement (sans loop, ou stop manuel). */
  private readonly finishedSubject = new Subject<void>();
  readonly finished$: Observable<void> = this.finishedSubject.asObservable();

  private timer: ReturnType<typeof setInterval> | null = null;
  private rangeStart: Date | null = null;
  private rangeEnd: Date | null = null;

  /** Callback optionnel pour le sliding window — appelé au début de
   *  chaque loop si followRealTime=true. Doit retourner la nouvelle
   *  ancre + boolean si la fenêtre a effectivement bougé. */
  private slidingWindowProvider: (() => Promise<Date | null>) | null = null;

  /** Définit le provider sliding window (appelé par map.component
   *  qui sait comment fetch GS GetCapabilities). */
  setSlidingWindowProvider(fn: (() => Promise<Date | null>) | null): void {
    this.slidingWindowProvider = fn;
  }

  /** Calcule [start, end] selon direction + duration + anchor. */
  private computeRange(opts: AnimationOptions): { start: Date; end: Date } {
    const hours = DURATION_HOURS[opts.duration];
    const totalMs = hours * HOUR_MS;
    const anchor = this.roundToHour(opts.anchor);

    const resolved: AnimationDirection = opts.direction === 'auto'
      ? (opts.forecastActive ? 'future' : 'past')
      : opts.direction;

    if (resolved === 'past') {
      return { start: new Date(anchor.getTime() - totalMs), end: anchor };
    }
    return { start: anchor, end: new Date(anchor.getTime() + totalMs) };
  }

  /** Démarre une animation. Si une animation tourne déjà, on l'arrête
   *  proprement avant. */
  start(opts: AnimationOptions): void {
    this.stop();
    this.config.set(opts);
    this.currentSpeed.set(opts.speed);

    const { start, end } = this.computeRange(opts);
    this.rangeStart = start;
    this.rangeEnd = end;
    this.frameIndex.set(0);

    this.emitFrame(start);
    this.state.set('playing');
    this.scheduleNextTick();
  }

  /** Pause sans perdre la position. */
  pause(): void {
    if (this.state() !== 'playing') return;
    this.clearTimer();
    this.state.set('paused');
  }

  /** Reprend après pause. */
  resume(): void {
    if (this.state() !== 'paused') return;
    this.state.set('playing');
    this.scheduleNextTick();
  }

  /** Arrête complètement et reset l'état. */
  stop(): void {
    this.clearTimer();
    this.state.set('idle');
    this.config.set(null);
    this.frameIndex.set(0);
    this.rangeStart = null;
    this.rangeEnd = null;
  }

  /** Change la vitesse en vol — reschedule le tick suivant avec le
   *  nouvel intervalle. */
  setSpeed(speed: AnimationSpeed): void {
    this.currentSpeed.set(speed);
    if (this.state() === 'playing') {
      this.clearTimer();
      this.scheduleNextTick();
    }
  }

  /** Active/désactive la loop en vol. */
  setLoop(loop: boolean): void {
    const cfg = this.config();
    if (cfg) this.config.set({ ...cfg, loop });
  }

  /** Active/désactive le suivi temps réel en vol. */
  setFollowRealTime(follow: boolean): void {
    const cfg = this.config();
    if (cfg) this.config.set({ ...cfg, followRealTime: follow });
  }

  // ── Internals ────────────────────────────────────────────────────

  /** Schedule le prochain tick selon currentSpeed. */
  private scheduleNextTick(): void {
    const interval = SPEED_INTERVAL_MS[this.currentSpeed()];
    this.timer = setInterval(() => this.tick(), interval);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Avance d'une frame. Si fin de range : loop ou stop. */
  private async tick(): Promise<void> {
    const cfg = this.config();
    if (!cfg || !this.rangeStart || !this.rangeEnd) {
      this.stop();
      return;
    }

    const nextIndex = this.frameIndex() + 1;
    const nextTime = new Date(this.rangeStart.getTime() + nextIndex * HOUR_MS);

    if (nextTime.getTime() <= this.rangeEnd.getTime()) {
      this.frameIndex.set(nextIndex);
      this.emitFrame(nextTime);
      return;
    }

    // Fin de range atteinte — gérer loop/end.
    if (!cfg.loop) {
      this.clearTimer();
      this.state.set('idle');
      this.finishedSubject.next();
      return;
    }

    // Loop activée. Si followRealTime + provider dispo, on essaie d'étendre
    // la fenêtre vers maintenant avant de relooper.
    if (cfg.followRealTime && this.slidingWindowProvider) {
      try {
        const newAnchor = await this.slidingWindowProvider();
        if (newAnchor) {
          const { start, end } = this.computeRange({ ...cfg, anchor: newAnchor });
          this.rangeStart = start;
          this.rangeEnd = end;
        }
      } catch {
        // Si le fetch échoue, on continue avec la fenêtre actuelle —
        // ne pas casser la loop pour un fail réseau ponctuel.
      }
    }

    this.frameIndex.set(0);
    this.emitFrame(this.rangeStart);
  }

  private emitFrame(t: Date): void {
    this.frameTimeSubject.next(t);
  }

  /** Round to hour for clean frame boundaries. */
  private roundToHour(d: Date): Date {
    const r = new Date(d.getTime());
    r.setUTCMinutes(0, 0, 0);
    return r;
  }
}
