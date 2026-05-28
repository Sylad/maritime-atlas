<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>temp-2m-thermal</Name>
    <UserStyle>
      <Title>Temperature 2m thermal (degC)</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>0.85</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#1e3a8a" quantity="-20" opacity="0.85" label="-20 degC"/>
              <ColorMapEntry color="#2563eb" quantity="-10" opacity="0.85" label="-10 degC"/>
              <ColorMapEntry color="#06b6d4" quantity="0"   opacity="0.85" label="0 degC"/>
              <ColorMapEntry color="#22c55e" quantity="15"  opacity="0.85" label="15 degC"/>
              <ColorMapEntry color="#fde047" quantity="22"  opacity="0.85" label="22 degC"/>
              <ColorMapEntry color="#fb923c" quantity="30"  opacity="0.9"  label="30 degC"/>
              <ColorMapEntry color="#dc2626" quantity="38"  opacity="0.9"  label="38 degC"/>
              <ColorMapEntry color="#7f1d1d" quantity="45"  opacity="0.95" label="45 degC"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
