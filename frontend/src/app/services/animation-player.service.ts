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
  /** Phase 1 (2026-05-14 soir) — Pattern Eumetview : on parcourt les
   *  timestamps RÉELS du "layer maître du temps" plutôt qu'un step 1h
   *  fixe. Si fourni, le player itère ce tableau ; sinon fallback sur
   *  le step 1h calculé depuis duration (legacy). */
  timestamps?: Date[];
  /** Nom du master pour affichage UI (modal, overlay). */
  masterLayerLabel?: string;
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

  /** Frame courante (0-based) / total frames. Si timestamps fourni
   *  (master layer), total = liste.length. Sinon legacy = duration en
   *  heures. */
  readonly frameIndex = signal<number>(0);
  private readonly timestampsCount = signal<number>(0);
  readonly totalFrames = computed<number>(() => {
    const ts = this.timestampsCount();
    if (ts > 0) return ts;
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
  /** Phase 1 : liste de timestamps réels du master à parcourir. Si null,
   *  fallback step 1h fixe (legacy). */
  private timestamps: Date[] | null = null;

  /** Callback optionnel pour le sliding window — appelé au début de
   *  chaque loop si followRealTime=true. Doit retourner la nouvelle
   *  ancre ET une nouvelle liste de timestamps si master change. */
  private slidingWindowProvider:
    | (() => Promise<{ anchor: Date; timestamps?: Date[] } | null>)
    | null = null;

  /** Callback optionnel — appelé au stop/fin pour récupérer le timestamp
   *  "le plus proche de now" disponible côté master (return-to-now spec
   *  Sylvain 2026-05-14). Si null, on retombe sur Date.now(). */
  private nearestNowProvider: (() => Promise<Date | null>) | null = null;

  setSlidingWindowProvider(
    fn: (() => Promise<{ anchor: Date; timestamps?: Date[] } | null>) | null,
  ): void {
    this.slidingWindowProvider = fn;
  }

  setNearestNowProvider(fn: (() => Promise<Date | null>) | null): void {
    this.nearestNowProvider = fn;
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

    // Phase 1 : si timestamps fourni, on garde QUE ceux qui tombent
    // dans la fenêtre [start, end] (le master peut publier au-delà,
    // on ne veut pas dépasser ce que l'user a demandé).
    if (opts.timestamps && opts.timestamps.length > 0) {
      this.setTimestamps(opts.timestamps
        .filter((t) => t.getTime() >= start.getTime() && t.getTime() <= end.getTime())
        .sort((a, b) => a.getTime() - b.getTime()));
    } else {
      this.setTimestamps(null);
    }

    // Première frame : 1er timestamp si dispo, sinon start (legacy).
    const firstFrame = this.timestamps?.[0] ?? start;
    this.emitFrame(firstFrame);
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

  /** Arrête complètement et reset l'état. Émet en plus une frame finale
   *  "return-to-now" (la date la plus proche de maintenant fournie par
   *  nearestNowProvider) pour que la carte revienne sur la donnée la
   *  plus fraîche du master plutôt que de rester figée sur la dernière
   *  frame de l'animation. Spec Sylvain 2026-05-14. */
  stop(): void {
    const wasActive = this.state() !== 'idle';
    this.clearTimer();
    this.state.set('idle');
    this.config.set(null);
    this.frameIndex.set(0);
    this.rangeStart = null;
    this.rangeEnd = null;
    this.setTimestamps(null);

    // G44 (2026-05-23) — Fire finished$ AUSSI sur stop manuel. Sans ça,
    // les consumers (globe.cleanupAnimationFrames) ne sont pas notifiés
    // et les ressources pré-chargées (sources/layers MapLibre) restent
    // → MapLibre continue de fetch les tiles tant que les layers existent.
    if (wasActive) {
      this.finishedSubject.next();
    }

    if (wasActive && this.nearestNowProvider) {
      // Fire-and-forget : on émet la frame return-to-now dès qu'on a la
      // réponse. Si fail, on retombe sur Date.now().
      this.nearestNowProvider()
        .then((t) => this.emitFrame(t ?? new Date()))
        .catch(() => this.emitFrame(new Date()));
    }
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

  /** Avance d'une frame. Si fin atteinte : loop, stop ou return-to-now.
   *
   *  2 modes :
   *  - timestamps-driven (Phase 1, master layer) : on itère
   *    this.timestamps[i] ; frameIndex = position dans le tableau.
   *  - legacy step 1h (fallback si pas de master ou pas de timestamps
   *    dispo) : on avance d'1 heure depuis rangeStart.
   */
  private async tick(): Promise<void> {
    const cfg = this.config();
    if (!cfg || !this.rangeStart || !this.rangeEnd) {
      this.stop();
      return;
    }

    const usingTimestamps = this.timestamps !== null && this.timestamps.length > 0;
    const nextIndex = this.frameIndex() + 1;

    if (usingTimestamps) {
      const list = this.timestamps!;
      if (nextIndex < list.length) {
        this.frameIndex.set(nextIndex);
        this.emitFrame(list[nextIndex]);
        return;
      }
    } else {
      const nextTime = new Date(this.rangeStart.getTime() + nextIndex * HOUR_MS);
      if (nextTime.getTime() <= this.rangeEnd.getTime()) {
        this.frameIndex.set(nextIndex);
        this.emitFrame(nextTime);
        return;
      }
    }

    // ── Fin de séquence atteinte ───────────────────────────────────
    if (!cfg.loop) {
      this.clearTimer();
      this.state.set('idle');
      this.finishedSubject.next();
      // return-to-now : émet la frame la plus proche de maintenant
      if (this.nearestNowProvider) {
        try {
          const t = await this.nearestNowProvider();
          this.emitFrame(t ?? new Date());
        } catch {
          this.emitFrame(new Date());
        }
      }
      // reset state final (config/range/timestamps purgés)
      this.config.set(null);
      this.frameIndex.set(0);
      this.rangeStart = null;
      this.rangeEnd = null;
      this.setTimestamps(null);
      return;
    }

    // Loop activée. Si followRealTime + provider dispo, on demande au
    // consumer de fournir une nouvelle ancre ET une nouvelle liste de
    // timestamps (le master a peut-être de nouveaux granules disponibles).
    if (cfg.followRealTime && this.slidingWindowProvider) {
      try {
        const refreshed = await this.slidingWindowProvider();
        if (refreshed) {
          const { start, end } = this.computeRange({ ...cfg, anchor: refreshed.anchor });
          this.rangeStart = start;
          this.rangeEnd = end;
          if (refreshed.timestamps && refreshed.timestamps.length > 0) {
            this.setTimestamps(refreshed.timestamps
              .filter((t) => t.getTime() >= start.getTime() && t.getTime() <= end.getTime())
              .sort((a, b) => a.getTime() - b.getTime()));
          }
        }
      } catch {
        // ne pas casser la loop pour un fail réseau ponctuel.
      }
    }

    this.frameIndex.set(0);
    const firstFrame = this.timestamps?.[0] ?? this.rangeStart;
    this.emitFrame(firstFrame);
  }

  private emitFrame(t: Date): void {
    this.frameTimeSubject.next(t);
  }

  /** Set la liste de timestamps + sync le signal count pour totalFrames. */
  private setTimestamps(list: Date[] | null): void {
    this.timestamps = list;
    this.timestampsCount.set(list?.length ?? 0);
  }

  /** Round to hour for clean frame boundaries. */
  private roundToHour(d: Date): Date {
    const r = new Date(d.getTime());
    r.setUTCMinutes(0, 0, 0);
    return r;
  }
}
