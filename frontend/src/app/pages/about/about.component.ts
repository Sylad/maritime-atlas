import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * About page — pattern factorisé des autres apps Sylad (warhammer, finance,
 * ol-companion, eywa, evatosorus). Tons : sobre + une vanne en ouverture +
 * histoire courte + stack + sources data + CTA encouragement.
 *
 * Particularité maritime-atlas : **premier projet 100% solo-avec-Claude**.
 * Sur les 5 autres sites, ChatGPT a contribué aux logos / mockups UX.
 * Ici, aucun visuel généré ailleurs — la légende, les SVG arrows, les
 * couleurs (palettes Beaufort, états-mer) sont tous écrits ligne par
 * ligne en pair-programming. Le fond de carte est le seul élément externe.
 */
@Component({
  selector: 'app-about',
  imports: [RouterLink],
  template: `
    <div class="about-shell">
      <section class="hero">
        <div class="hero-overlay"></div>
        <div class="hero-content">
          <div class="eyebrow">Atlas live · France métropole</div>
          <h1>Le matelot et le copilote</h1>
          <p class="lede">
            Un atlas maritime construit en deux jours, par un dev curieux et un
            agent IA. Pas une ligne d'humain dans le code — promis,
            <a routerLink="/" class="inline-link">la carte est juste à côté</a>
            si tu veux vérifier.
          </p>
        </div>
      </section>

      <section class="story">
        <div class="story-side">
          <div class="sigil">⚓</div>
          <div class="story-meta">
            <div class="meta-line">CO-AUTEUR</div>
            <div class="meta-name">Claude Code</div>
            <div class="meta-line muted">Opus 4.7 · Anthropic</div>
          </div>
        </div>
        <div class="story-body">
          <h2>L'histoire courte</h2>
          <p>
            Mon métier au boulot, c'est de développer Neo chez Campbell
            Scientific — un produit qui sert des météos et des aéroports.
            Stack : Angular + OpenLayers + cluster Docker Swarm de GeoServer,
            avec RabbitMQ pour synchroniser les replicas. J'adore ce pattern
            services-qui-causent-entre-eux par bus, et j'avais envie d'en
            refaire un, dans un domaine totalement différent pour ne pas
            empiéter sur le taf — la mer plutôt que le ciel.
          </p>
          <p>
            <strong>AetherWX</strong> est né de là, et de l'envie de
            tester jusqu'où une session intensive de pair-programming avec
            un agent IA pouvait aller. Le périmètre s'est élargi rapidement :
            j'ai commencé par "AIS sur la Bretagne", j'ai fini avec un atlas
            multi-source (AIS, météo NOAA, ARPEGE Météo-France, radar pluie,
            foudre Blitzortung), un moteur d'alertes RabbitMQ, un cluster
            GeoServer 3 replicas avec catalog partagé en Postgres, et des
            particules de vent style windy.com.
          </p>
          <p class="emphasis">
            Particularité de ce site : c'est mon premier projet 100% solo
            avec Claude — pas de ChatGPT pour les visuels, pas de Copilot
            pour le code, pas de Midjourney pour les éléments graphiques.
            Tout — backend, frontend, SVG inline, SLD, Mermaid de doc — a
            été écrit en pair-programming avec Claude Code, de bout en bout.
          </p>
        </div>
      </section>

      <section class="stack">
        <h2>Stack technique</h2>
        <div class="stack-grid">
          <div class="stack-card">
            <div class="stack-eyebrow">Frontend</div>
            <ul>
              <li>Angular 19 (standalone components, signals, OnPush)</li>
              <li>OpenLayers 10 (carte, time-enabled WMS, custom VectorLayer)</li>
              <li>SCSS pur, theme custom dark</li>
              <li>Canvas 2D pour les particules de vent (~1500 advectées par IDW)</li>
            </ul>
          </div>
          <div class="stack-card">
            <div class="stack-eyebrow">Backend & ingestion</div>
            <ul>
              <li>NestJS 11 (api auth JWT + Google OAuth + RBAC, palettes, ais-decoder, track-builder)</li>
              <li>Python 3.12 + xarray + rioxarray + cfgrib (3 fetchers météo)</li>
              <li>Node 22 + ws (ais-ingester, lightning-fetcher, alerts-engine)</li>
              <li>Drizzle ORM (Postgres, schémas isolés)</li>
              <li>Resend SDK (vérification email) · passport-google-oauth20</li>
            </ul>
          </div>
          <div class="stack-card">
            <div class="stack-eyebrow">Infra & data</div>
            <ul>
              <li>PostgreSQL 16 + PostGIS + TimescaleDB (hypertables vessels, lightning, alerts)</li>
              <li>GeoServer 2.27 cluster 3 replicas + JDBCConfig (catalog Postgres)</li>
              <li>RabbitMQ 3.13 (topic exchanges, fanout raster.ready)</li>
              <li>Docker Compose, déployé sur NAS Synology 1821+, exposé via Cloudflare Tunnel</li>
            </ul>
          </div>
        </div>
      </section>

      <section class="sources">
        <h2>Origine des données</h2>
        <div class="sources-intro">
          Toutes les données affichées sont issues de sources publiques ou
          communautaires. Pas de scraping illégal, pas de revente, pas de clé
          API payante — la gratuité (relative) du domaine maritime open data
          est ce qui a rendu ce projet possible en un week-end.
        </div>
        <div class="sources-list">
          <div class="source-card">
            <div class="source-name">Fond de carte</div>
            <div class="source-detail">
              <a href="https://carto.com/basemaps/" target="_blank" rel="noopener">
                CARTO Dark Matter <span class="ext">⤤</span>
              </a>
              — basemap raster XYZ basé sur OpenStreetMap. Style sombre adapté
              aux visualisations data. Attribution requise :
              <em>© OpenStreetMap contributors, © CARTO</em>.
            </div>
          </div>
          <div class="source-card">
            <div class="source-name">Positions AIS (navires live)</div>
            <div class="source-detail">
              <a href="https://aisstream.io/" target="_blank" rel="noopener">
                aisstream.io <span class="ext">⤤</span>
              </a>
              — agrégateur communautaire de messages AIS, WebSocket gratuit
              avec compte (limité bbox). Flux temps réel ~50-250 messages/s
              en bbox France métropole.
            </div>
          </div>
          <div class="source-card">
            <div class="source-name">Température mer (SST)</div>
            <div class="source-detail">
              <a href="https://www.ncei.noaa.gov/products/optimum-interpolation-sst" target="_blank" rel="noopener">
                NOAA OISST v2.1 <span class="ext">⤤</span>
              </a>
              — analyse quotidienne 0.25° depuis 1981. NetCDF téléchargé direct
              depuis NCEI, converti en GeoTIFF time-tagged pour GeoServer.
            </div>
          </div>
          <div class="source-card">
            <div class="source-name">Vent + Vagues (forecast)</div>
            <div class="source-detail">
              <a href="https://nomads.ncep.noaa.gov/" target="_blank" rel="noopener">
                NOAA NOMADS GFS + WaveWatch III <span class="ext">⤤</span>
              </a>
              — modèles globaux 0.25°, 4 runs par jour, forecast +384h (vent)
              / +180h (vagues). CGI subsetters renvoient un GRIB2 ciblé bbox
              France métropole.
            </div>
          </div>
          <div class="source-card">
            <div class="source-name">Vent (modèle Europe)</div>
            <div class="source-detail">
              <a href="https://meteo.data.gouv.fr/" target="_blank" rel="noopener">
                Météo-France ARPEGE via bucket PNT public <span class="ext">⤤</span>
              </a>
              — modèle régional 0.1° (~11km) couvrant l'Europe étroite,
              2.5× plus fin que GFS et alimenté 4 runs/jour. Open data
              sans clé API (bucket S3 public meteofrance-pnt sur
              object.data.gouv.fr).
            </div>
          </div>
          <div class="source-card">
            <div class="source-name">Radar pluie</div>
            <div class="source-detail">
              <a href="https://www.rainviewer.com/api.html" target="_blank" rel="noopener">
                RainViewer API <span class="ext">⤤</span>
              </a>
              — service gratuit, sans clé, CORS open. Couvre [-2h, +30min] en
              tiles XYZ time-aware (~10 min de fréquence).
            </div>
          </div>
          <div class="source-card">
            <div class="source-name">Foudre</div>
            <div class="source-detail">
              <a href="https://www.blitzortung.org/en/live_lightning_data.php" target="_blank" rel="noopener">
                Blitzortung community network <span class="ext">⤤</span>
              </a>
              — réseau communautaire de détecteurs d'éclairs (signal radio
              VLF). WebSocket public, JSON LZW-compressé, ~10 strikes/s
              globaux dont 10-40/30s en bbox France pendant un orage.
            </div>
          </div>
        </div>
      </section>

      <section class="cta">
        <h2>Si tu veux faire pareil</h2>
        <p>
          Prends un domaine qui t'enflamme. Pour moi c'est les cartes et les
          données géo-temporelles ; pour toi ça peut être l'astronomie, les
          recettes anciennes, les trains régionaux, le rugby amateur. Le
          domaine te porte quand l'implémentation devient sèche.
        </p>
        <p>
          Démarre petit (1 source, 1 layer, 1 toggle), pose le pipeline
          minimal, et seulement après — quand le boucle marche — ajoute le
          reste. AetherWX a commencé par 1 ingester AIS et 1 carte
          OpenLayers. Tout le reste s'est greffé naturellement.
        </p>
        <p>
          Le code est entièrement public sur
          <a href="https://github.com/Sylad/maritime-atlas" target="_blank" rel="noopener">
            GitHub <span class="ext">⤤</span>
          </a>,
          et le deep-dive technique (architecture, mermaid des pipelines,
          lessons learned) est sur
          <a href="https://claude-code-codex.pages.dev/case-studies/maritime-atlas" target="_blank" rel="noopener">
            claude-code-codex <span class="ext">⤤</span>
          </a>.
        </p>
        <a routerLink="/" class="cta-button">← Retour à la carte</a>
      </section>
    </div>
  `,
  styleUrl: './about.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutComponent {}
