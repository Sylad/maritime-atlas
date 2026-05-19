import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

/**
 * 2026-05-19 — Color picker compact custom avec swatches preset.
 *
 * Remplace `<input type="color">` natif (popup browser laid, pas stylable,
 * cf Sylvain "le color picker est assez laid, il serait possible de lui
 * appliquer les styles/polices du reste du panneau de gauche").
 *
 * UX :
 *  - Trigger : pastille ronde 18×18px qui montre la couleur courante.
 *  - Click → popover absolute positioned avec 8 swatches preset organisés
 *    sur 2 rangées. Click sur un swatch → emit + close popover.
 *  - Outside click → close popover (HostListener document:click).
 *  - Style cohérent panneau legend gauche : bg `--bg-1`, border accent,
 *    font Inter, hover scale.
 *  - Pas d'input HEX texte (overkill pour ce cas d'usage isolignes).
 *
 * API drop-in replace :
 *  - `value` input (HEX `#RRGGBB`)
 *  - `valueChange` output (emit nouveau HEX à chaque pick)
 *
 * Preset swatches : couleurs typiquement utiles pour des contours/isolignes
 * sur fond dark Carto (blanc, noir profond, gris clair, jaunes, orange,
 * rouge, vert, cyan, magenta — tons saturés contrastés).
 */
@Component({
  selector: 'app-color-swatch-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="trigger"
      [style.background]="value()"
      [title]="value() + ' — choisir une couleur'"
      [attr.aria-expanded]="open()"
      (click)="toggleOpen($event)">
    </button>
    @if (open()) {
      <div class="popover" role="dialog" aria-label="Choisir une couleur">
        <div class="popover-title">Couleur</div>
        <div class="swatches">
          @for (sw of SWATCHES; track sw) {
            <button
              type="button"
              class="swatch"
              [class.selected]="sw.toLowerCase() === value().toLowerCase()"
              [style.background]="sw"
              [title]="sw"
              (click)="pick(sw)">
            </button>
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .trigger {
      width: 18px;
      height: 18px;
      border: 0;
      border-radius: 50%;
      padding: 0;
      cursor: pointer;
      box-shadow:
        0 0 0 1px hsl(224 35% 30%),
        inset 0 0 0 2px hsl(224 20% 10%);
      transition: transform 120ms, box-shadow 120ms;
    }
    .trigger:hover {
      transform: scale(1.15);
      box-shadow:
        0 0 0 1px hsl(224 85% 60%),
        inset 0 0 0 2px hsl(224 20% 10%);
    }
    .popover {
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: hsl(224 30% 8%);
      border: 1px solid hsl(224 85% 55% / 0.5);
      border-radius: 6px;
      padding: 0.55em 0.65em 0.6em;
      box-shadow:
        0 4px 12px rgba(0, 0, 0, 0.5),
        0 0 0 1px hsl(224 95% 60% / 0.2),
        0 0 16px 1px hsl(224 95% 60% / 0.22);
      z-index: 100;
      font-family: var(--font, Inter, sans-serif);
      animation: pop-in 140ms ease-out;
    }
    @keyframes pop-in {
      from { opacity: 0; transform: translateX(-50%) translateY(4px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    .popover-title {
      font-size: 0.62rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: hsl(224 25% 65%);
      margin-bottom: 0.5em;
      text-align: center;
    }
    .swatches {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
    }
    .swatch {
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 50%;
      padding: 0;
      cursor: pointer;
      box-shadow:
        0 0 0 1px hsl(224 35% 30%),
        inset 0 0 0 2px hsl(224 30% 8%);
      transition: transform 100ms, box-shadow 120ms;
    }
    .swatch:hover {
      transform: scale(1.18);
      box-shadow:
        0 0 0 1px hsl(224 85% 60%),
        inset 0 0 0 2px hsl(224 30% 8%);
    }
    .swatch.selected {
      box-shadow:
        0 0 0 2px hsl(224 95% 65%),
        inset 0 0 0 2px hsl(224 30% 8%);
    }
  `,
})
export class ColorSwatchPickerComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  /** Couleur courante en HEX (`#RRGGBB`). */
  readonly value = input<string>('#ffffff');

  /** Emit le nouveau HEX choisi. Le parent doit set son signal + persistLayerPrefs. */
  readonly valueChange = output<string>();

  readonly open = signal(false);

  /** 8 swatches preset adaptés à des contours sur fond dark Carto. */
  readonly SWATCHES: ReadonlyArray<string> = [
    '#ffffff', // blanc — défaut
    '#a3a3a3', // gris clair
    '#fde047', // jaune
    '#fb923c', // orange
    '#ef4444', // rouge
    '#22c55e', // vert
    '#06b6d4', // cyan
    '#d946ef', // magenta
  ];

  toggleOpen(evt: Event): void {
    evt.stopPropagation();
    this.open.update((v) => !v);
  }

  pick(color: string): void {
    this.valueChange.emit(color);
    this.open.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(evt: MouseEvent): void {
    if (!this.open()) return;
    if (!this.host.nativeElement.contains(evt.target as Node)) {
      this.open.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.open.set(false);
  }
}
