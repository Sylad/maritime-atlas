import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaletteStop } from '../db/schema';

/**
 * Wrapper REST GeoServer pour upsert/delete des styles user-définis.
 * Pattern factorisé du sidecar bash `geoserver/provision.sh:upload_style()`
 * mais en TypeScript, idempotent (PUT body si style existe déjà).
 */
@Injectable()
export class GeoServerService {
  private readonly log = new Logger('GeoServerService');
  private readonly url: string;
  private readonly user: string;
  private readonly pass: string;
  private readonly workspace: string;

  constructor(private readonly config: ConfigService) {
    this.url = config.get<string>('geoserverUrl') ?? 'http://geoserver:8080/geoserver';
    this.user = config.get<string>('geoserverUser') ?? 'admin';
    this.pass = config.get<string>('geoserverPass') ?? 'geoserver';
    this.workspace = config.get<string>('geoserverWorkspace') ?? 'maritime';
  }

  private auth(): string {
    return 'Basic ' + Buffer.from(`${this.user}:${this.pass}`).toString('base64');
  }

  /** Build the SLD XML body for a user palette. */
  buildSld(styleName: string, stops: PaletteStop[]): string {
    const sortedStops = [...stops].sort((a, b) => a.quantity - b.quantity);
    const entries = sortedStops.map((s) => {
      const opacity = Number.isFinite(s.opacity) ? s.opacity : 0.85;
      const label = s.label ? ` label="${this.xmlEscape(s.label)}"` : '';
      return `              <ColorMapEntry color="${s.color}" quantity="${s.quantity}" opacity="${opacity}"${label}/>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>${styleName}</Name>
    <UserStyle>
      <Title>${styleName}</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="ramp">
${entries}
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
`;
  }

  /** POST /styles + PUT body. Idempotent via PUT-overwrite. */
  async upsertStyle(styleName: string, sldXml: string): Promise<void> {
    // Step 1 : ensure style entry exists
    const checkRes = await fetch(
      `${this.url}/rest/workspaces/${this.workspace}/styles/${styleName}.json`,
      { method: 'GET', headers: { Authorization: this.auth() } },
    );
    if (checkRes.status !== 200) {
      const createRes = await fetch(
        `${this.url}/rest/workspaces/${this.workspace}/styles`,
        {
          method: 'POST',
          headers: { Authorization: this.auth(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ style: { name: styleName, filename: `${styleName}.sld` } }),
        },
      );
      if (!createRes.ok) {
        const t = await createRes.text();
        throw new Error(`GeoServer style create ${styleName} HTTP ${createRes.status}: ${t.slice(0, 200)}`);
      }
    }
    // Step 2 : PUT the SLD body (overwrites if exists)
    const putRes = await fetch(
      `${this.url}/rest/workspaces/${this.workspace}/styles/${styleName}`,
      {
        method: 'PUT',
        headers: { Authorization: this.auth(), 'Content-Type': 'application/vnd.ogc.sld+xml' },
        body: sldXml,
      },
    );
    if (!putRes.ok) {
      const t = await putRes.text();
      throw new Error(`GeoServer style PUT ${styleName} HTTP ${putRes.status}: ${t.slice(0, 200)}`);
    }
    this.log.log(`Upserted GeoServer style ${this.workspace}:${styleName}`);
  }

  async deleteStyle(styleName: string): Promise<void> {
    const res = await fetch(
      `${this.url}/rest/workspaces/${this.workspace}/styles/${styleName}?recurse=true&purge=true`,
      { method: 'DELETE', headers: { Authorization: this.auth() } },
    );
    if (!res.ok && res.status !== 404) {
      const t = await res.text();
      throw new Error(`GeoServer style DELETE ${styleName} HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    this.log.log(`Deleted GeoServer style ${this.workspace}:${styleName}`);
  }

  /** Style name pattern : "user_<id>_<slug>" (workspace-scoped via maritime:user_…). */
  styleNameFor(userId: number, slug: string): string {
    return `user_${userId}_${slug}`;
  }

  private xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
