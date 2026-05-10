<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>wave-hs-rainbow</Name>
    <UserStyle>
      <Title>Significant wave height rainbow</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#1e3a8a" quantity="0"   opacity="0.0" label="0 m"/>
              <ColorMapEntry color="#1e40af" quantity="0.5" opacity="0.5" label="0.5 m"/>
              <ColorMapEntry color="#0ea5e9" quantity="1"   opacity="0.65" label="1 m"/>
              <ColorMapEntry color="#06b6d4" quantity="2"   opacity="0.75" label="2 m"/>
              <ColorMapEntry color="#22c55e" quantity="3"   opacity="0.8" label="3 m"/>
              <ColorMapEntry color="#fde047" quantity="4"   opacity="0.85" label="4 m"/>
              <ColorMapEntry color="#fb923c" quantity="6"   opacity="0.9" label="6 m"/>
              <ColorMapEntry color="#dc2626" quantity="9"   opacity="0.95" label="9+ m (grosse mer)"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
