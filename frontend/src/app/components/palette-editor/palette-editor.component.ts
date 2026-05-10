import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { LayerKind, Palette, PaletteStop } from '../../services/palettes.service';

const LAYER_LABEL: Record<LayerKind, string> = {
  sst: 'SST (température mer)',
  wind: 'Vent (force)',
  waves: 'Vagues (hauteur sig.)',
  'wave-dir': 'Vagues (direction)',
};

/**
 * Editor visuel d'une palette : gradient préview + tableau des stops avec
 * color picker natif + sliders quantity/opacity. Pas de drag-canvas pour
 * l'instant (over-engineering pour MVP) — un tableau triable suffit.
 */
@Component({
  selector: 'app-palette-editor',
  imports: [FormsModule],
  template: `
    <div class="pe-card">
      <div class="pe-row">
        <label>Nom
          <input type="text" [ngModel]="name()" (ngModelChange)="name.set($event)" name="paletteName" maxlength="60" />
        </label>
        <label>Couche cible
          <select [ngModel]="layerKind()" (ngModelChange)="layerKind.set($event)" name="paletteLayer">
            @for (k of layerKinds; track k) {
              <option [value]="k">{{ layerLabel(k) }}</option>
            }
          </select>
        </label>
      </div>

      <div class="pe-preview" [style.background]="previewGradient()"></div>
      <div class="pe-preview-axis">
        <span>{{ minQuantity() }}</span>
        <span class="pe-axis-label">{{ unitFor(layerKind()) }}</span>
        <span>{{ maxQuantity() }}</span>
      </div>

      <div class="pe-stops">
        <div class="pe-stops-header">
          <span>Couleur</span>
          <span>Valeur</span>
          <span>Opacité</span>
          <span>Label</span>
          <span></span>
        </div>
        @for (stop of stops(); track $index; let i = $index) {
          <div class="pe-stop">
            <input type="color" [value]="stop.color" (input)="updateStop(i, 'color', anyTarget($event).value)" />
            <input type="number" step="0.5" [value]="stop.quantity" (input)="updateStop(i, 'quantity', +anyTarget($event).value)" />
            <input type="range" min="0" max="1" step="0.05" [value]="stop.opacity" (input)="updateStop(i, 'opacity', +anyTarget($event).value)" />
            <input type="text" placeholder="ex: tempête" [value]="stop.label ?? ''" (input)="updateStop(i, 'label', anyTarget($event).value)" />
            <button type="button" class="pe-stop-del" (click)="removeStop(i)" title="Supprimer ce stop" [disabled]="stops().length <= 2">×</button>
          </div>
        }
      </div>

      <div class="pe-actions">
        <button type="button" class="pe-add" (click)="addStop()">+ Ajouter un stop</button>
        <button type="button" class="pe-save" [disabled]="!canSave()" (click)="emitSave()">{{ saveLabel() }}</button>
        <button type="button" class="pe-cancel" (click)="cancel.emit()">Annuler</button>
      </div>
    </div>
  `,
  styleUrl: './palette-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaletteEditorComponent {
  readonly initial = input<Palette | null>(null);
  readonly save = output<{ name: string; layerKind: LayerKind; stops: PaletteStop[] }>();
  readonly cancel = output<void>();

  readonly layerKinds: LayerKind[] = ['sst', 'wind', 'waves', 'wave-dir'];

  // Signals (réactifs OnPush). Pré-remplis depuis l'input ou défauts.
  readonly name = signal('');
  readonly layerKind = signal<LayerKind>('sst');
  readonly stops = signal<PaletteStop[]>([
    { quantity: 0,  color: '#1e3a8a', opacity: 0.7 },
    { quantity: 15, color: '#22c55e', opacity: 0.85 },
    { quantity: 30, color: '#dc2626', opacity: 0.95 },
  ]);

  ngOnInit(): void {
    const ini = this.initial();
    if (ini) {
      this.name.set(ini.name);
      this.layerKind.set(ini.layerKind);
      this.stops.set([...ini.stops]);
    }
  }

  layerLabel(k: LayerKind): string { return LAYER_LABEL[k]; }

  unitFor(k: LayerKind): string {
    return ({ sst: '°C', wind: 'm/s', waves: 'm', 'wave-dir': '°' } as Record<LayerKind, string>)[k];
  }

  readonly minQuantity = computed(() => Math.min(...this.stops().map((s) => s.quantity)));
  readonly maxQuantity = computed(() => Math.max(...this.stops().map((s) => s.quantity)));
  readonly canSave = computed(() => this.name().trim().length > 0 && this.stops().length >= 2);
  readonly saveLabel = computed(() => (this.initial() ? 'Mettre à jour' : 'Créer la palette'));

  /** CSS linear-gradient construit depuis stops (normalisés sur la plage). */
  readonly previewGradient = computed(() => {
    const sorted = [...this.stops()].sort((a, b) => a.quantity - b.quantity);
    if (sorted.length < 2) return 'transparent';
    const min = sorted[0].quantity;
    const max = sorted[sorted.length - 1].quantity;
    const span = max - min || 1;
    const stops = sorted.map((s) => {
      const pct = ((s.quantity - min) / span) * 100;
      const rgba = this.hexToRgba(s.color, s.opacity);
      return `${rgba} ${pct.toFixed(1)}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  });

  updateStop(index: number, key: keyof PaletteStop, value: any): void {
    this.stops.update((arr) => arr.map((s, i) => (i === index ? { ...s, [key]: value } : s)));
  }

  addStop(): void {
    const last = this.stops()[this.stops().length - 1];
    this.stops.update((arr) => [...arr, { quantity: last.quantity + 5, color: '#fde047', opacity: 0.9 }]);
  }

  removeStop(index: number): void {
    if (this.stops().length <= 2) return;
    this.stops.update((arr) => arr.filter((_, i) => i !== index));
  }

  emitSave(): void {
    const sorted = [...this.stops()].sort((a, b) => a.quantity - b.quantity);
    this.save.emit({ name: this.name().trim(), layerKind: this.layerKind(), stops: sorted });
  }

  anyTarget(ev: Event): HTMLInputElement {
    return ev.target as HTMLInputElement;
  }

  private hexToRgba(hex: string, opacity: number): string {
    const h = hex.replace('#', '');
    if (h.length !== 3 && h.length !== 6) return `rgba(127,127,127,${opacity})`;
    const expand = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(expand.slice(0, 2), 16);
    const g = parseInt(expand.slice(2, 4), 16);
    const b = parseInt(expand.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }
}
