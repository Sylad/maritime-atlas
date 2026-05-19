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
      <div class="popover" role="dialog" aria-label="Choisir une couleur" (click)="$event.stopPropagation()">
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
        <!-- 2026-05-19 — input HEX custom pour couleurs hors preset.
             Validation : doit matcher /^#[0-9a-fA-F]{6}$/ avant emit. -->
        <div class="hex-input-row">
          <span class="hex-preview" [style.background]="hexInput()"></span>
          <span class="hex-prefix">#</span>
          <input
            type="text"
            class="hex-input"
            maxlength="6"
            placeholder="ffffff"
            spellcheck="false"
            autocomplete="off"
            [value]="hexInputRaw()"
            (input)="onHexInputChange($any($event.target).value)"
            (keydown.enter)="commitHexInput()"
            (blur)="commitHexInput()"
            aria-label="Couleur hex personnalisée" />
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
    .hex-input-row {
      display: flex;
      align-items: center;
      gap: 0.4em;
      margin-top: 0.7em;
      padding-top: 0.6em;
      border-top: 1px solid hsl(224 30% 18%);
    }
    .hex-preview {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      flex-shrink: 0;
      box-shadow: 0 0 0 1px hsl(224 35% 30%), inset 0 0 0 2px hsl(224 30% 8%);
    }
    .hex-prefix {
      color: hsl(224 25% 60%);
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 0.75rem;
    }
    .hex-input {
      flex: 1;
      min-width: 0;
      background: hsl(224 30% 5%);
      border: 1px solid hsl(224 30% 22%);
      border-radius: 4px;
      padding: 0.25em 0.45em;
      color: hsl(224 15% 90%);
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: lowercase;
      outline: none;
      transition: border-color 100ms;
    }
    .hex-input:focus {
      border-color: hsl(224 85% 60%);
      box-shadow: 0 0 0 1px hsl(224 95% 60% / 0.3);
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

  /** 12 swatches preset organisés sur 3 rangées de 4 (neutres / warm / cool).
   *  Couvre les couleurs typiques pour des contours sur fond dark Carto. */
  readonly SWATCHES: ReadonlyArray<string> = [
    // Row 1 — neutres
    '#ffffff', '#d4d4d4', '#737373', '#0a0a0a',
    // Row 2 — warm
    '#fde047', '#fb923c', '#ef4444', '#d946ef',
    // Row 3 — cool
    '#84cc16', '#22c55e', '#06b6d4', '#3b82f6',
  ];

  /** Raw value affichée dans l'input HEX (sans le '#'). Synchronisée
   *  avec `value()` au popover open, mais peut diverger pendant la frappe
   *  (tant que pas commit via Enter/blur). */
  readonly hexInputRaw = signal<string>('');

  /** Valeur HEX preview (avec '#'). Si l'input courant n'est pas valide,
   *  on garde la dernière valeur valide. */
  readonly hexInput = signal<string>('#ffffff');

  toggleOpen(evt: Event): void {
    evt.stopPropagation();
    const next = !this.open();
    if (next) {
      // Sync l'input HEX avec la value courante au moment d'ouvrir
      this.hexInputRaw.set(this.value().replace(/^#/, ''));
      this.hexInput.set(this.value());
    }
    this.open.set(next);
  }

  pick(color: string): void {
    this.valueChange.emit(color);
    this.hexInputRaw.set(color.replace(/^#/, ''));
    this.hexInput.set(color);
    this.open.set(false);
  }

  onHexInputChange(raw: string): void {
    // Strip '#' si l'user le tape, garde alphanumeric, lowercase, max 6
    const cleaned = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, 6);
    this.hexInputRaw.set(cleaned);
    // Preview live si 6 chars valides
    if (/^[0-9a-f]{6}$/.test(cleaned)) {
      this.hexInput.set(`#${cleaned}`);
    }
  }

  commitHexInput(): void {
    const raw = this.hexInputRaw();
    if (/^[0-9a-f]{6}$/.test(raw)) {
      this.pick(`#${raw}`);
    } else {
      // Revert input à la dernière valeur valide
      this.hexInputRaw.set(this.value().replace(/^#/, ''));
    }
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
