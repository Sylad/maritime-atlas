<?xml version="1.0" encoding="UTF-8"?>
<sld:StyledLayerDescriptor xmlns:sld="http://www.opengis.net/sld" xmlns="http://www.opengis.net/sld" xmlns:gml="http://www.opengis.net/gml" xmlns:ogc="http://www.opengis.net/ogc" version="1.0.0">
  <sld:NamedLayer>
    <sld:Name>Default Styler</sld:Name>
    <sld:UserStyle>
      <sld:Name>sst-only</sld:Name>
      <sld:Title>SST rainbow IDW smooth (sans isolignes) — default</sld:Title>
      <sld:Abstract>Variante raster-only de sst-with-contours. Default pour sst-daily.</sld:Abstract>
      <sld:FeatureTypeStyle>
        <sld:Name>raster</sld:Name>
        <sld:Transformation>
          <ogc:Function name="idw:IDW">
            <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
            <ogc:Function name="parameter">
              <ogc:Literal>factor</ogc:Literal><ogc:Literal>4</ogc:Literal>
            </ogc:Function>
          </ogc:Function>
        </sld:Transformation>
        <sld:Rule>
          <sld:RasterSymbolizer>
            <sld:ColorMap>
              <sld:ColorMapEntry color="#1e1b4b" opacity="0.0" quantity="-2" label="-2 °C (gel)"/>
              <sld:ColorMapEntry color="#3730a3" opacity="0.7" quantity="2" label="2 °C"/>
              <sld:ColorMapEntry color="#1e40af" opacity="0.75" quantity="6" label="6 °C"/>
              <sld:ColorMapEntry color="#0ea5e9" opacity="0.8" quantity="10" label="10 °C"/>
              <sld:ColorMapEntry color="#06b6d4" opacity="0.85" quantity="13" label="13 °C"/>
              <sld:ColorMapEntry color="#22c55e" opacity="0.85" quantity="16" label="16 °C"/>
              <sld:ColorMapEntry color="#fde047" opacity="0.85" quantity="19" label="19 °C"/>
              <sld:ColorMapEntry color="#fb923c" opacity="0.9" quantity="22" label="22 °C"/>
              <sld:ColorMapEntry color="#dc2626" opacity="0.9" quantity="26" label="26 °C"/>
              <sld:ColorMapEntry color="#7f1d1d" opacity="0.95" quantity="30" label="30 °C (Med été)"/>
            </sld:ColorMap>
            <sld:ContrastEnhancement/>
            <sld:VendorOption name="interpolation">BICUBIC</sld:VendorOption>
          </sld:RasterSymbolizer>
        </sld:Rule>
      </sld:FeatureTypeStyle>
    </sld:UserStyle>
  </sld:NamedLayer>
</sld:StyledLayerDescriptor>
