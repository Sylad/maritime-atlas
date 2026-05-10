<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>sst-rainbow</Name>
    <UserStyle>
      <Title>Sea Surface Temperature rainbow (°C)</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#1e1b4b" quantity="-2" opacity="0.0"  label="-2 °C (gel)"/>
              <ColorMapEntry color="#3730a3" quantity="2"  opacity="0.7"  label="2 °C"/>
              <ColorMapEntry color="#1e40af" quantity="6"  opacity="0.75" label="6 °C"/>
              <ColorMapEntry color="#0ea5e9" quantity="10" opacity="0.8"  label="10 °C"/>
              <ColorMapEntry color="#06b6d4" quantity="13" opacity="0.85" label="13 °C"/>
              <ColorMapEntry color="#22c55e" quantity="16" opacity="0.85" label="16 °C"/>
              <ColorMapEntry color="#fde047" quantity="19" opacity="0.85" label="19 °C"/>
              <ColorMapEntry color="#fb923c" quantity="22" opacity="0.9"  label="22 °C"/>
              <ColorMapEntry color="#dc2626" quantity="26" opacity="0.9"  label="26 °C"/>
              <ColorMapEntry color="#7f1d1d" quantity="30" opacity="0.95" label="30 °C (Med été)"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
