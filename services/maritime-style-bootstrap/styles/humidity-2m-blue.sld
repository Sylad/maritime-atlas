<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>humidity-2m-blue</Name>
    <UserStyle>
      <Title>Relative humidity 2m (%)</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#f0f9ff" quantity="0"   opacity="0.0"  label="0 %"/>
              <ColorMapEntry color="#bae6fd" quantity="30"  opacity="0.45" label="30 %"/>
              <ColorMapEntry color="#38bdf8" quantity="55"  opacity="0.6"  label="55 %"/>
              <ColorMapEntry color="#2563eb" quantity="75"  opacity="0.75" label="75 %"/>
              <ColorMapEntry color="#1e3a8a" quantity="100" opacity="0.9"  label="100 %"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
