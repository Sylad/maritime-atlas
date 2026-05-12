# gs-idw-process — Plugin GeoServer IDW interpolation

WPS process custom pour interpolation IDW (Inverse Distance Weighting)
en rendering-time, sans toucher aux données stockées. Standard météo /
océano pour adoucir les rasters issus de modèles à grille régulière
(GFS 0.25°, OISST 0.25°, ARPEGE 0.1°...) sans pre-densifier au stockage.

**Architecture cible** :

```
maritime-atlas request WMS
  ↓ STYLES=maritime:sst-with-idw-contours
GeoServer SLD parser
  ↓ <Transformation> chain
  1. idw:IDW(data=coverage, factor=4, power=2)  → densified raster
  2. ras:Contour(data=above, interval=2)        → isolines vector
  3. <Symbolizer> stroke/fill/label rules
```

Data originale intacte côté coverage store (GetFeatureInfo / WCS
GetCoverage retournent toujours les valeurs sources). L'IDW est
purement rendering-side.

## Build

```bash
# Option A : Dockerfile multi-stage (recommandé)
cd services/geoserver-idw-process
docker build -t maritime-gs-idw-build -f Dockerfile .
docker create --name idw-extract maritime-gs-idw-build
docker cp idw-extract:/jar ./target
docker rm idw-extract

# Option B : Maven local
docker run --rm -v "$(pwd)":/build -v "$HOME"/.m2:/root/.m2 -w /build \
  maven:3.9-eclipse-temurin-17 mvn package -DskipTests
# JAR à target/gs-idw-process-0.1.0.jar
```

## Deploy dans GeoServer

```bash
# Copier le JAR dans le container GeoServer
docker cp target/gs-idw-process-0.1.0.jar \
  maritime-geoserver-1:/usr/local/tomcat/webapps/geoserver/WEB-INF/lib/

# Restart GeoServer (chaque replica si cluster)
docker compose restart geoserver
```

## Verify registration

Une fois GeoServer redémarré, vérifier que le process est exposé :

```bash
# Liste les WPS processes disponibles
curl -s "http://nas:8580/geoserver/ows?service=WPS&version=1.0.0&request=GetCapabilities" \
  | grep -i "idw:"

# Expected output (parmi d'autres) :
# <wps:Identifier>idw:IDW</wps:Identifier>
```

## Usage SLD

```xml
<FeatureTypeStyle>
  <Transformation>
    <ogc:Function name="idw:IDW">
      <ogc:Function name="parameter">
        <ogc:Literal>data</ogc:Literal>
      </ogc:Function>
      <ogc:Function name="parameter">
        <ogc:Literal>factor</ogc:Literal>
        <ogc:Function name="env">
          <ogc:Literal>idwFactor</ogc:Literal>
          <ogc:Literal>4</ogc:Literal>
        </ogc:Function>
      </ogc:Function>
      <ogc:Function name="parameter">
        <ogc:Literal>power</ogc:Literal>
        <ogc:Literal>2.0</ogc:Literal>
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

## Paramètres

| Param | Default | Description |
|---|---|---|
| `data` | (required) | GridCoverage2D source |
| `factor` | 4 | Multiplicateur résolution (×N lon, ×N lat) |
| `power` | 2.0 | Exposant distance (1.5-3.0 typique météo) |
| `neighbors` | 8 | Nb voisins source par pixel destination |

## TODO

- [ ] Tests unitaires (JUnit + GeoTools test fixtures)
- [ ] Bench perf vs `ras:Affine` + bicubic resampling
- [ ] Cache de l'output sur la même bbox (éviter recompute par tile)
- [ ] Support multi-band (currently band 0 only)

## Références

- GeoTools ContourProcess : https://github.com/geotools/geotools/blob/main/modules/unsupported/process-raster/src/main/java/org/geotools/process/raster/ContourProcess.java
- RasterProcessFactory pattern : https://github.com/geotools/geotools/blob/main/modules/unsupported/process-raster/src/main/java/org/geotools/process/raster/RasterProcessFactory.java
- GeoServer custom WPS process : https://docs.geoserver.org/main/en/user/extensions/wps/
