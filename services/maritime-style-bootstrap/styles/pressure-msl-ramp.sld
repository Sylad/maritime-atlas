<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>pressure-msl-ramp</Name>
    <UserStyle>
      <Title>Mean sea level pressure (hPa)</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>0.8</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#6d28d9" quantity="980"  opacity="0.85" label="980 hPa (depression)"/>
              <ColorMapEntry color="#3b82f6" quantity="1000" opacity="0.8"  label="1000 hPa"/>
              <ColorMapEntry color="#e5e7eb" quantity="1013" opacity="0.6"  label="1013 hPa (normale)"/>
              <ColorMapEntry color="#f59e0b" quantity="1025" opacity="0.8"  label="1025 hPa"/>
              <ColorMapEntry color="#b91c1c" quantity="1040" opacity="0.85" label="1040 hPa (anticyclone)"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
