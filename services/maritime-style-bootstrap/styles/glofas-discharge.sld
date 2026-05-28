<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
    xmlns="http://www.opengis.net/sld"
    xmlns:ogc="http://www.opengis.net/ogc"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>glofas-discharge</Name>
    <UserStyle>
      <Title>GloFAS river discharge (m³/s)</Title>
      <Abstract>Débit de rivière forecast GloFAS — ramp bleu (faible) → rouge (crue).</Abstract>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>0.85</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#08519c" quantity="0"      opacity="0"    label="0"/>
              <ColorMapEntry color="#6baed6" quantity="50"     opacity="0.5"  label="50"/>
              <ColorMapEntry color="#2171b5" quantity="300"    opacity="0.7"  label="300"/>
              <ColorMapEntry color="#41ab5d" quantity="1000"   opacity="0.8"  label="1000"/>
              <ColorMapEntry color="#fed976" quantity="5000"   opacity="0.85" label="5000"/>
              <ColorMapEntry color="#fd8d3c" quantity="20000"  opacity="0.9"  label="20000"/>
              <ColorMapEntry color="#e31a1c" quantity="100000" opacity="0.95" label="100000"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
