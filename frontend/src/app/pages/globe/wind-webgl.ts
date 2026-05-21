/**
 * WindWebGL — port TypeScript de la sandbox maritime-globe-spike (2026-05-21).
 *
 * Origine : mapbox/webgl-wind (Vladimir Agafonkin, ISC). Adapté MapLibre 5.24
 * custom layer (globe + mercator + transition) avec :
 *   - GLSL ES 3.00 (WebGL2)
 *   - MRT : position texture + age texture en // par frame (gl.drawBuffers)
 *   - quad-vert flip-compensation (lecture u_particles à `1.0 - v_tex_pos`)
 *     — voir memo `webgl_quad_vert_flip_pitfall.md` pour le piège évité
 *   - K-step sub-point interpolation prev→curr (anti-pointillé vent fort)
 *   - Age fade-in 20 frames + 6 buckets Beaufort palette + edge fade
 *   - Trails wipe au pan/zoom/pitch/rotate via setMoving(true)
 *
 * Defaults retenus après tuning visuel Sylvain :
 *   fadeOpacity=0.99, speedFactor=0.1, dropRate=0.005, dropRateBump=0,
 *   kSteps=5, gl_PointSize=1.5
 *
 * Le bbox est un [minLon, minLat, maxLon, maxLat] sur lequel les particules
 * sont confinées et au-delà duquel elles respawn aléatoirement.
 */

export interface WindBbox {
  /** [minLon, minLat, maxLon, maxLat] */
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

const drawVertTemplate = (prelude: string, define: string) => `#version 300 es
precision mediump float;

${prelude}
${define}

in float a_index;

uniform sampler2D u_particles;
uniform sampler2D u_particles_prev;
uniform sampler2D u_particles_age;
uniform float u_particles_res;
uniform vec4 u_bbox;
uniform float u_k_steps;

out vec2 v_particle_pos;
out float v_age_fade;

vec2 decode_pos(vec4 color) {
  return vec2(color.r / 255.0 + color.b, color.g / 255.0 + color.a);
}

vec2 lonlat_to_mercator(vec2 lonlat) {
  float x = (lonlat.x + 180.0) / 360.0;
  float sinLat = sin(radians(lonlat.y));
  float y = 0.5 - 0.25 * log((1.0 + sinLat) / (1.0 - sinLat)) / 3.141592653589793;
  return vec2(x, y);
}

void main() {
  float particle_idx = floor(a_index / u_k_steps);
  float t = mod(a_index, u_k_steps) / max(u_k_steps - 1.0, 1.0);

  vec2 uv = vec2(
    fract(particle_idx / u_particles_res),
    floor(particle_idx / u_particles_res) / u_particles_res);

  vec2 curr_pos = decode_pos(texture(u_particles, uv));
  vec2 prev_pos = decode_pos(texture(u_particles_prev, uv));

  vec2 delta = curr_pos - prev_pos;
  float dist2 = dot(delta, delta);
  if (dist2 > 0.25) {
    v_particle_pos = curr_pos;
  } else {
    v_particle_pos = mix(prev_pos, curr_pos, t);
  }

  float lon = mix(u_bbox.x, u_bbox.z, v_particle_pos.x);
  float lat = mix(u_bbox.w, u_bbox.y, v_particle_pos.y);

  vec2 mercator = lonlat_to_mercator(vec2(lon, lat));

  float age_frames = texture(u_particles_age, uv).r * 255.0;
  v_age_fade = clamp(age_frames / 20.0, 0.0, 1.0);

  gl_PointSize = 1.5;
  gl_Position = projectTile(mercator);
}
`;

const drawFrag = `#version 300 es
precision mediump float;

uniform sampler2D u_wind;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;

in vec2 v_particle_pos;
in float v_age_fade;
out vec4 fragColor;

void main() {
  vec2 velocity = mix(u_wind_min, u_wind_max, texture(u_wind, v_particle_pos).rg);
  float speed = length(velocity);

  vec4 color;
  if (speed <= 3.0)        color = vec4(186.0/255.0, 230.0/255.0, 253.0/255.0, 0.50);
  else if (speed <= 6.0)   color = vec4( 56.0/255.0, 189.0/255.0, 248.0/255.0, 0.55);
  else if (speed <= 10.0)  color = vec4( 34.0/255.0, 197.0/255.0,  94.0/255.0, 0.60);
  else if (speed <= 14.0)  color = vec4(253.0/255.0, 224.0/255.0,  71.0/255.0, 0.70);
  else if (speed <= 18.0)  color = vec4(251.0/255.0, 146.0/255.0,  60.0/255.0, 0.80);
  else                     color = vec4(220.0/255.0,  38.0/255.0,  38.0/255.0, 0.90);

  float edge_dist = min(min(v_particle_pos.x, 1.0 - v_particle_pos.x),
                        min(v_particle_pos.y, 1.0 - v_particle_pos.y));
  float edge_fade = smoothstep(0.0, 0.1, edge_dist);

  fragColor = vec4(color.rgb, color.a * edge_fade * v_age_fade);
}
`;

const quadVert = `#version 300 es
precision mediump float;

in vec2 a_pos;

out vec2 v_tex_pos;

void main() {
  v_tex_pos = a_pos;
  gl_Position = vec4(1.0 - 2.0 * a_pos, 0, 1);
}
`;

const screenFrag = `#version 300 es
precision mediump float;

uniform sampler2D u_screen;
uniform float u_opacity;

in vec2 v_tex_pos;
out vec4 fragColor;

void main() {
  vec4 color = texture(u_screen, 1.0 - v_tex_pos);
  fragColor = vec4(floor(255.0 * color * u_opacity) / 255.0);
}
`;

const updateFrag = `#version 300 es
precision highp float;

uniform sampler2D u_particles;
uniform sampler2D u_particles_age;
uniform sampler2D u_wind;
uniform vec2 u_wind_res;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform vec4 u_bbox;
uniform float u_rand_seed;
uniform float u_speed_factor;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;

in vec2 v_tex_pos;
layout(location = 0) out vec4 fragPos;
layout(location = 1) out vec4 fragAge;

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

void main() {
  vec4 color = texture(u_particles, 1.0 - v_tex_pos);
  vec2 pos = vec2(
    color.r / 255.0 + color.b,
    color.g / 255.0 + color.a);

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

  vec2 seed = (pos + v_tex_pos) * u_rand_seed;
  float outOfBounds = step(pos.x, 0.0) + step(1.0, pos.x)
                    + step(pos.y, 0.0) + step(1.0, pos.y);

  float drop_rate = u_drop_rate + speed_t * u_drop_rate_bump;
  float drop = step(1.0 - drop_rate, rand(seed)) + outOfBounds;
  drop = clamp(drop, 0.0, 1.0);

  vec2 random_pos = vec2(
    rand(seed + 1.3),
    rand(seed + 2.1));
  pos = mix(pos, random_pos, drop);

  fragPos = vec4(
    fract(pos * 255.0),
    floor(pos * 255.0) / 255.0);

  float prev_age = texture(u_particles_age, 1.0 - v_tex_pos).r * 255.0;
  float new_age = mix(prev_age + 1.0, 0.0, drop);
  fragAge = vec4(min(new_age, 255.0) / 255.0, 0.0, 0.0, 1.0);
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    throw new Error(`Shader compile error: ${log}\n=== source ===\n${source}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): ProgramWrapper {
  const program = gl.createProgram()!;
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
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

function bindFramebuffer(gl: WebGL2RenderingContext, framebuffer: WebGLFramebuffer, texture: WebGLTexture | null) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  if (texture) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  }
}

export interface WindWebGLOptions {
  bounds?: [number, number, number, number];
  fadeOpacity?: number;
  speedFactor?: number;
  dropRate?: number;
  dropRateBump?: number;
  kSteps?: number;
}

export class WindWebGL {
  private gl: WebGL2RenderingContext;
  bounds: [number, number, number, number];
  fadeOpacity: number;
  speedFactor: number;
  dropRate: number;
  dropRateBump: number;
  kSteps: number;

  private _numParticles = 0;
  private particleStateResolution = 0;
  private particleStateTexture0?: WebGLTexture;
  private particleStateTexture1?: WebGLTexture;
  private particleStateAge0?: WebGLTexture;
  private particleStateAge1?: WebGLTexture;
  private particleIndexBuffer?: WebGLBuffer;
  private _totalDrawIndices = 0;

  private screenProgram: ProgramWrapper;
  private updateProgram: ProgramWrapper;
  private quadBuffer: WebGLBuffer;
  private framebuffer: WebGLFramebuffer;
  private backgroundTexture?: WebGLTexture;
  private screenTexture?: WebGLTexture;
  private windTexture?: WebGLTexture;
  windData?: WindTextureData;
  private _drawProgramVariants = new Map<string, ProgramWrapper>();
  private _moving = false;

  constructor(gl: WebGL2RenderingContext, opts: WindWebGLOptions = {}) {
    this.gl = gl;
    this.bounds = opts.bounds ?? [-15, 35, 30, 65];
    this.fadeOpacity = opts.fadeOpacity ?? 0.99;
    this.speedFactor = opts.speedFactor ?? 0.1;
    this.dropRate = opts.dropRate ?? 0.005;
    this.dropRateBump = opts.dropRateBump ?? 0.0;
    this.kSteps = opts.kSteps ?? 5;

    this.screenProgram = createProgram(gl, quadVert, screenFrag);
    this.updateProgram = createProgram(gl, quadVert, updateFrag);
    this.quadBuffer = createBuffer(gl, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]));
    this.framebuffer = gl.createFramebuffer()!;

    this.resize();
  }

  private _getDrawProgram(shaderData: MapLibreShaderData): ProgramWrapper {
    const key = shaderData.variantName;
    const cached = this._drawProgramVariants.get(key);
    if (cached) return cached;
    const vertSource = drawVertTemplate(shaderData.vertexShaderPrelude, shaderData.define);
    const program = createProgram(this.gl, vertSource, drawFrag);
    program['u_projection_matrix'] = this.gl.getUniformLocation(program.program, 'u_projection_matrix') ?? undefined;
    program['u_projection_fallback_matrix'] = this.gl.getUniformLocation(program.program, 'u_projection_fallback_matrix') ?? undefined;
    program['u_projection_tile_mercator_coords'] = this.gl.getUniformLocation(program.program, 'u_projection_tile_mercator_coords') ?? undefined;
    program['u_projection_clipping_plane'] = this.gl.getUniformLocation(program.program, 'u_projection_clipping_plane') ?? undefined;
    program['u_projection_transition'] = this.gl.getUniformLocation(program.program, 'u_projection_transition') ?? undefined;
    program['u_particles_prev'] = this.gl.getUniformLocation(program.program, 'u_particles_prev') ?? undefined;
    program['u_particles_age'] = this.gl.getUniformLocation(program.program, 'u_particles_age') ?? undefined;
    program['u_k_steps'] = this.gl.getUniformLocation(program.program, 'u_k_steps') ?? undefined;
    this._drawProgramVariants.set(key, program);
    return program;
  }

  resize() {
    const gl = this.gl;
    if (this.backgroundTexture) gl.deleteTexture(this.backgroundTexture);
    if (this.screenTexture) gl.deleteTexture(this.screenTexture);
    const w = gl.canvas.width;
    const h = gl.canvas.height;
    const emptyPixels = new Uint8Array(w * h * 4);
    this.backgroundTexture = createTexture(gl, gl.NEAREST, emptyPixels, w, h);
    this.screenTexture = createTexture(gl, gl.NEAREST, emptyPixels, w, h);
  }

  setNumParticles(numParticles: number) {
    const gl = this.gl;
    const particleRes = this.particleStateResolution = Math.ceil(Math.sqrt(numParticles));
    this._numParticles = particleRes * particleRes;

    const particleState = new Uint8Array(this._numParticles * 4);
    for (let i = 0; i < this._numParticles; i++) {
      const px = Math.random();
      const py = Math.random();
      const pxScaled = px * 255.0;
      const pyScaled = py * 255.0;
      particleState[i * 4 + 0] = Math.round((pxScaled - Math.floor(pxScaled)) * 255);
      particleState[i * 4 + 1] = Math.round((pyScaled - Math.floor(pyScaled)) * 255);
      particleState[i * 4 + 2] = Math.floor(pxScaled);
      particleState[i * 4 + 3] = Math.floor(pyScaled);
    }
    if (this.particleStateTexture0) gl.deleteTexture(this.particleStateTexture0);
    if (this.particleStateTexture1) gl.deleteTexture(this.particleStateTexture1);
    this.particleStateTexture0 = createTexture(gl, gl.NEAREST, particleState, particleRes, particleRes);
    this.particleStateTexture1 = createTexture(gl, gl.NEAREST, particleState, particleRes, particleRes);

    const ageState = new Uint8Array(this._numParticles * 4);
    for (let i = 0; i < this._numParticles; i++) {
      ageState[i * 4 + 0] = Math.floor(Math.random() * 200);
    }
    if (this.particleStateAge0) gl.deleteTexture(this.particleStateAge0);
    if (this.particleStateAge1) gl.deleteTexture(this.particleStateAge1);
    this.particleStateAge0 = createTexture(gl, gl.NEAREST, ageState, particleRes, particleRes);
    this.particleStateAge1 = createTexture(gl, gl.NEAREST, ageState, particleRes, particleRes);

    const totalIndices = this._numParticles * this.kSteps;
    const particleIndices = new Float32Array(totalIndices);
    for (let i = 0; i < totalIndices; i++) particleIndices[i] = i;
    if (this.particleIndexBuffer) gl.deleteBuffer(this.particleIndexBuffer);
    this.particleIndexBuffer = createBuffer(gl, particleIndices);
    this._totalDrawIndices = totalIndices;
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

  clearTrails() {
    const gl = this.gl;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    for (const tex of [this.backgroundTexture, this.screenTexture]) {
      if (!tex) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setMoving(moving: boolean) {
    if (this._moving === moving) return;
    this._moving = moving;
    this.clearTrails();
  }

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

    bindTexture(gl, this.windTexture!, 0);
    bindTexture(gl, this.particleStateTexture0!, 1);

    this._drawScreen(args);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._updateParticles();

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    if (prevDepth) gl.enable(gl.DEPTH_TEST);
    if (prevStencil) gl.enable(gl.STENCIL_TEST);
    if (prevProgram) gl.useProgram(prevProgram);
  }

  private _drawScreen(args: MapLibreCustomLayerRenderArgs) {
    const gl = this.gl;
    bindFramebuffer(gl, this.framebuffer, this.screenTexture!);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    if (this._moving) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      this._drawTexture(this.backgroundTexture!, this.fadeOpacity);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this._drawParticles(args);
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this._drawTexture(this.screenTexture!, 1.0);
    gl.disable(gl.BLEND);

    const temp = this.backgroundTexture;
    this.backgroundTexture = this.screenTexture;
    this.screenTexture = temp;
  }

  private _drawTexture(texture: WebGLTexture, opacity: number) {
    const gl = this.gl;
    const program = this.screenProgram;
    gl.useProgram(program.program);
    bindAttribute(gl, this.quadBuffer, program['a_pos'] as number, 2);
    bindTexture(gl, texture, 2);
    gl.uniform1i(program['u_screen'] as WebGLUniformLocation, 2);
    gl.uniform1f(program['u_opacity'] as WebGLUniformLocation, opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private _drawParticles(args: MapLibreCustomLayerRenderArgs) {
    const gl = this.gl;
    const program = this._getDrawProgram(args.shaderData);
    gl.useProgram(program.program);

    bindAttribute(gl, this.particleIndexBuffer!, program['a_index'] as number, 1);
    bindTexture(gl, this.particleStateTexture1!, 3);
    bindTexture(gl, this.particleStateAge0!, 4);

    gl.uniform1i(program['u_wind'] as WebGLUniformLocation, 0);
    gl.uniform1i(program['u_particles'] as WebGLUniformLocation, 1);
    if (program['u_particles_prev']) gl.uniform1i(program['u_particles_prev'] as WebGLUniformLocation, 3);
    if (program['u_particles_age']) gl.uniform1i(program['u_particles_age'] as WebGLUniformLocation, 4);
    if (program['u_k_steps']) gl.uniform1f(program['u_k_steps'] as WebGLUniformLocation, this.kSteps);

    gl.uniform1f(program['u_particles_res'] as WebGLUniformLocation, this.particleStateResolution);
    gl.uniform2f(program['u_wind_min'] as WebGLUniformLocation, this.windData!.uMin, this.windData!.vMin);
    gl.uniform2f(program['u_wind_max'] as WebGLUniformLocation, this.windData!.uMax, this.windData!.vMax);
    gl.uniform4f(program['u_bbox'] as WebGLUniformLocation, this.bounds[0], this.bounds[1], this.bounds[2], this.bounds[3]);

    const pd = args.defaultProjectionData;
    if (program['u_projection_matrix']) gl.uniformMatrix4fv(program['u_projection_matrix'] as WebGLUniformLocation, false, pd.mainMatrix);
    if (program['u_projection_fallback_matrix']) gl.uniformMatrix4fv(program['u_projection_fallback_matrix'] as WebGLUniformLocation, false, pd.fallbackMatrix);
    if (program['u_projection_tile_mercator_coords']) gl.uniform4f(program['u_projection_tile_mercator_coords'] as WebGLUniformLocation, ...pd.tileMercatorCoords);
    if (program['u_projection_clipping_plane']) gl.uniform4f(program['u_projection_clipping_plane'] as WebGLUniformLocation, ...pd.clippingPlane);
    if (program['u_projection_transition']) gl.uniform1f(program['u_projection_transition'] as WebGLUniformLocation, pd.projectionTransition);

    gl.drawArrays(gl.POINTS, 0, this._totalDrawIndices);
  }

  private _updateParticles() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.particleStateTexture1!, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.particleStateAge1!, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.particleStateResolution, this.particleStateResolution);

    bindTexture(gl, this.particleStateAge0!, 5);

    const program = this.updateProgram;
    gl.useProgram(program.program);

    bindAttribute(gl, this.quadBuffer, program['a_pos'] as number, 2);

    gl.uniform1i(program['u_wind'] as WebGLUniformLocation, 0);
    gl.uniform1i(program['u_particles'] as WebGLUniformLocation, 1);
    if (program['u_particles_age']) gl.uniform1i(program['u_particles_age'] as WebGLUniformLocation, 5);

    gl.uniform1f(program['u_rand_seed'] as WebGLUniformLocation, Math.random());
    gl.uniform2f(program['u_wind_res'] as WebGLUniformLocation, this.windData!.width, this.windData!.height);
    gl.uniform2f(program['u_wind_min'] as WebGLUniformLocation, this.windData!.uMin, this.windData!.vMin);
    gl.uniform2f(program['u_wind_max'] as WebGLUniformLocation, this.windData!.uMax, this.windData!.vMax);
    gl.uniform4f(program['u_bbox'] as WebGLUniformLocation, this.bounds[0], this.bounds[1], this.bounds[2], this.bounds[3]);
    gl.uniform1f(program['u_speed_factor'] as WebGLUniformLocation, this.speedFactor);
    gl.uniform1f(program['u_drop_rate'] as WebGLUniformLocation, this.dropRate);
    gl.uniform1f(program['u_drop_rate_bump'] as WebGLUniformLocation, this.dropRateBump);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    const temp = this.particleStateTexture0;
    this.particleStateTexture0 = this.particleStateTexture1;
    this.particleStateTexture1 = temp;
    const tempAge = this.particleStateAge0;
    this.particleStateAge0 = this.particleStateAge1;
    this.particleStateAge1 = tempAge;
  }
}

export interface WindGridPoint { lon: number; lat: number; u: number; v: number; }

export function buildWindTexture(
  gridPts: WindGridPoint[],
  bbox: [number, number, number, number],
  width = 512,
  height = 256,
): WindTextureData {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of gridPts) {
    if (p.u < uMin) uMin = p.u;
    if (p.u > uMax) uMax = p.u;
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  const absMax = Math.max(Math.abs(uMin), Math.abs(uMax), Math.abs(vMin), Math.abs(vMax));
  uMin = -absMax; uMax = absMax;
  vMin = -absMax; vMax = absMax;

  const cellSize = 1.0;
  const cellHash = new Map<string, WindGridPoint[]>();
  for (const p of gridPts) {
    const key = `${Math.floor(p.lon / cellSize)},${Math.floor(p.lat / cellSize)}`;
    let bucket = cellHash.get(key);
    if (!bucket) { bucket = []; cellHash.set(key, bucket); }
    bucket.push(p);
  }

  function interpolate(lon: number, lat: number): { u: number; v: number } {
    const cellLon = Math.floor(lon / cellSize);
    const cellLat = Math.floor(lat / cellSize);
    const top: Array<{ p: WindGridPoint; d2: number }> = [];
    for (let radius = 1; radius <= 4 && top.length === 0; radius++) {
      for (let dlon = -radius; dlon <= radius; dlon++) {
        for (let dlat = -radius; dlat <= radius; dlat++) {
          if (Math.abs(dlon) !== radius && Math.abs(dlat) !== radius && radius > 1) continue;
          const bucket = cellHash.get(`${cellLon + dlon},${cellLat + dlat}`);
          if (!bucket) continue;
          for (const p of bucket) {
            const d2 = (p.lon - lon) ** 2 + (p.lat - lat) ** 2;
            if (top.length < 4) {
              top.push({ p, d2 });
              top.sort((a, b) => a.d2 - b.d2);
            } else if (d2 < top[3].d2) {
              top[3] = { p, d2 };
              top.sort((a, b) => a.d2 - b.d2);
            }
          }
        }
      }
    }
    if (top.length === 0) return { u: 0, v: 0 };
    let totalW = 0, u = 0, v = 0;
    for (const { p, d2 } of top) {
      const w = 1 / (d2 + 1e-6);
      totalW += w;
      u += p.u * w;
      v += p.v * w;
    }
    return { u: u / totalW, v: v / totalW };
  }

  const data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const lat = maxLat - (j / (height - 1)) * (maxLat - minLat);
    for (let i = 0; i < width; i++) {
      const lon = minLon + (i / (width - 1)) * (maxLon - minLon);
      const { u, v } = interpolate(lon, lat);
      const idx = (j * width + i) * 4;
      data[idx + 0] = Math.round(((u - uMin) / (uMax - uMin)) * 255);
      data[idx + 1] = Math.round(((v - vMin) / (vMax - vMin)) * 255);
      data[idx + 2] = 0;
      data[idx + 3] = 255;
    }
  }

  return { image: data, width, height, uMin, uMax, vMin, vMax };
}

export function speedDirToUv(speed: number, dirToDeg: number): { u: number; v: number } {
  const rad = (dirToDeg * Math.PI) / 180;
  return { u: speed * Math.sin(rad), v: speed * Math.cos(rad) };
}
