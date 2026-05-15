<?xml version="1.0" encoding="UTF-8"?>
<sld:StyledLayerDescriptor xmlns:sld="http://www.opengis.net/sld" xmlns="http://www.opengis.net/sld" xmlns:gml="http://www.opengis.net/gml" xmlns:ogc="http://www.opengis.net/ogc" version="1.0.0">
  <sld:NamedLayer>
    <sld:Name>Default Styler</sld:Name>
    <sld:UserStyle>
      <sld:Name>wave-hs-only</sld:Name>
      <sld:Title>Wave Hs rainbow IDW smooth (sans isolignes) — default</sld:Title>
      <sld:FeatureTypeStyle>
        <sld:Name>raster</sld:Name>
        <sld:Transformation>
          <ogc:Function name="idw:IDW">
            <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
            <ogc:Function name="parameter">
              <ogc:Literal>factor</ogc:Literal><ogc:Literal>8</ogc:Literal>
            </ogc:Function>
          </ogc:Function>
        </sld:Transformation>
        <sld:Rule>
          <sld:RasterSymbolizer>
            <sld:ColorMap>
              <sld:ColorMapEntry color="#1e3a8a" opacity="0.0" quantity="0" label="0 m"/>
              <sld:ColorMapEntry color="#1e40af" opacity="0.5" quantity="0.5" label="0.5 m"/>
              <sld:ColorMapEntry color="#0ea5e9" opacity="0.65" quantity="1" label="1 m"/>
              <sld:ColorMapEntry color="#06b6d4" opacity="0.75" quantity="2" label="2 m"/>
              <sld:ColorMapEntry color="#22c55e" opacity="0.8" quantity="3" label="3 m"/>
              <sld:ColorMapEntry color="#fde047" opacity="0.85" quantity="4" label="4 m"/>
              <sld:ColorMapEntry color="#fb923c" opacity="0.9" quantity="6" label="6 m"/>
              <sld:ColorMapEntry color="#dc2626" opacity="0.95" quantity="9" label="9+ m (grosse mer)"/>
            </sld:ColorMap>
            <sld:ContrastEnhancement/>
            <sld:VendorOption name="interpolation">BICUBIC</sld:VendorOption>
          </sld:RasterSymbolizer>
        </sld:Rule>
      </sld:FeatureTypeStyle>
    </sld:UserStyle>
  </sld:NamedLayer>
</sld:StyledLayerDescriptor>
