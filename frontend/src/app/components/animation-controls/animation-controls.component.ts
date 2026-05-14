import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AnimationPlayerService,
  AnimationSpeed,
} from '../../services/animation-player.service';

/**
 * Animation Controls — overlay flottant qui s'affiche au-dessus du
 * time-slider pendant qu'une animation tourne. Donne accès rapide à
 * pause/resume/stop/loop/vitesse sans rouvrir le panel de config.
 *
 * Hidden quand state === 'idle'.
 */
@Component({
  selector: 'app-animation-controls',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="ac-bar" role="toolbar" aria-label="Contrôles animation">
        <button type="button"
                class="ac-btn ac-pause"
                [attr.title]="isPlaying() ? 'Pause' : 'Reprendre'"
                (click)="togglePause()">
          {{ isPlaying() ? '⏸' : '▶' }}
        </button>

        <button type="button"
                class="ac-btn ac-stop"
                title="Arrêter"
                (click)="stop()">
          ⏹
        </button>

        <span class="ac-progress" [attr.title]="progressTitle()">
          {{ progressLabel() }}
        </span>

        <div class="ac-speeds" role="group" aria-label="Vitesse">
          @for (s of speeds; track s) {
            <button type="button"
                    class="ac-speed"
                    [class.is-active]="currentSpeed() === s"
                    (click)="setSpeed(s)">{{ s }}×</button>
          }
        </div>

        <button type="button"
                class="ac-btn ac-loop"
                [class.is-active]="loopActive()"
                title="Boucle infinie"
                (click)="toggleLoop()">
          🔁
        </button>

        <button type="button"
                class="ac-btn ac-follow"
                [class.is-active]="followActive()"
                title="Suivre temps réel — rafraîchit la fenêtre à chaque boucle"
                (click)="toggleFollow()">
          🔄
        </button>
      </div>
    }
  `,
  styles: [`
    :host {
      position: absolute;
      bottom: 8.5em;     /* juste au-dessus du time-slider */
      left: 50%;
      transform: translateX(-50%);
      z-index: 50;
      pointer-events: none;
    }
    .ac-bar {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 0.5em;
      padding: 0.5em 0.8em;
      background: rgb(15, 23, 42);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 999px;
      color: var(--fg, #e8e6e3);
      font-family: inherit;
      box-shadow:
        0 0 16px 1px hsl(224 95% 60% / 0.26),
        0 6px 18px -4px rgba(0, 0, 0, 0.7);
      animation: slide-up 200ms ease-out;
    }
    @keyframes slide-up {
      from { opacity: 0; transform: translate(-50%, 6px); }
      to   { opacity: 1; transform: translate(-50%, 0); }
    }
    .ac-btn {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--fg, #e8e6e3);
      width: 2.1em;
      height: 2.1em;
      border-radius: 50%;
      cursor: pointer;
      font-size: 0.95rem;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 120ms ease-out;
      padding: 0;
      font-variant-emoji: text;
    }
    .ac-btn:hover {
      border-color: hsl(224 85% 55% / 0.6);
      background: rgba(255,255,255,0.08);
    }
    .ac-btn.is-active {
      border-color: hsl(224 95% 60% / 0.9);
      background: hsl(224 80% 50% / 0.22);
      box-shadow: 0 0 10px hsl(224 95% 60% / 0.35) inset;
    }
    .ac-pause { font-size: 1.05rem; }
    .ac-progress {
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      color: var(--fg-muted, #a8a29e);
      letter-spacing: 0.05em;
      padding: 0 0.3em;
      min-width: 7em;
      text-align: center;
    }
    .ac-speeds {
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      background: rgba(255,255,255,0.04);
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.05);
    }
    .ac-speed {
      background: transparent;
      border: 0;
      color: var(--fg-muted, #a8a29e);
      font: inherit;
      font-size: 0.7rem;
      padding: 0.25em 0.55em;
      cursor: pointer;
      border-radius: 999px;
      transition: all 120ms ease-out;
    }
    .ac-speed:hover { color: var(--fg, #e8e6e3); }
    .ac-speed.is-active {
      background: hsl(224 80% 50% / 0.4);
      color: white;
      font-weight: 600;
    }
  `],
})
export class AnimationControlsComponent {
  private readonly player = inject(AnimationPlayerService);

  readonly speeds: AnimationSpeed[] = [1, 2, 4, 8];

  readonly visible = computed<boolean>(() => this.player.state() !== 'idle');
  readonly isPlaying = computed<boolean>(() => this.player.state() === 'playing');
  readonly currentSpeed = computed<AnimationSpeed>(() => this.player.currentSpeed());
  readonly loopActive = computed<boolean>(() => this.player.config()?.loop ?? false);
  readonly followActive = computed<boolean>(() => this.player.config()?.followRealTime ?? false);

  readonly progressLabel = computed<string>(() => {
    const cur = this.player.frameIndex() + 1;
    const total = this.player.totalFrames();
    return `${cur} / ${total}`;
  });

  readonly progressTitle = computed<string>(() => {
    const cfg = this.player.config();
    if (!cfg) return '';
    return `Frame ${this.player.frameIndex() + 1} sur ${this.player.totalFrames()} (step 1h, ${cfg.duration})`;
  });

  togglePause(): void {
    if (this.player.state() === 'playing') {
      this.player.pause();
    } else if (this.player.state() === 'paused') {
      this.player.resume();
    }
  }

  stop(): void { this.player.stop(); }

  setSpeed(s: AnimationSpeed): void { this.player.setSpeed(s); }

  toggleLoop(): void {
    this.player.setLoop(!this.loopActive());
  }

  toggleFollow(): void {
    this.player.setFollowRealTime(!this.followActive());
  }
}
