// Koi rendering: each fish is a strip along its spine (body, tail, dorsal fin) plus paired fins.
//
// Contract with index.html:
//   createKoi(gl, quad, hdrChunk) -> { shadow(pond, ctx), draw(pond, ctx) }
//   shadow: the caller has bound the sun-visibility mask with blendFunc(ZERO, ONE_MINUS_SRC_ALPHA);
//           output vec4(0, 0, 0, a) darkens it. Offset each shadow by SUN_DRIFT * (bed - fish depth) * ppm.
//   draw:   the caller has bound the scene (location 0: radiance, enc()'d; location 1: r = depth / 1.6 m)
//           with premultiplied blending; write o = vec4(enc(c) * a, a), o_depth = vec4(depth / 1.6 * a, 0, 0, a).
//   ctx = { world: uniforms from WORLD, tex: { dapple, sunvis, floor } }. Never sample sunvis while drawing into it.

import { HEAD, NOISE, WORLD, LIGHT } from './common.js';
import * as U from './util.js';

// Appearance by variety: base, patch, spots, fins (rgb + dark fin roots), [patch thr, spot thr, metallic, tancho]
const LOOK = {
  kohaku: { c0: [.97, .95, .91], c1: [.92, .24, .06], c2: [0, 0, 0], fin: [.97, .96, .93, 0], p: [.5, 9, .1, 0] },
  sanke: { c0: [.97, .95, .91], c1: [.9, .2, .05], c2: [.04, .04, .06], fin: [.95, .95, .93, 0], p: [.5, .76, .1, 0] },
  showa: { c0: [.05, .05, .07], c1: [.92, .3, .07], c2: [.96, .94, .9], fin: [.93, .91, .87, 1], p: [.56, .72, .15, 0] },
  yamabuki: { c0: [1, .79, .26], c1: [0, 0, 0], c2: [0, 0, 0], fin: [1, .85, .45, 0], p: [9, 9, 1, 0] },
  tancho: { c0: [.97, .96, .93], c1: [.85, .1, .06], c2: [0, 0, 0], fin: [.97, .96, .94, 0], p: [9, 9, .15, 1] },
  orenji: { c0: [1, .5, .1], c1: [0, 0, 0], c2: [0, 0, 0], fin: [1, .62, .28, 0], p: [9, 9, .8, 0] },
  shiro: { c0: [.05, .05, .07], c1: [.96, .95, .92], c2: [0, 0, 0], fin: [.9, .9, .88, .8], p: [.53, 9, .1, 0] },
  chagoi: { c0: [.56, .4, .24], c1: [0, 0, 0], c2: [0, 0, 0], fin: [.6, .45, .3, 0], p: [9, 9, .35, 0] },
  shusui: { c0: [.55, .62, .7], c1: [.86, .42, .16], c2: [0, 0, 0], fin: [.8, .55, .4, 0], p: [.66, 9, .2, 0] },
  soragoi: { c0: [.55, .58, .6], c1: [0, 0, 0], c2: [0, 0, 0], fin: [.6, .62, .64, 0], p: [9, 9, .2, 0] },
  ochiba: { c0: [.6, .63, .66], c1: [.62, .42, .24], c2: [0, 0, 0], fin: [.66, .64, .6, 0], p: [.56, 9, .15, 0] },
  asagi: { c0: [.5, .58, .66], c1: [.85, .38, .14], c2: [0, 0, 0], fin: [.85, .5, .3, 0], p: [.7, 9, .15, 0] },
};
const MAX = 16;

const VS = `${HEAD}${WORLD}
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec2 a_info;   // part, fish index
layout(location = 3) in vec2 a_dir;    // the strip's direction (tailward)
uniform float u_shadow, u_depth[${MAX}];
out vec2 v_uv, v_p, v_dir;
flat out int v_k, v_part;
void main() {
  v_part = int(a_info.x + .5); v_k = int(a_info.y + .5);
  vec2 p = a_pos;
  if (u_shadow > .5) p += SUN_DRIFT * max(bedDepth(p) - u_depth[v_k], 0.) * u_ppm;
  v_uv = a_uv; v_p = p; v_dir = a_dir;
  gl_Position = vec4((p / u_res * 2. - 1.) * vec2(1, -1), 0., 1.);
}`;

const FS = hdrChunk => `${HEAD}${NOISE}${WORLD}${LIGHT}${hdrChunk}
uniform vec3 u_c0[${MAX}], u_c1[${MAX}], u_c2[${MAX}];
uniform vec4 u_fin[${MAX}], u_kp[${MAX}];
uniform float u_shadow, u_depth[${MAX}], u_seed[${MAX}];
in vec2 v_uv, v_p, v_dir;
flat in int v_k, v_part;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 o_depth;
float bodyW(float t) { return t < .3 ? sqrt(max(0., 1. - pow((.3 - t) / .3, 2.))) : 1. - .84 * pow((t - .3) / .7, 1.15); }
float fbm3(vec2 p) { return .5 * vnoise(p) + .3 * vnoise(p * 2.1 + 7.) + .2 * vnoise(p * 4.3 + 3.); }
void main() {
  int k = v_k;
  float t = v_uv.x, s = v_uv.y, dep = u_depth[k];
  float half_ = v_part == 0 ? bodyW(t) : v_part == 1 ? .1 + .8 * t : v_part == 2 ? .3 + .7 * t : .2 * sqrt(max(0., sin(3.1416 * t)));
  float d = abs(s) - half_;
  float extra = v_part == 1 ? t - (.74 + .26 * abs(s) / max(half_, .01)) : v_part == 2 ? length(vec2(t, s * .6)) - 1. : -1.;
  if (u_shadow > .5) {
    float soft = .2 + .9 * max(bedDepth(v_p) - dep, 0.);   // the further above the bed, the softer
    float a = v_part == 3 ? 0. : smoothstep(soft, -soft, d) * smoothstep(.15, -.15, extra) * (v_part == 0 ? .6 : .2);
    o = vec4(0, 0, 0, a);
    o_depth = vec4(0);
    return;
  }
  float blur = 1. + dep * 3.;
  float alpha = clamp(.5 - d / (fwidth(s) * blur + 1e-4), 0., 1.) * clamp(.5 - extra / (fwidth(t) * blur + 1e-4), 0., 1.);
  if (alpha <= 0.) discard;
  vec2 side = vec2(-v_dir.y, v_dir.x);
  vec4 kp = u_kp[k];
  vec3 col, N = vec3(0, 0, 1);
  float spec = 0.;
  if (v_part == 0) {
    float sn = clamp(s / max(half_, .05), -1., 1.);
    N = normalize(vec3(side * sn * .9, sqrt(1. - sn * sn)));
    vec2 pc = vec2(t * 3.2, s * .9) + u_seed[k] * 37.;
    col = mix(u_c0[k], u_c1[k], smoothstep(kp.x - .02, kp.x + .02, fbm3(pc)));
    col = mix(col, u_c2[k], smoothstep(kp.y - .03, kp.y + .03, vnoise(pc * 2.6 + 31.)));
    if (kp.w > .5) col = mix(u_c0[k], u_c1[k], smoothstep(.43, .4, length(vec2((t - .15) * 6.9, s))));
    col = mix(u_c0[k], col, smoothstep(.02, .07, t));
    spec = pow(max(dot(N, normalize(SUN + vec3(0, 0, 1))), 0.), 8. + 60. * kp.z) * (.04 + .5 * kp.z);
    float er = length(vec2((t - .1) * 6.9, abs(s) - .62));
    col = mix(col, vec3(.03), smoothstep(.12, .09, er));
  } else {
    float ray = .9 + .1 * cos(atan(s * .44, t + .1) * 34.);
    vec4 fc = u_fin[k];
    col = mix(fc.rgb, u_c0[k], fc.w * smoothstep(.5, .1, t)) * ray;
    alpha *= v_part == 3 ? .4 : .55 * mix(1., .4, smoothstep(.3, 1., t));
  }
  float sun = canopy(v_p, dep);
  vec3 E = SKY_E * (.55 + .45 * N.z) + SUN_E * max(dot(N, SUN), 0.) * sun * caustics(v_p, dep);
  vec3 rad = lin(col) * E + spec * sun * SUN_E * mix(vec3(1), lin(u_c0[k]), kp.z);
  o = vec4(enc(underwater(rad, dep, sun)) * alpha, alpha);
  o_depth = vec4(dep / 1.6 * alpha, 0, 0, alpha);
}`;

// ---------- geometry ----------
const NB = 20, NT = 6, ND = 6;
const FINS = [[.2, .21, .09, 1], [.56, .12, .05, .45]]; // position along body, length, half-width, swing
const spine = new Float32Array((NB + NT + 1) * 3), row = new Float32Array((NB + 1) * 10);
const kv = new Float32Array(MAX * 240 * 8);
let kn = 0;
const bodyW = t => t < .3 ? Math.sqrt(Math.max(0, 1 - ((.3 - t) / .3) ** 2)) : 1 - .84 * ((t - .3) / .7) ** 1.15;

function setRow(i, x, y, a, half, px, u) {
  const c = Math.cos(a), s = Math.sin(a), o = i * 10;
  row[o] = x - s * px; row[o + 1] = y + c * px; row[o + 2] = u; row[o + 3] = half;
  row[o + 4] = x + s * px; row[o + 5] = y - c * px; row[o + 6] = u; row[o + 7] = -half;
  row[o + 8] = c; row[o + 9] = s;
}
function put(o, d, part, k) {
  const v = kn++ * 8;
  kv[v] = row[o]; kv[v + 1] = row[o + 1]; kv[v + 2] = row[o + 2]; kv[v + 3] = row[o + 3];
  kv[v + 4] = part; kv[v + 5] = k; kv[v + 6] = row[d]; kv[v + 7] = row[d + 1];
}
function strip(rows, part, k) {
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 10, b = a + 10;
    put(a, a + 8, part, k); put(a + 4, a + 8, part, k); put(b, b + 8, part, k);
    put(a + 4, a + 8, part, k); put(b + 4, b + 8, part, k); put(b, b + 8, part, k);
  }
}

function build(pond) {
  kn = 0;
  const order = pond.koi.map((k, i) => [k, i]).sort((a, b) => b[0].depth - a[0].depth);
  for (const [k, ki] of order) {
    const z = 1 + .1 * (.4 - Math.min(k.depth, 1.2));   // nearer the surface reads a touch larger
    const L = k.len * z, W = L * .11 * k.girth;
    k.spine(NB, NT, spine, z);
    for (const [t, fl, fw, mob] of FINS) {
      const j = Math.round(t * NB) * 3, a = spine[j + 2];
      for (const side of [-1, 1]) {
        const off = bodyW(t) * W * .8 * side;
        const x = spine[j] - Math.sin(a) * off, y = spine[j + 1] + Math.cos(a) * off;
        const open = .35 + .9 * k.fins + (side < 0 ? k.finR : k.finL);
        const fa = a + side * mob * (open + .25 * Math.sin(k.fin + side * .8) * (.3 + .7 * k.fins));
        setRow(0, x, y, fa, 1, fw * L, 0);
        setRow(1, x + Math.cos(fa) * fl * L, y + Math.sin(fa) * fl * L, fa, 1, fw * L, 1);
        strip(2, 2, ki);
      }
    }
    for (let i = 0; i <= NT; i++) {
      const j = (NB + i) * 3, u = i / NT, half = .1 + .8 * u + .12;
      setRow(i, spine[j], spine[j + 1], spine[j + 2], half, half * W, u);
    }
    strip(NT + 1, 1, ki);
    for (let i = 0; i <= NB; i++) {
      const j = i * 3, t = i / NB, half = Math.max(bodyW(t), bodyW(Math.min(1, t + 1 / NB))) + .12;
      setRow(i, spine[j], spine[j + 1], spine[j + 2], half, half * W, t);
    }
    strip(NB + 1, 0, ki);
    for (let i = 0; i <= ND; i++) {
      const f = (.32 + .3 * i / ND) * NB, j = Math.floor(f) * 3, fr = f % 1;
      const a = spine[j + 2] + (spine[j + 5] - spine[j + 2]) * fr;
      setRow(i, spine[j] + (spine[j + 3] - spine[j]) * fr, spine[j + 1] + (spine[j + 4] - spine[j + 1]) * fr, a, .26, .26 * W, i / ND);
    }
    strip(ND + 1, 3, ki);
  }
}

export function createKoi(gl, quad, hdrChunk) {
  const prog = U.program(gl, VS, FS(hdrChunk)), geo = U.geometry(gl, [2, 2, 2, 2]);
  const per = (koi, key, n) => {
    const a = new Float32Array(MAX * n);
    koi.forEach((k, i) => a.set(LOOK[k.variety][key], i * n));
    return a;
  };
  const setup = (pond, ctx, shadow) => {
    build(pond);
    U.upload(gl, geo, kv, kn * 8);
    gl.useProgram(prog.p);
    const depth = new Float32Array(MAX), seed = new Float32Array(MAX);
    pond.koi.forEach((k, i) => { depth[i] = k.depth; seed[i] = k.seed; });
    U.uniforms(gl, prog, {
      ...ctx.world, u_shadow: shadow ? 1 : 0, u_depth: depth, u_seed: seed,
      u_c0: per(pond.koi, 'c0', 3), u_c1: per(pond.koi, 'c1', 3), u_c2: per(pond.koi, 'c2', 3),
      u_fin: per(pond.koi, 'fin', 4), u_kp: per(pond.koi, 'p', 4),
    });
    U.textures(gl, prog, { u_dapple: ctx.tex.dapple });
    gl.drawArrays(gl.TRIANGLES, 0, kn);
  };
  return { shadow: (pond, ctx) => setup(pond, ctx, true), draw: (pond, ctx) => setup(pond, ctx, false) };
}
