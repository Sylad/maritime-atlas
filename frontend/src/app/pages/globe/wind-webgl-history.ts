/**
 * WindWebGLHistory — rev5 (2026-05-21) : algo history-per-particle équivalent
 * canvas 2D OL prod. Refactor majeur vs Mapbox webgl-wind FBO accumulator.
 *
 * Différences vs wind-webgl.ts :
 *   - Texture history (particleRes × K_HISTORY, particleRes) au lieu de
 *     pos0/pos1 swap + age0/age1 swap.
 *   - Slot 0 (x ∈ [0, particleRes)) = position courante (head, opaque).
 *     Slot K-1 (x ∈ [(K-1)×particleRes, K×particleRes)) = plus ancienne (tail).
 *   - Update : ring buffer shift. Chaque frame, slot 0 = advecté depuis prev
 *     slot 0, slot k>0 = copié depuis prev slot k-1. Plus de age texture.
 *   - Draw : N×(K-1) segments connectés par particule. Chaque segment lit
 *     pos depuis history slot k et slot k+1. Alpha = (sub_idx + a_t) / (K-1)
 *     → tail = 0, head = 1 (gradient identique canvas 2D ctx.lineTo).
 *   - PAS de screen FBO fade. Dessine directement sur la canvas MapLibre
 *     avec BLEND. Pas de _drawScreen, _drawTexture, backgroundTexture.
 *   - setMoving() devient no-op (pas de FBO à clear).
 *
 * Coût GPU :
 *   - Update : (particleRes × K) × particleRes pixels écrits par frame.
 *     Pour N=3000, K=28 : 55×28×55 ≈ 85k pixels. Trivial.
 *   - Draw : N × (K-1) × 6 vertices par frame. Pour N=3000, K=28 : ~486k
 *     vertices. Plus que rev3 (60k @ K=5) mais largement OK GPU desktop.
 *
 * API publique compatible avec WindWebGL (drop-in replacement).
 */

export interface WindBbox {
  bounds: [number, number, number, number];
}

export interface WindTextureData {
  image: Uint8Array;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface MapLibreShaderData {
  variantName: string;
  vertexShaderPrelude: string;
  define: string;
}

export interface MapLibreProjectionData {
  mainMatrix: Float32Array | number[];
  fallbackMatrix: Float32Array | number[];
  tileMercatorCoords: [number, number, number, number];
  clippingPlane: [number, number, number, number];
  projectionTransition: number;
}

export interface MapLibreCustomLayerRenderArgs {
  shaderData: MapLibreShaderData;
  defaultProjectionData: MapLibreProjectionData;
}

interface ProgramWrapper {
  program: WebGLProgram;
  [k: string]: WebGLProgram | WebGLUniformLocation | number | null | undefined;
}

// Nombre de slots historiques par particule. Canvas 2D OL = trailLength=28.
// Sylvain a demandé trails plus longs sans toucher speedFactor → bump à 50.
const K_HISTORY = 50;

// ─── Update fragment shader ─────────────────────────────────────────────
// Ring buffer shift : à chaque frame, pour chaque pixel (x, y) :
//   - Si x < particleRes : slot 0 (newest). On lit slot 0 de history_in
//     (= position courante prev frame), on applique advection wind, on
//     écrit la nouvelle position.
//   - Si x >= particleRes : slot k > 0. On copie history_in[x-particleRes, y]
//     vers history_out[x, y] (shift à droite : slot k-1 → slot k).
//
// On utilise gl_FragCoord.xy directement (pas v_tex_pos) pour éviter la
// confusion avec le flip quad. gl_FragCoord est en pixels du viewport.

const updateFrag = `#version 300 es
precision highp float;

uniform sampler2D u_history_in;
uniform sampler2D u_wind;
uniform vec2 u_wind_res;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform vec4 u_bbox;
uniform float u_rand_seed;
uniform float u_speed_factor;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;
uniform float u_particle_res;
uniform float u_k_history;

in vec2 v_tex_pos;
out vec4 fragOut;

const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);
float rand(const vec2 co) {
  float t = dot(rand_constants.xy, co);
  return fract(sin(t) * (rand_constants.z + t));
}

vec2 lookup_wind(const vec2 uv) {
  vec2 px = 1.0 / u_wind_res;
  vec2 vc = (floor(uv * u_wind_res)) * px;
  vec2 f = fract(uv * u_wind_res);
  vec2 tl = texture(u_wind, vc).rg;
  vec2 tr = texture(u_wind, vc + vec2(px.x, 0)).rg;
  vec2 bl = texture(u_wind, vc + vec2(0, px.y)).rg;
  vec2 br = texture(u_wind, vc + px).rg;
  return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

vec2 decode_pos(vec4 c) {
  return vec2(c.r / 255.0 + c.b, c.g / 255.0 + c.a);
}

vec4 encode_pos(vec2 pos) {
  return vec4(fract(pos * 255.0), floor(pos * 255.0) / 255.0);
}

void main() {
  vec2 history_size = vec2(u_particle_res * u_k_history, u_particle_res);
  vec2 dst_pixel = gl_FragCoord.xy;
  float slot = floor(dst_pixel.x / u_particle_res);

  if (slot < 0.5) {
    // Slot 0 (newest) : advecte depuis slot 0 de history_in
    vec2 src_uv = dst_pixel / history_size;
    vec4 prev_color = texture(u_history_in, src_uv);
    vec2 pos = decode_pos(prev_color);

    vec2 velocity = mix(u_wind_min, u_wind_max, lookup_wind(pos));
    float speed_t = length(velocity) / length(u_wind_max);

    float lonSpan = u_bbox.z - u_bbox.x;
    float latSpan = u_bbox.w - u_bbox.y;
    float lat_deg = mix(u_bbox.w, u_bbox.y, pos.y);
    float distortion = max(cos(radians(lat_deg)), 0.1);

    float advect = 0.013 * u_speed_factor;
    vec2 offset = vec2(
      velocity.x * advect / (lonSpan * distortion),
      -velocity.y * advect / latSpan
    );
    pos = pos + offset;

    vec2 seed = (pos + dst_pixel) * u_rand_seed;
    float outOfBounds = step(pos.x, 0.0) + step(1.0, pos.x)
                      + step(pos.y, 0.0) + step(1.0, pos.y);
    float drop_rate = u_drop_rate + speed_t * u_drop_rate_bump;
    float drop = step(1.0 - drop_rate, rand(seed)) + outOfBounds;
    drop = clamp(drop, 0.0, 1.0);

    vec2 random_pos = vec2(rand(seed + 1.3), rand(seed + 2.1));
    pos = mix(pos, random_pos, drop);

    fragOut = encode_pos(pos);
  } else {
    // Slot k > 0 : shift à droite (copie slot k-1 de history_in)
    vec2 src_pixel = dst_pixel - vec2(u_particle_res, 0.0);
    vec2 src_uv = src_pixel / history_size;
    fragOut = texture(u_history_in, src_uv);
  }
}
`;

// ─── Quad vertex shader (fullscreen pass) ──────────────────────────────
// Standard fullscreen quad sans flip. v_tex_pos = a_pos directement.

const quadVert = `#version 300 es
precision mediump float;

in vec2 a_pos;
out vec2 v_tex_pos;

void main() {
  v_tex_pos = a_pos;
  gl_Position = vec4(2.0 * a_pos - 1.0, 0, 1);
}
`;

// ─── Draw vertex shader (triangle strip extrusion par segment) ──────────
// Pour chaque particule, on dessine K-1 segments connectés bout-à-bout.
// segment[k] relie history slot[k+1] (older) → history slot[k] (newer).
// segment[0] = head→head-1, segment[K-2] = tail-1→tail.
//
// Alpha gradient : v_alpha = 1 - (sub_idx + (1 - a_t)) / (K-1).
//   sub_idx=0, a_t=1 (head end) : v_alpha = 1.0
//   sub_idx=K-2, a_t=0 (tail end) : v_alpha = 0.0
//
// Match exactement le pattern canvas 2D OL : `ctx.globalAlpha = t * lifeFade`
// avec t = i / (trailLength - 1).

const drawVertTemplate = (prelude: string, define: string) => `#version 300 es
precision mediump float;

${prelude}
${define}

in float a_seg;
in float a_side;
in float a_t;

uniform sampler2D u_history;
uniform float u_particle_res;
uniform float u_k_history;
uniform vec4 u_bbox;
uniform vec2 u_canvas_size;
uniform float u_line_width;

out vec2 v_particle_pos;
out float v_side;
out float v_alpha;

vec2 decode_pos(vec4 c) {
  return vec2(c.r / 255.0 + c.b, c.g / 255.0 + c.a);
}

vec2 lonlat_to_mercator(vec2 lonlat) {
  float x = (lonlat.x + 180.0) / 360.0;
  float sinLat = sin(radians(lonlat.y));
  float y = 0.5 - 0.25 * log((1.0 + sinLat) / (1.0 - sinLat)) / 3.141592653589793;
  return vec2(x, y);
}

void main() {
  float segments_per_particle = max(u_k_history - 1.0, 1.0);
  float particle_idx = floor(a_seg / segments_per_particle);
  float sub_idx = mod(a_seg, segments_per_particle);

  // Position du segment dans la texture history.
  // sub_idx ∈ [0, K-2]. Newer end (b) = slot sub_idx. Older end (a) = slot sub_idx+1.
  float local_x = mod(particle_idx, u_particle_res);
  float local_y = floor(particle_idx / u_particle_res);
  vec2 history_size = vec2(u_particle_res * u_k_history, u_particle_res);

  float slot_b = sub_idx;          // newer (smaller slot = head)
  float slot_a = sub_idx + 1.0;    // older

  vec2 uv_a = vec2(slot_a * u_particle_res + local_x + 0.5, local_y + 0.5) / history_size;
  vec2 uv_b = vec2(slot_b * u_particle_res + local_x + 0.5, local_y + 0.5) / history_size;

  vec2 pos_a = decode_pos(texture(u_history, uv_a));
  vec2 pos_b = decode_pos(texture(u_history, uv_b));

  // Wrap detection : si distance entre 2 slots historiques trop grande
  // → particule a respawn → collapse segment.
  // Threshold 0.005 = dist 0.07 normalized = ~7% du bbox. Advection normale
  // par frame ≈ 0.0007 (5e-7 squared) ≪ 0.005 → jamais collapse une advection
  // valide. Respawns rate ~98.5% (manque les ~1.5% où respawn à <7% bbox de
  // l'ancienne position). Précédent 0.05 = 22% trop permissif → encore des
  // "tirs de laser" flagués par Sylvain.
  vec2 delta = pos_b - pos_a;
  if (dot(delta, delta) > 0.005) {
    pos_a = pos_b;
  }

  v_particle_pos = mix(pos_a, pos_b, a_t);

  float lon_a = mix(u_bbox.x, u_bbox.z, pos_a.x);
  float lat_a = mix(u_bbox.w, u_bbox.y, pos_a.y);
  float lon_b = mix(u_bbox.x, u_bbox.z, pos_b.x);
  float lat_b = mix(u_bbox.w, u_bbox.y, pos_b.y);

  vec4 clip_a = projectTile(lonlat_to_mercator(vec2(lon_a, lat_a)));
  vec4 clip_b = projectTile(lonlat_to_mercator(vec2(lon_b, lat_b)));

  vec2 ndc_a = clip_a.xy / clip_a.w;
  vec2 ndc_b = clip_b.xy / clip_b.w;
  vec2 px_a = (ndc_a * 0.5 + 0.5) * u_canvas_size;
  vec2 px_b = (ndc_b * 0.5 + 0.5) * u_canvas_size;

  vec2 seg_dir = normalize(px_b - px_a + vec2(1e-6, 0.0));
  vec2 seg_normal = vec2(-seg_dir.y, seg_dir.x);

  vec4 clip_pos = mix(clip_a, clip_b, a_t);
  vec2 offset_px = seg_normal * a_side * (u_line_width * 0.5);
  vec2 offset_clip = (offset_px / u_canvas_size) * 2.0 * clip_pos.w;

  gl_Position = clip_pos + vec4(offset_clip, 0.0, 0.0);

  v_side = a_side;
  // Alpha gradient : tail (slot K-2 → K-1) = 0, head (slot 0 → 1) = 1.
  // Pour 1 segment donné de slot_b à slot_a, alpha augmente le long de a_t
  // (de slot_a vers slot_b = du vieux vers le neuf).
  v_alpha = 1.0 - (sub_idx + (1.0 - a_t)) / segments_per_particle;
}
`;

// ─── Draw fragment shader ─────────────────────────────────────────────
// Pas de FBO accumulator. Alpha calculé from scratch :
//   color (bucket Beaufort by speed) × v_alpha (gradient trail tail→head)
//                                    × line_aa (smoothstep latéral)
//                                    × edge_fade (bord bbox)
// Direct render sur canvas MapLibre (avec BLEND ON, SRC_ALPHA, ONE_MINUS_SRC_ALPHA).

const drawFrag = `#version 300 es
precision mediump float;

uniform sampler2D u_wind;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;

in vec2 v_particle_pos;
in float v_side;
in float v_alpha;
out vec4 fragColor;

void main() {
  vec2 velocity = mix(u_wind_min, u_wind_max, texture(u_wind, v_particle_pos).rg);
  float speed = length(velocity);

  vec4 color;
  if (speed <= 3.0)        color = vec4(186.0/255.0, 230.0/255.0, 253.0/255.0, 1.00);
  else if (speed <= 6.0)   color = vec4( 56.0/255.0, 189.0/255.0, 248.0/255.0, 1.00);
  else if (speed <= 10.0)  color = vec4( 34.0/255.0, 197.0/255.0,  94.0/255.0, 1.00);
  else if (speed <= 14.0)  color = vec4(253.0/255.0, 224.0/255.0,  71.0/255.0, 1.00);
  else if (speed <= 18.0)  color = vec4(251.0/255.0, 146.0/255.0,  60.0/255.0, 1.00);
  else                     color = vec4(220.0/255.0,  38.0/255.0,  38.0/255.0, 1.00);

  float edge_dist = min(min(v_particle_pos.x, 1.0 - v_particle_pos.x),
                        min(v_particle_pos.y, 1.0 - v_particle_pos.y));
  float edge_fade = smoothstep(0.0, 0.1, edge_dist);

  float line_aa = 1.0 - smoothstep(0.7, 1.0, abs(v_side));

  fragColor = vec4(color.rgb, color.a * edge_fade * v_alpha * line_aa);
}
`;

// ─── WebGL helpers (identiques wind-webgl.ts) ─────────────────────────

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compile error: ${gl.getShaderInfoLog(shader)}\n=== source ===\n${source}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): ProgramWrapper {
  const program = gl.createProgram()!;
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
  }
  const wrapper: ProgramWrapper = { program };
  const numAttr = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < numAttr; i++) {
    const a = gl.getActiveAttrib(program, i)!;
    wrapper[a.name] = gl.getAttribLocation(program, a.name);
  }
  const numUni = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < numUni; i++) {
    const u = gl.getActiveUniform(program, i)!;
    wrapper[u.name] = gl.getUniformLocation(program, u.name);
  }
  return wrapper;
}

function createTexture(gl: WebGL2RenderingContext, filter: number, data: Uint8Array, width: number, height: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function bindTexture(gl: WebGL2RenderingContext, texture: WebGLTexture | null, unit: number) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function createBuffer(gl: WebGL2RenderingContext, data: Float32Array): WebGLBuffer {
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

function bindAttribute(gl: WebGL2RenderingContext, buffer: WebGLBuffer, attribute: number, numComponents: number) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, numComponents, gl.FLOAT, false, 0, 0);
}

// ─── WindWebGLOptions ─────────────────────────────────────────────────

export interface WindWebGLOptions {
  bounds?: [number, number, number, number];
  speedFactor?: number;
  dropRate?: number;
  dropRateBump?: number;
  lineWidth?: number;
}

// ─── WindWebGLHistory class ───────────────────────────────────────────

export class WindWebGL {
  private gl: WebGL2RenderingContext;
  bounds: [number, number, number, number];
  speedFactor: number;
  dropRate: number;
  dropRateBump: number;
  lineWidth: number;
  /** Lecture seule pour compat avec ancien tuning (utilisé par main.js sandbox). */
  readonly kSteps = K_HISTORY;
  /** Lecture seule placeholder (compat API, plus utilisé en rev5). */
  readonly fadeOpacity = 0;

  private _numParticles = 0;
  private particleStateResolution = 0;
  private historyA?: WebGLTexture;
  private historyB?: WebGLTexture;
  private particleIndexBuffer?: WebGLBuffer;
  private _totalDrawIndices = 0;

  private updateProgram: ProgramWrapper;
  private quadBuffer: WebGLBuffer;
  private framebuffer: WebGLFramebuffer;
  private windTexture?: WebGLTexture;
  windData?: WindTextureData;
  private _drawProgramVariants = new Map<string, ProgramWrapper>();

  constructor(gl: WebGL2RenderingContext, opts: WindWebGLOptions = {}) {
    this.gl = gl;
    this.bounds = opts.bounds ?? [-15, 35, 30, 65];
    this.speedFactor = opts.speedFactor ?? 0.06;
    this.dropRate = opts.dropRate ?? 0.005;
    this.dropRateBump = opts.dropRateBump ?? 0.0;
    this.lineWidth = opts.lineWidth ?? 1.5;

    this.updateProgram = createProgram(gl, quadVert, updateFrag);
    this.quadBuffer = createBuffer(gl, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]));
    this.framebuffer = gl.createFramebuffer()!;
  }

  private _getDrawProgram(shaderData: MapLibreShaderData): ProgramWrapper {
    const cached = this._drawProgramVariants.get(shaderData.variantName);
    if (cached) return cached;
    const vert = drawVertTemplate(shaderData.vertexShaderPrelude, shaderData.define);
    const program = createProgram(this.gl, vert, drawFrag);
    const optionals = [
      'u_projection_matrix', 'u_projection_fallback_matrix',
      'u_projection_tile_mercator_coords', 'u_projection_clipping_plane',
      'u_projection_transition',
      'u_history', 'u_particle_res', 'u_k_history',
      'u_canvas_size', 'u_line_width',
    ];
    for (const name of optionals) {
      if (!(name in program)) {
        program[name] = this.gl.getUniformLocation(program.program, name) ?? undefined;
      }
    }
    this._drawProgramVariants.set(shaderData.variantName, program);
    return program;
  }

  /** No-op : pas de FBO à recréer, rendu direct canvas chaque frame. */
  resize() { /* no-op */ }

  setNumParticles(numParticles: number) {
    const gl = this.gl;
    const particleRes = this.particleStateResolution = Math.ceil(Math.sqrt(numParticles));
    this._numParticles = particleRes * particleRes;

    // History texture : (particleRes × K_HISTORY, particleRes).
    // Init : toutes les K slots de chaque particule = même position random.
    // Le trail démarrera compressé sur 1 point et se déploiera en K frames.
    const historyWidth = particleRes * K_HISTORY;
    const historyHeight = particleRes;
    const data = new Uint8Array(historyWidth * historyHeight * 4);
    for (let y = 0; y < particleRes; y++) {
      for (let x = 0; x < particleRes; x++) {
        const px = Math.random();
        const py = Math.random();
        const pxScaled = px * 255.0;
        const pyScaled = py * 255.0;
        const r = Math.round((pxScaled - Math.floor(pxScaled)) * 255);
        const g = Math.round((pyScaled - Math.floor(pyScaled)) * 255);
        const b = Math.floor(pxScaled);
        const a = Math.floor(pyScaled);
        for (let k = 0; k < K_HISTORY; k++) {
          const fullX = k * particleRes + x;
          const idx = (y * historyWidth + fullX) * 4;
          data[idx + 0] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = a;
        }
      }
    }
    if (this.historyA) gl.deleteTexture(this.historyA);
    if (this.historyB) gl.deleteTexture(this.historyB);
    this.historyA = createTexture(gl, gl.NEAREST, data, historyWidth, historyHeight);
    this.historyB = createTexture(gl, gl.NEAREST, data, historyWidth, historyHeight);

    // Draw attributes : N × (K-1) segments × 6 vertices × 3 floats.
    const segmentsPerParticle = K_HISTORY - 1;
    const totalSegments = this._numParticles * segmentsPerParticle;
    const verticesPerSegment = 6;
    const floatsPerVertex = 3;
    const attrs = new Float32Array(totalSegments * verticesPerSegment * floatsPerVertex);
    const corners: Array<[number, number]> = [
      [-1, 0], [-1, 1], [+1, 0],
      [+1, 0], [-1, 1], [+1, 1],
    ];
    let w = 0;
    for (let segIdx = 0; segIdx < totalSegments; segIdx++) {
      for (let v = 0; v < verticesPerSegment; v++) {
        const [side, t] = corners[v];
        attrs[w++] = segIdx;
        attrs[w++] = side;
        attrs[w++] = t;
      }
    }
    if (this.particleIndexBuffer) gl.deleteBuffer(this.particleIndexBuffer);
    this.particleIndexBuffer = createBuffer(gl, attrs);
    this._totalDrawIndices = totalSegments * verticesPerSegment;
  }

  get numParticles() { return this._numParticles; }

  setWind(windData: WindTextureData) {
    this.windData = windData;
    if (this.windTexture) this.gl.deleteTexture(this.windTexture);
    this.windTexture = createTexture(
      this.gl, this.gl.LINEAR,
      windData.image,
      windData.width, windData.height,
    );
  }

  /** No-op en rev5 : plus de screen FBO à clear. Chaque frame redessine. */
  clearTrails() { /* no-op */ }
  setMoving(_moving: boolean) { /* no-op */ }

  draw(args: MapLibreCustomLayerRenderArgs) {
    const gl = this.gl;
    if (!this.windData || this._numParticles === 0) return;

    const prevBlend = gl.getParameter(gl.BLEND);
    const prevDepth = gl.getParameter(gl.DEPTH_TEST);
    const prevStencil = gl.getParameter(gl.STENCIL_TEST);
    const prevViewport = gl.getParameter(gl.VIEWPORT);
    const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);

    // Update pass (shift + advect)
    bindTexture(gl, this.windTexture!, 0);
    bindTexture(gl, this.historyA!, 1);
    this._updateHistory();

    // Restore viewport pour draw on canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);

    // Draw pass : direct sur canvas avec BLEND
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this._drawParticles(args);
    if (!prevBlend) gl.disable(gl.BLEND);

    // Swap history A ↔ B
    const tmp = this.historyA;
    this.historyA = this.historyB;
    this.historyB = tmp;

    if (prevDepth) gl.enable(gl.DEPTH_TEST);
    if (prevStencil) gl.enable(gl.STENCIL_TEST);
    if (prevProgram) gl.useProgram(prevProgram);
  }

  private _updateHistory() {
    const gl = this.gl;
    const historyWidth = this.particleStateResolution * K_HISTORY;
    const historyHeight = this.particleStateResolution;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.historyB!, 0);
    gl.viewport(0, 0, historyWidth, historyHeight);

    const program = this.updateProgram;
    gl.useProgram(program.program);

    bindAttribute(gl, this.quadBuffer, program['a_pos'] as number, 2);

    gl.uniform1i(program['u_history_in'] as WebGLUniformLocation, 1);
    gl.uniform1i(program['u_wind'] as WebGLUniformLocation, 0);
    gl.uniform1f(program['u_rand_seed'] as WebGLUniformLocation, Math.random());
    gl.uniform2f(program['u_wind_res'] as WebGLUniformLocation, this.windData!.width, this.windData!.height);
    gl.uniform2f(program['u_wind_min'] as WebGLUniformLocation, this.windData!.uMin, this.windData!.vMin);
    gl.uniform2f(program['u_wind_max'] as WebGLUniformLocation, this.windData!.uMax, this.windData!.vMax);
    gl.uniform4f(program['u_bbox'] as WebGLUniformLocation, this.bounds[0], this.bounds[1], this.bounds[2], this.bounds[3]);
    gl.uniform1f(program['u_speed_factor'] as WebGLUniformLocation, this.speedFactor);
    gl.uniform1f(program['u_drop_rate'] as WebGLUniformLocation, this.dropRate);
    gl.uniform1f(program['u_drop_rate_bump'] as WebGLUniformLocation, this.dropRateBump);
    gl.uniform1f(program['u_particle_res'] as WebGLUniformLocation, this.particleStateResolution);
    gl.uniform1f(program['u_k_history'] as WebGLUniformLocation, K_HISTORY);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private _drawParticles(args: MapLibreCustomLayerRenderArgs) {
    const gl = this.gl;
    const program = this._getDrawProgram(args.shaderData);
    gl.useProgram(program.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleIndexBuffer!);
    const stride = 12;
    const aSeg = program['a_seg'] as number;
    const aSide = program['a_side'] as number;
    const aT = program['a_t'] as number;
    gl.enableVertexAttribArray(aSeg);
    gl.vertexAttribPointer(aSeg, 1, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aSide);
    gl.vertexAttribPointer(aSide, 1, gl.FLOAT, false, stride, 4);
    gl.enableVertexAttribArray(aT);
    gl.vertexAttribPointer(aT, 1, gl.FLOAT, false, stride, 8);

    // history A est devenue le "newly updated" car on a écrit dans B puis swap.
    // Donc le draw doit lire historyA (qui est l'ancienne B = newly written).
    // Mais on swap APRES le drawCall dans draw(). Donc au moment du draw, historyA
    // est encore l'ancienne (lue par update). Donc on doit lire historyB (qui vient
    // d'être écrite par update).
    bindTexture(gl, this.historyB!, 2);

    gl.uniform1i(program['u_wind'] as WebGLUniformLocation, 0);
    if (program['u_history']) gl.uniform1i(program['u_history'] as WebGLUniformLocation, 2);
    if (program['u_particle_res']) gl.uniform1f(program['u_particle_res'] as WebGLUniformLocation, this.particleStateResolution);
    if (program['u_k_history']) gl.uniform1f(program['u_k_history'] as WebGLUniformLocation, K_HISTORY);

    gl.uniform2f(program['u_wind_min'] as WebGLUniformLocation, this.windData!.uMin, this.windData!.vMin);
    gl.uniform2f(program['u_wind_max'] as WebGLUniformLocation, this.windData!.uMax, this.windData!.vMax);
    gl.uniform4f(program['u_bbox'] as WebGLUniformLocation, this.bounds[0], this.bounds[1], this.bounds[2], this.bounds[3]);

    if (program['u_canvas_size']) {
      gl.uniform2f(program['u_canvas_size'] as WebGLUniformLocation, gl.canvas.width, gl.canvas.height);
    }
    if (program['u_line_width']) {
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio ?? 1) : 1;
      gl.uniform1f(program['u_line_width'] as WebGLUniformLocation, this.lineWidth * dpr);
    }

    const pd = args.defaultProjectionData;
    if (program['u_projection_matrix']) gl.uniformMatrix4fv(program['u_projection_matrix'] as WebGLUniformLocation, false, pd.mainMatrix);
    if (program['u_projection_fallback_matrix']) gl.uniformMatrix4fv(program['u_projection_fallback_matrix'] as WebGLUniformLocation, false, pd.fallbackMatrix);
    if (program['u_projection_tile_mercator_coords']) gl.uniform4f(program['u_projection_tile_mercator_coords'] as WebGLUniformLocation, ...pd.tileMercatorCoords);
    if (program['u_projection_clipping_plane']) gl.uniform4f(program['u_projection_clipping_plane'] as WebGLUniformLocation, ...pd.clippingPlane);
    if (program['u_projection_transition']) gl.uniform1f(program['u_projection_transition'] as WebGLUniformLocation, pd.projectionTransition);

    gl.drawArrays(gl.TRIANGLES, 0, this._totalDrawIndices);
  }
}

// ─── Helpers buildWindTexture + speedDirToUv (réexportés depuis wind-webgl.ts) ──

export { buildWindTexture, speedDirToUv } from './wind-webgl';
export type { WindGridPoint } from './wind-webgl';
