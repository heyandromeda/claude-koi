// GLSL shared by every pass: one sun, one body of water, one set of units.
// Positions are CSS px (y down), depths are metres below the surface, light is linear HDR.
// The world constants here are the contract between modules: change them here, not locally.

export const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

export const NOISE = `
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= .5; } return s; }
`;

// Scene and frame targets are half-float where the device can render to them; otherwise they keep sqrt(x/4) in 8 bits.
export const hdr = float => float
  ? 'vec3 enc(vec3 c) { return c; }\nvec3 dec(vec3 c) { return c; }\n'
  : 'vec3 enc(vec3 c) { return sqrt(max(c, 0.) * .25); }\nvec3 dec(vec3 c) { return c * c * 4.; }\n';

// Uniforms, constants and geometry: safe in vertex and fragment shaders.
export const WORLD = `
uniform float u_time;
uniform vec2 u_res;     // viewport, css px
uniform float u_ppm;    // css px per metre
uniform vec4 u_bank;    // waterline: top bank y, left bank x, wobble amplitude (px), wobble frequency (rad/px)
uniform float u_bankP;  // wobble phase
const vec3 SUN = normalize(vec3(-.4, -.53, .75));   // toward the sun: high in the top-left
const vec2 SUN_DRIFT = vec2(.345, .46);   // px a shadow travels per px of depth (sun refracted to ~30 deg)
const vec3 SUN_E = vec3(3.1, 2.95, 2.7);  // direct sun on a surface square to it
const vec3 SKY_E = vec3(.5, .62, .8);     // light from the open sky
const vec3 K_WATER = vec3(.75, .32, .58); // attenuation per metre: algae and leaf tannin take red and blue
const vec3 VEIL = vec3(.004, .016, .01);  // light the water column scatters back, per unit of daylight
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }   // colours are authored in sRGB
vec2 sv(vec2 p) { return vec2(p.x / u_res.x, 1. - p.y / u_res.y); }   // css px -> screen-sized texture uv
// px from the waterline into the water (negative on the bank). Keep in step with Pond.shore() in pond.js.
float shore(vec2 p) {
  float a = u_bank.z, f = u_bank.w, P = u_bankP;
  float top = u_bank.x + a * (.6 * sin(p.x * f + P) + .4 * sin(p.x * f * 2.3 + P * 1.7));
  float left = u_bank.y + a * (.6 * sin(p.y * f + P + 2.) + .4 * sin(p.y * f * 2.3 + P * 1.7 + 1.));
  return min(p.y - top, p.x - left);
}
// Depth of the bed in metres: a shallow shelf along the banks, then a steep drop to the basin.
// Keep in step with Pond.bedDepth() in pond.js (which leaves out rocks and fine variation).
float bedDepth(vec2 p) {
  float m = min(u_res.x, u_res.y), s = shore(p);
  return .24 + .08 * smoothstep(0., .13 * m, s) + 1.13 * smoothstep(.13 * m, .2 * m, s);
}
`;

// Lighting under and at the water: fragment shaders only.
export const LIGHT = `
uniform sampler2D u_dapple;   // r: share of the sun the maple lets through, on the water surface
uniform sampler2D u_sunvis;   // r: 1 minus the shadows of fish and floating things, as they fall on the bed
// Open sky over p: the bank and its stones hide part of it near the edge.
float skyOpen(vec2 p) { return .5 + .5 * smoothstep(0., .1 * min(u_res.x, u_res.y), shore(p)); }
// Sun through the canopy reaching d metres below p: leaf shadows shift with depth.
float canopy(vec2 p, float d) {
  vec2 q = p - SUN_DRIFT * d * u_ppm;
  q += 2.5 * vec2(sin(u_time * .41 + q.y * .006), cos(u_time * .33 + q.x * .005));   // the branches stir
  return texture(u_dapple, sv(q) * .8 + .1).r;
}
// Radiance from something d metres down, seen from above; sun = how sunlit that column of water is.
vec3 underwater(vec3 rad, float d, float sun) {
  vec3 T = exp(-K_WATER * d * 2.1);   // down to it and back up again, slightly slanted
  return rad * T + VEIL * (SKY_E + SUN_E * .5 * sun) * (1. - exp(-K_WATER * d * 1.5));
}
// Animated caustic net (after Dave Hoskins' tileable water caustic); about 0..1, cells ~30 px.
float causticNet(vec2 p, float t0) {
  float time = u_time * .5 + t0;
  vec2 q = p * .045 - 250., i = q;
  float c = 1.;
  for (int n = 0; n < 4; n++) {
    float t = time * (1. - 3.5 / float(n + 1));
    i = q + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1. / length(vec2(q.x / (sin(i.x + t) / .005), q.y / (cos(i.y + t) / .005)));
  }
  c = 1.17 - pow(c / 4., 1.4);
  return pow(abs(c), 8.);
}
// Sunlight focused by the surface onto something d metres down: averages 1, crisp only in the shallows.
float caustics(vec2 p, float d) {
  float c = min((causticNet(p, 23.) + causticNet(p * .77 + 91., 61.)) * 4.42, 4.);   // 4.42: the pair averages .113
  return max(mix(1., c, exp(-d / .8)), 0.);
}
`;

export const WATERFN = `
uniform sampler2D u_height;
uniform vec4 u_hmap;     // css px -> height texture uv
uniform vec2 u_htexel;
uniform float u_slope;   // height per grid cell -> surface slope
// Surface slope (dh/dx, dh/dy) and Laplacian, sampled s texels apart: s = 2 smooths out grid noise.
vec3 waterD(vec2 p, float s) {
  vec2 uv = p * u_hmap.xy + u_hmap.zw, e = u_htexel * s;
  float c = texture(u_height, uv).r;
  float l = texture(u_height, uv - vec2(e.x, 0)).r, r = texture(u_height, uv + vec2(e.x, 0)).r;
  float t = texture(u_height, uv - vec2(0, e.y)).r, b = texture(u_height, uv + vec2(0, e.y)).r;
  return vec3(r - l, b - t, 2. * (l + r + t + b - 4. * c) / s) / (2. * s) * u_slope;
}
`;

export const VS_FULL = `${HEAD}
uniform vec2 u_res;
out vec2 v_p;
void main() {
  vec2 c = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(c * 2. - 1., 0., 1.);
  v_p = vec2(c.x, 1. - c.y) * u_res;
}`;
