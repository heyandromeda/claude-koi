// Baked environment: the pond bed, what is overhead (for reflections), and the canopy's sun flecks.
//
// Outputs (the contract with the other passes):
//   floor  - screen-sized RGBA8: rgb = bed albedo (sRGB), a = depth below the surface / 1.6 m.
//   env    - 512x512 RGBA8: what you would see looking up. rgb = colour (sRGB), a = 1 for open sky,
//            0 for leaves and branches. Looked up at uv = .5 + .5 * R.xy / R.z for a reflected ray R.
//   dapple - screen-shaped RGBA8: r = share of direct sun reaching the water surface through the maple.
//            Looked up at uv = .1 + .8 * sv(p) (the margin lets the pattern sway and shift with depth).

import { HEAD, NOISE, WORLD, VS_FULL } from './common.js';
import * as U from './util.js';

const FS_BED = `${HEAD}${NOISE}${WORLD}
uniform vec3 u_rocks[4];   // rocks standing in the water (x, y, radius); their bases sit on the bed
in vec2 v_p; out vec4 o;
const vec3 LD = SUN;
// Rounded stones on a jittered grid, unioned over neighbouring cells so none gets clipped.
// x: coverage, y: lighting, z: id, w: contact shadow on whatever lies beneath
vec4 stones(vec2 p, float sc, float dens, float seed) {
  vec2 q = p / sc, n = floor(q);
  vec4 r = vec4(0, 1, 0, 1);
  float top = 0.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = n + vec2(i, j);
    if (hash(g + seed) > dens) continue;
    vec2 c = g + .5 + (vec2(hash(g + seed + 7.1), hash(g + seed + 3.7)) - .5) * .5, o2 = q - c;
    float rad = .24 + .2 * hash(g + seed + 1.3), a = hash(g + seed + 9.2) * 6.283;
    vec2 d = vec2(o2.x * cos(a) + o2.y * sin(a), (o2.y * cos(a) - o2.x * sin(a)) * (1.15 + .5 * hash(g + seed + 5.5)));
    float e = length(d) / rad, z = sqrt(max(0., 1. - e * e));
    r.w = min(r.w, mix(.7, 1., smoothstep(.85, 1.25, length(o2) / rad)));
    if (e < 1. && z > top) {
      top = z;
      r.xyz = vec3(smoothstep(1., .86, e) * .7, .85 + .2 * max(dot(normalize(vec3(o2 / rad, z * 1.4)), LD), 0.), hash(g + seed + 2.9));
    }
  }
  return r;
}
vec3 stoneColour(float id, vec2 p) {
  vec3 c = id < .3 ? vec3(.36, .36, .34) : id < .55 ? vec3(.45, .4, .32) : id < .8 ? vec3(.24, .23, .21) : vec3(.42, .32, .24);
  return mix(c, vec3(.3, .29, .2), .45) * (.85 + .3 * vnoise(p / 1.6));   // under a film of algae
}
void dome(vec2 d, inout float top, inout vec3 nrm) {
  float e = length(d), z = sqrt(max(0., 1. - e * e));
  if (e < 1. && z > top) { top = z; nrm = normalize(vec3(d, z * 1.1)); }
}
void main() {
  vec2 p = v_p;
  float depth = bedDepth(p), shelf = 1. - smoothstep(.34, .8, depth);
  // the basin: dark liner under biofilm and settled mulm
  vec3 basin = mix(vec3(.2, .2, .15), vec3(.28, .27, .19), fbm(p / 90.)) * (.88 + .24 * vnoise(p / 5.));
  basin = mix(basin, vec3(.12, .1, .07), smoothstep(.5, .75, fbm(p / 150. + 7.)) * .7);
  // the shelf: silt, gravel and pebbles, all greened over
  vec3 sh = mix(vec3(.36, .33, .24), vec3(.3, .3, .2), fbm(p / 40.)) * (.85 + .3 * vnoise(p / 2.2));
  vec4 s = stones(p, 6., .55, 1.);
  sh = mix(sh * s.w, stoneColour(s.z, p) * s.y, s.x);
  s = stones(p, 15., .5, 2.);
  sh = mix(sh * s.w, stoneColour(s.z, p) * s.y, s.x);
  vec3 col = mix(basin, sh, shelf);
  // rock bases
  float top = 0.;
  vec3 nrm = vec3(0, 0, 1);
  for (int i = 0; i < 4; i++) if (u_rocks[i].z > 0.) dome((p - u_rocks[i].xy) / (u_rocks[i].z * 1.12), top, nrm);
  vec3 rock = vec3(.26, .26, .2) * (.75 + .4 * fbm(p / 7.)) * (.45 + .7 * max(dot(nrm, LD), 0.));
  col = mix(col, rock, smoothstep(0., .1, top));
  o = vec4(col, clamp(depth - top * (depth - .05), .03, 1.6) / 1.6);
}`;

const FS_ENV = `${HEAD}${NOISE}
uniform vec2 u_res;
in vec2 v_p; out vec4 o;
void main() {
  vec2 uv = v_p / u_res;
  float r = length(uv - .5) * 2.;
  // maple boughs reach in from the top-left (the bank side); open sky elsewhere
  float reach = smoothstep(1.1, .2, length(uv - vec2(.05, .05)));
  float cover = smoothstep(.5, .58, fbm(uv * 7.) + .45 * vnoise(uv * 55.) - .55 + reach * .85);   // open sky except under the maple
  vec3 sky = mix(vec3(.93, .96, 1.), vec3(.62, .76, .92), clamp(r * .7, 0., 1.));
  vec3 maple = mix(vec3(.55, .1, .05), vec3(.85, .42, .1), vnoise(uv * 18.));
  vec3 leaf = mix(vec3(.12, .2, .09), maple, smoothstep(.4, .6, fbm(uv * 3. + 4.))) * (.5 + .6 * vnoise(uv * 90.));
  o = vec4(mix(sky, leaf, cover), 1. - cover);
}`;

const FS_DAPPLE = `${HEAD}${NOISE}
uniform vec2 u_res;     // the screen the pattern is laid over, css px
in vec2 v_p; out vec4 o;
void main() {
  vec2 p = (v_p / u_res - .1) / .8 * u_res;   // css px on the water (this texture has a 10% margin all round)
  // the maple overhangs the top-left: dense there, thinning out across the pond
  float reach = smoothstep(.95, .1, length(p / max(u_res.x, u_res.y) - vec2(.05, .02)));
  float leaves = fbm(p / 110.) + .35 * vnoise(p / 22.) - .2 + reach * .5;
  o = vec4(1. - .88 * smoothstep(.5, .62, leaves), 0, 0, 1);
}`;

export function createEnv(gl, quad) {
  const bed = U.program(gl, VS_FULL, FS_BED), sky = U.program(gl, VS_FULL, FS_ENV), dap = U.program(gl, VS_FULL, FS_DAPPLE);
  const out = { env: U.target(gl, 512, 512), floor: null, dapple: null };
  U.bindTarget(gl, out.env);
  gl.useProgram(sky.p);
  U.uniforms(gl, sky, { u_res: [512, 512] });
  quad();
  gl.bindTexture(gl.TEXTURE_2D, out.env.tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D); // the water blurs reflections where it is rough

  // Re-bake whatever depends on the screen: call after every resize. bw, bh: backing pixels.
  out.bake = (pond, bw, bh) => {
    U.release(gl, out.floor); U.release(gl, out.dapple);
    const world = { u_res: [pond.w, pond.h], u_ppm: pond.ppm, u_time: 0, ...pond.bankUniforms() };
    const rocks = pond.stones.flatMap(s => [s.x, s.y, s.r]).concat(Array(12).fill(0)).slice(0, 12);
    out.floor = U.target(gl, bw, bh);
    U.bindTarget(gl, out.floor);
    gl.useProgram(bed.p);
    U.uniforms(gl, bed, { ...world, u_rocks: rocks });
    quad();
    const s = 512 / Math.max(pond.w, pond.h), dw = Math.round(pond.w * s), dh = Math.round(pond.h * s);
    out.dapple = U.target(gl, dw, dh);
    U.bindTarget(gl, out.dapple);
    gl.useProgram(dap.p);
    U.uniforms(gl, dap, { u_res: [pond.w, pond.h] });
    quad();
  };
  return out;
}
