<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>wind-speed-rainbow</Name>
    <UserStyle>
      <Title>Wind speed rainbow (Beaufort)</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#cbd5e1" quantity="0"  opacity="0.0" label="0 m/s"/>
              <ColorMapEntry color="#bae6fd" quantity="3"  opacity="0.6" label="3 m/s (faible)"/>
              <ColorMapEntry color="#38bdf8" quantity="6"  opacity="0.7" label="6 m/s (modéré)"/>
              <ColorMapEntry color="#22c55e" quantity="10" opacity="0.75" label="10 m/s (assez fort)"/>
              <ColorMapEntry color="#fde047" quantity="14" opacity="0.8" label="14 m/s (fort)"/>
              <ColorMapEntry color="#fb923c" quantity="18" opacity="0.85" label="18 m/s (très fort)"/>
              <ColorMapEntry color="#dc2626" quantity="25" opacity="0.9" label="25 m/s (tempête)"/>
              <ColorMapEntry color="#7f1d1d" quantity="35" opacity="0.95" label="35 m/s (ouragan)"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
