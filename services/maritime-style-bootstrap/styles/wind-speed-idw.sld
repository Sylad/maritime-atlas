<?xml version="1.0" encoding="UTF-8"?>
<sld:StyledLayerDescriptor xmlns:sld="http://www.opengis.net/sld" xmlns="http://www.opengis.net/sld" xmlns:gml="http://www.opengis.net/gml" xmlns:ogc="http://www.opengis.net/ogc" version="1.0.0">
  <sld:NamedLayer>
    <sld:Name>Default Styler</sld:Name>
    <sld:UserStyle>
      <sld:Name>wind-speed-idw</sld:Name>
      <sld:Title>Wind speed rainbow IDW smooth (sans contours)</sld:Title>
      <sld:Abstract>Variante de wind-speed-with-contours sans le FeatureTypeStyle "contours" — IDW seul. Sert de default pour le layer maritime:wind-speed afin que le rendu raster soit toujours lissé même sans toggle « isolignes ».</sld:Abstract>
      <sld:FeatureTypeStyle>
        <sld:Name>raster</sld:Name>
        <sld:Transformation>
          <ogc:Function name="idwInterpolate">
            <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
            <!-- factor=12 + BILINEAR : compromis pragmatique. La native
                 preservation par GS est bypassée en cross-CRS (target=3857,
                 source=4326), donc le reader sert ~target res au IDW.
                 BILINEAR contrôle l'interp du reader (sinon NN). factor=12
                 multiplie pour densifier au-delà ; GS adjuste à la fin.
                 La vraie solution architecturale (CoverageReadingTransformation)
                 nécessite un rewrite du plugin — voir backlog. -->
            <ogc:Function name="parameter">
              <ogc:Literal>factor</ogc:Literal><ogc:Literal>12</ogc:Literal>
            </ogc:Function>
          </ogc:Function>
        </sld:Transformation>
        <sld:Rule>
          <sld:RasterSymbolizer>
            <sld:ColorMap>
              <sld:ColorMapEntry color="#cbd5e1" opacity="0.0" quantity="0" label="0 m/s"/>
              <sld:ColorMapEntry color="#bae6fd" opacity="0.6" quantity="3" label="3 m/s (faible)"/>
              <sld:ColorMapEntry color="#38bdf8" opacity="0.7" quantity="6" label="6 m/s (modéré)"/>
              <sld:ColorMapEntry color="#22c55e" opacity="0.75" quantity="10" label="10 m/s (assez fort)"/>
              <sld:ColorMapEntry color="#fde047" opacity="0.8" quantity="14" label="14 m/s (fort)"/>
              <sld:ColorMapEntry color="#fb923c" opacity="0.85" quantity="18" label="18 m/s (très fort)"/>
              <sld:ColorMapEntry color="#dc2626" opacity="0.9" quantity="25" label="25 m/s (tempête)"/>
              <sld:ColorMapEntry color="#7f1d1d" opacity="0.95" quantity="35" label="35 m/s (ouragan)"/>
            </sld:ColorMap>
            <!-- BILINEAR : contrôle l'interpolation du reader quand il upsample
                 native (e.g. 11×8 cells) vers la grille readGG (target+padding).
                 Sans cette option, le reader fait du NN-replicate → IDW reçoit
                 du blocky → sortie blocky. ContrastEnhancement reste EXCLU. -->
            <sld:VendorOption name="interpolation">BILINEAR</sld:VendorOption>
          </sld:RasterSymbolizer>
        </sld:Rule>
      </sld:FeatureTypeStyle>
    </sld:UserStyle>
  </sld:NamedLayer>
</sld:StyledLayerDescriptor>
