<?xml version="1.0" encoding="UTF-8"?>
<sld:StyledLayerDescriptor xmlns:sld="http://www.opengis.net/sld" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc" version="1.0.0">
  <sld:NamedLayer>
    <sld:Name>Default Styler</sld:Name>
    <sld:UserStyle>
      <sld:Name>wind-direct</sld:Name>
      <sld:Title>Wind speed rainbow direct (sans IDW, render rapide)</sld:Title>
      <sld:FeatureTypeStyle>
        <sld:Rule>
          <sld:RasterSymbolizer>
            <sld:ColorMap>
              <sld:ColorMapEntry color="#cbd5e1" opacity="0.0" quantity="0" label="0 m/s"/>
              <sld:ColorMapEntry color="#bae6fd" opacity="0.6" quantity="3" label="3 m/s (faible)"/>
              <sld:ColorMapEntry color="#38bdf8" opacity="0.7" quantity="6" label="6 m/s (modéré)"/>
              <sld:ColorMapEntry color="#22c55e" opacity="0.75" quantity="10" label="10 m/s (assez fort)"/>
              <sld:ColorMapEntry color="#fde047" opacity="0.8" quantity="14" label="14 m/s (fort)"/>
              <sld:ColorMapEntry color="#fb923c" opacity="0.85" quantity="18" label="18 m/s (très fort)"/>
              <sld:ColorMapEntry color="#dc2626" opacity="0.9" quantity="25" label="25 m/s (tempête)"/>
              <sld:ColorMapEntry color="#7f1d1d" opacity="0.95" quantity="35" label="35 m/s (ouragan)"/>
            </sld:ColorMap>
            <sld:ContrastEnhancement/>
            <sld:VendorOption name="interpolation">BICUBIC</sld:VendorOption>
          </sld:RasterSymbolizer>
        </sld:Rule>
      </sld:FeatureTypeStyle>
    </sld:UserStyle>
  </sld:NamedLayer>
</sld:StyledLayerDescriptor>
