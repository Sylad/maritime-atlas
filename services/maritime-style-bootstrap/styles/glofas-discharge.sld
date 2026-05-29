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
      <Abstract>Débit de rivière forecast GloFAS — ramp cyan (faible) → rouge (crue).
      Seuil de coloration bas (10 m³/s) + opacités fortes pour la visibilité des
      fleuves au zoom global. Transparent à 0 (océans/terres sans flux).</Abstract>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>0.9</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#00e5ff" quantity="0"      opacity="0"    label="0"/>
              <ColorMapEntry color="#00e5ff" quantity="10"     opacity="0.65" label="10"/>
              <ColorMapEntry color="#2171b5" quantity="50"     opacity="0.78" label="50"/>
              <ColorMapEntry color="#41ab5d" quantity="200"    opacity="0.85" label="200"/>
              <ColorMapEntry color="#fed976" quantity="1000"   opacity="0.9"  label="1000"/>
              <ColorMapEntry color="#fd8d3c" quantity="5000"   opacity="0.93" label="5000"/>
              <ColorMapEntry color="#e31a1c" quantity="20000"  opacity="0.96" label="20000"/>
              <ColorMapEntry color="#99000d" quantity="100000" opacity="1.0"  label="100000"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
