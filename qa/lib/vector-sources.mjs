// kind → comment il est servi. Source de vérité = audit 2026-06-16 des
// branches de _fetchVectorFc (globe.component.ts:5311+) et des *.service.ts.
// timeEnabled : présent dans animatableLayersGlobe (lightning/alerts/vessels).
export const VECTOR_SOURCES = Object.freeze({
  vessels:   { kind: 'vector-wfs',   typeName: 'aetherwx:v_vessels_live',       timeEnabled: true  },
  alerts:    { kind: 'vector-wfs',   typeName: 'aetherwx:v_alerts_recent',      timeEnabled: true  },
  lightning: { kind: 'vector-wfs',   typeName: 'aetherwx:v_lightning_recent',   timeEnabled: true  },
  buoys:     { kind: 'vector-wfs',   typeName: 'aetherwx:v_buoy_observations_recent', timeEnabled: false },
  quakes:    { kind: 'vector-api',   endpoint: '/api/earthquakes/recent?at={AT}', timeEnabled: false },
  piezo:     { kind: 'vector-api',   endpoint: '/api/hubeau/piezo/recent?at={AT}', timeEnabled: false },
  hubeau:    { kind: 'vector-api',   endpoint: '/api/hubeau/recent?at={AT}',     timeEnabled: false },
  metar:     { kind: 'vector-api',   endpoint: '/api/metar/recent?at={AT}',      timeEnabled: false },
  firms:     { kind: 'vector-api',   endpoint: '/api/firms/recent?at={AT}',      timeEnabled: false },
  airports:  { kind: 'vector-api',   endpoint: '/api/airports',                  timeEnabled: false },
  fir:       { kind: 'vector-api',   endpoint: '/api/fir-airspaces',             timeEnabled: false },
  sigmet:    { kind: 'vector-proxy', endpoint: '/aviation-airsigmet?format=geojson&hours=2', timeEnabled: false },
  taf:       { kind: 'vector-proxy', endpoint: '/aviation-taf?format=geojson&hours=12&bbox=-90,-180,90,180', timeEnabled: false },
  cables:    { kind: 'vector-proxy', endpoint: '/cables-geo', fallbackCount: 5,  timeEnabled: false },
});
