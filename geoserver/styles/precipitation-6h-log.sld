<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>precipitation-6h-log</Name>
    <UserStyle>
      <Title>Precipitation cumulative (mm, log scale)</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>0.85</Opacity>
            <!-- quasi-log : seuils 0.1 / 1 / 10 / 50 / 100 mm -->
            <ColorMap type="ramp">
              <ColorMapEntry color="#06b6d4" quantity="0.1" opacity="0.0"  label="&lt; 0.1 mm (sec)"/>
              <ColorMapEntry color="#22d3ee" quantity="1"   opacity="0.6"  label="1 mm"/>
              <ColorMapEntry color="#2563eb" quantity="10"  opacity="0.8"  label="10 mm"/>
              <ColorMapEntry color="#7c3aed" quantity="50"  opacity="0.9"  label="50 mm"/>
              <ColorMapEntry color="#db2777" quantity="100" opacity="0.95" label="100 mm (deluge)"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
