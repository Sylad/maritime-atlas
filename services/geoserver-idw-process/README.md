# gs-idw-process — Plugin GeoServer IDW (native preservation)

SLD rendering functions custom pour interpolation IDW (Inverse Distance Weighting)
en rendering-time, sans toucher aux données stockées. Standard météo / océano pour
adoucir les rasters issus de modèles à grille régulière (GFS 0.25°, OISST 0.25°,
ARPEGE 0.1°...) sans pre-densifier au stockage.

## Architecture — pattern `CoverageReadingTransformation`

Le plugin implémente le pattern officiel GeoTools/GeoServer
[`CoverageReadingTransformation`](https://github.com/geotools/geotools/blob/main/modules/library/coverage/src/main/java/org/geotools/coverage/grid/io/CoverageReadingTransformation.java)
(cf `FootprintsTransformation` imagemosaic), qui permet à la rendering function de
**lire elle-même son coverage source** au lieu de recevoir un upsample auto du
pipeline GS.

```
maritime-atlas request WMS GetMap (bbox + width×height target)
  ↓ STYLES=maritime:sst-with-contours
GeoServer SLD parser : <Transformation> idwInterpolate / idwContour
  ↓
RenderingTransformationHelper.applyRenderingTransformation()
  ↓ if (tx instanceof CoverageReadingTransformation) {  ← marker check
  ↓   return tx.evaluate(new ReaderAndParams(reader, params));
  ↓ }
IDWFunction.evaluate(ReaderAndParams)
  ↓ reader.read(params)         ← native resolution
  ↓ IDWProcess.applyIDW(...)    ← densify factor× sur native pure
  ↓ return GridCoverage2D       ← rendered par GS post-IDW
```

**Sans ce pattern** (l'ancienne version `@DescribeProcess` WPS), GS upsamplait le
coverage source à la résolution d'affichage (e.g. 16×8 native GFS → 532×533
target) en NN avant de le passer à IDW → IDW interpolait des données déjà
fake-upsampled → blocky visible.

**Avec ce pattern**, IDW reçoit les pixels natifs purs, densifie ×factor → output
≈ display res, GS rend le tout. Single interpolation, smooth garanti.

Mesures (wind plein écran 2560×1271 GFS Europe) :
- Avant : OOM JVM 6 GB heap, exit 3, ~15s
- Après : smooth, 0.9s, ~50 MB peak

## Fonctions exposées

| Function | Type retour | Usage |
|---|---|---|
| `idwInterpolate` | `GridCoverage2D` | Densifie un raster source ×factor |
| `idwContour` | `SimpleFeatureCollection` (LineString) | Densifie via IDW puis extrait contours (Bezier smooth) |

## Build

```bash
# Dockerfile multi-stage (recommandé)
cd services/geoserver-idw-process
docker build -t maritime-gs-idw-build -f Dockerfile .
docker create --name idw-extract maritime-gs-idw-build
docker cp idw-extract:/jar ./target
docker rm idw-extract
# JAR à target/gs-idw-process-0.1.0.jar
```

## Deploy

Le JAR est intégré à l'image custom `ghcr.io/sylad/maritime-geoserver` (cf
`geoserver/Dockerfile` qui copie `geoserver/plugins/*.jar` dans `WEB-INF/lib/`).
Cycle :

```bash
cp target/gs-idw-process-0.1.0.jar ../../geoserver/plugins/
git commit -m "..." && git push          # CI rebuild + push image
# bump tag dans developpeur-gitops charts/maritime/values.yaml
# ArgoCD sync → rolling restart cluster GS
```

## Verify registration

Au boot GS, vérifier dans les logs Tomcat :

```
INFO [main] geoserver.platform - Loaded jar: gs-idw-process-0.1.0.jar
```

Et tester via SLD upload REST :

```bash
curl -X POST -H "Content-Type: application/vnd.ogc.sld+xml" \
  -u admin:geoserver \
  -d @test.sld \
  http://geoserver:8080/geoserver/rest/workspaces/maritime/styles?name=test
# Doit retourner 201 (pas 400 "Unable to find function idwInterpolate")
```

## Usage SLD

### Raster densification (`idwInterpolate`)

```xml
<FeatureTypeStyle>
  <Transformation>
    <ogc:Function name="idwInterpolate">
      <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
      <ogc:Function name="parameter">
        <ogc:Literal>factor</ogc:Literal><ogc:Literal>12</ogc:Literal>
      </ogc:Function>
    </ogc:Function>
  </Transformation>
  <Rule>
    <RasterSymbolizer>
      <ColorMap>...</ColorMap>
    </RasterSymbolizer>
  </Rule>
</FeatureTypeStyle>
```

### IDW + isolignes combinés (`idwContour`)

```xml
<FeatureTypeStyle>
  <Transformation>
    <ogc:Function name="idwContour">
      <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
      <ogc:Function name="parameter">
        <ogc:Literal>factor</ogc:Literal><ogc:Literal>12</ogc:Literal>
      </ogc:Function>
      <ogc:Function name="parameter">
        <ogc:Literal>interval</ogc:Literal><ogc:Literal>2.0</ogc:Literal>
      </ogc:Function>
      <ogc:Function name="parameter">
        <ogc:Literal>smooth</ogc:Literal><ogc:Literal>true</ogc:Literal>
      </ogc:Function>
    </ogc:Function>
  </Transformation>
  <Rule>
    <LineSymbolizer>...</LineSymbolizer>
  </Rule>
</FeatureTypeStyle>
```

## Paramètres

### `idwInterpolate`

| Param | Default | Range | Description |
|---|---|---|---|
| `data` | (required) | — | source marker (handled by pipeline) |
| `factor` | 4 | 1-32 | Multiplicateur résolution (×N lon, ×N lat) |
| `power` | 2.0 | 0.1-10 | Exposant distance (1.5-3.0 typique météo) |
| `neighbors` | 8 | 1-25 | Nb voisins source par pixel destination |

### `idwContour`

Hérite tous les params de `idwInterpolate` plus :

| Param | Default | Description |
|---|---|---|
| `interval` | (required) | Intervalle entre isolignes (e.g. 2.0 = tous les 2°C / 2 m/s) |
| `simplify` | true | Douglas-Peucker simplification |
| `smooth` | true | Bezier smoothing des LineStrings |

## SPI registration

```
META-INF/services/org.geotools.api.filter.expression.Function:
  fr.sladoire.maritime.idw.IDWFunction
  fr.sladoire.maritime.idw.IDWContourFunction
```

`IDWProcessFactory.java` est conservé comme stub vide (0 process enregistré) —
les catalogues GS JDBCConfig persistent le FQN xstream, le supprimer plantait
au boot. À retirer définitivement après reset catalogue.

## TODO

- [ ] Tests unitaires (JUnit + GeoTools test fixtures)
- [ ] Bench perf vs `ras:Affine` + bicubic resampling
- [ ] Support multi-band (currently band 0 only)
- [ ] Récupérer la bbox target dans `evaluate(ReaderAndParams)` pour optimiser
      lecture sur gros coverage (actuellement on lit le full coverage)

## Références

- [CoverageReadingTransformation interface](https://github.com/geotools/geotools/blob/main/modules/library/coverage/src/main/java/org/geotools/coverage/grid/io/CoverageReadingTransformation.java)
- [FootprintsTransformation example](https://github.com/geotools/geotools/blob/main/modules/plugin/imagemosaic/src/main/java/org/geotools/gce/imagemosaic/FootprintsTransformation.java)
- [RenderingTransformationHelper source](https://github.com/geotools/geotools/blob/main/modules/library/render/src/main/java/org/geotools/renderer/lite/RenderingTransformationHelper.java)
- [GeoTools ContourProcess](https://github.com/geotools/geotools/blob/main/modules/unsupported/process-raster/src/main/java/org/geotools/process/raster/ContourProcess.java)
