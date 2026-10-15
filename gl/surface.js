// Things at and above the water: the stone bank, stepping stones, lily pads, leaves, food, surface specks.
//
// Contract with index.html:
//   createSurface(gl, quad, hdrChunk) -> { shadow(pond, ctx), draw(pond, ctx) }
//   shadow: the caller has bound the sun-visibility mask (the bed's view of the sun) with
//           blendFunc(ZERO, ONE_MINUS_SRC_ALPHA). A thing at the surface over bed depth D casts its
//           shadow SUN_DRIFT * D * ppm px down-sun of itself.
//   draw:   the caller has bound the HDR frame (after the water pass) with premultiplied blending;
//           write vec4(enc(radiance) * a, a).
//   ctx = { world: uniforms from WORLD, tex: { dapple, sunvis, floor } }

import { HEAD, NOISE, WORLD, LIGHT, VS_FULL } from './common.js';
import { PAD, LEAF, FOOD, STONE } from '../pond.js';
import * as U from './util.js';

const VS = `${HEAD}${WORLD}
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_info;   // type, seed, surface slope under it
out vec2 v_uv, v_p;
flat out vec4 v_info;
void main() {
  v_uv = a_uv; v_p = a_pos; v_info = a_info;
  gl_Position = vec4((a_pos / u_res * 2. - 1.) * vec2(1, -1), 0., 1.);
}`;

const FS = hdrChunk => `${HEAD}${NOISE}${WORLD}${LIGHT}${hdrChunk}
uniform float u_shadow;
in vec2 v_uv, v_p;
flat in vec4 v_info;
out vec4 o;
vec3 lit(vec3 albedo, vec3 n, vec2 p) {
  return lin(albedo) * (SKY_E * (.5 + .5 * n.z) + SUN_E * max(dot(n, SUN), 0.) * canopy(p, 0.));
}
void main() {
  vec2 uv = v_uv;
  float r = length(uv), a = atan(uv.y, uv.x), aa = fwidth(r) + 1e-4;
  int type = int(v_info.x + .5);
  float seed = v_info.y, alpha;
  vec3 n = normalize(vec3(-v_info.zw * 4., 1.)), col;
  if (type == ${STONE}) {                       // stepping stone: flat top, rounded shoulders, wet at the waterline
    float edge = .9 + .05 * sin(a * 3. + seed * 10.) + .03 * sin(a * 7. + seed * 30.), e = r / edge;
    alpha = clamp((edge - r) / aa + .5, 0., 1.);
    if (u_shadow > .5) { o = vec4(0, 0, 0, smoothstep(1.1, .85, e) * .7); return; }
    float z = smoothstep(1., .55, e);
    n = normalize(vec3(uv / edge * (1. - z) * 1.5, .4 + z));
    col = vec3(.52, .5, .46) * (.75 + .35 * fbm(uv * 4. + seed * 20.)) * (.9 + .2 * vnoise(uv * 30.));
    col = mix(col, vec3(.27, .32, .16), smoothstep(.55, .7, fbm(uv * 3. + seed * 7.)) * .7);
    col *= mix(1., .55, smoothstep(.75, .97, e));   // wet where the water laps it
    o = vec4(enc(lit(col, n, v_p)) * alpha, alpha);
    return;
  }
  if (type == ${PAD}) {                         // lily pad, late in the year: yellowing and tattered
    float notch = r * (.06 - abs(a)) * step(.05, r);
    float shape = .93 + .03 * (vnoise(vec2(a * 3., seed * 9.)) - .5) - r;
    alpha = clamp(shape / aa + .5, 0., 1.) * clamp(.5 - notch / aa, 0., 1.);
    if (u_shadow > .5) { o = vec4(0, 0, 0, alpha * .75); return; }
    col = mix(vec3(.1, .2, .06), vec3(.34, .3, .1), smoothstep(.62, .95, seed + .25 * vnoise(uv * 2. + seed * 9.)));
    col *= .9 + .12 * smoothstep(.9, .2, r);
    float vein = abs(fract(a * 2.4 + .5) - .5) / 2.4 * r;
    col *= 1. + .06 * smoothstep(.015, .0, vein) * smoothstep(.15, .4, r);
    col = mix(col, vec3(.38, .24, .1), smoothstep(.7, .9, vnoise(uv * 5. + seed * 50.)) * .6);
    col = mix(col, vec3(.45, .2, .12), smoothstep(-.08, -.01, -shape) * .5);   // reddish curled rim
  } else if (type == ${LEAF}) {                 // momiji: seven pointed lobes
    float b = a + 1.5708;
    float lobe = pow(abs(cos(b * 3.5)), .55);
    float rr = (.32 + .66 * lobe) * (1. - .25 * smoothstep(.5, 1., abs(b) / 3.1416)) + .015 * sin(b * 60.);
    float stem = step(0., uv.y) * step(uv.y, .9) * smoothstep(.04, .015, abs(uv.x));
    alpha = max(clamp((rr - r) / aa + .5, 0., 1.), stem);
    if (u_shadow > .5) { o = vec4(0, 0, 0, alpha * .6); return; }
    col = mix(mix(vec3(.5, .1, .05), vec3(.68, .3, .08), seed), vec3(.4, .24, .11), step(.6, seed));
    col *= (.85 + .2 * smoothstep(.08, 0., abs(sin(b * 3.5)) * r)) * (.9 + .2 * vnoise(uv * 6. + seed * 9.));
  } else {                                      // food pellet
    alpha = clamp((.85 - r) / aa + .5, 0., 1.);
    if (u_shadow > .5) { o = vec4(0, 0, 0, alpha * .5); return; }
    col = mix(vec3(.5, .34, .18), vec3(.42, .3, .14), seed);
  }
  o = vec4(enc(lit(col, n, v_p)) * alpha, alpha);
}`;

// The bank: earth and moss beyond the waterline, big coping stones along it.
const FS_BANK = hdrChunk => `${HEAD}${NOISE}${WORLD}${LIGHT}${hdrChunk}
uniform float u_shadow;
in vec2 v_p; out vec4 o;
void main() {
  vec2 p = v_p;
  if (u_shadow > .5) {
    // the bank and its stones stand ~15 cm proud of the water: their shadow falls on the shelf down-sun
    float d = bedDepth(p) + .15;
    o = vec4(0, 0, 0, smoothstep(-2., -10., shore(p - SUN_DRIFT * d * u_ppm)) * .85);
    return;
  }
  float s = shore(p);
  if (s > 4.) discard;
  float m = min(u_res.x, u_res.y);
  // packed, irregular stones: warped Voronoi, F2 - F1 gives the cracks between them
  vec2 q = p / (m * .11) + .45 * vec2(vnoise(p / 37.), vnoise(p / 37. + 9.));
  vec2 n0 = floor(q), f = fract(q), cell = vec2(0);
  float d1 = 9., d2 = 9.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(i, j), r = g + vec2(hash(n0 + g), hash(n0 + g + 7.)) * .9 - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; cell = n0 + g; } else if (d < d2) d2 = d;
  }
  float gap = sqrt(d2) - sqrt(d1), id = hash(cell + 3.);
  float band = smoothstep(-m * .15, -m * .04, s);   // a row of coping stones along the water, sparser inland
  float stone = smoothstep(.1, .26, gap) * step(id, .25 + .75 * band) * step(s, 2.5);
  // height: rounded shoulders plus weathered facets; the normal comes from its screen derivatives
  float hgt = smoothstep(.05, .5, gap) * (.7 + .3 * id) + .25 * fbm(p / 9. + id * 9.);
  vec3 nrm = normalize(vec3(-dFdx(hgt) * 6., dFdy(hgt) * 6., 1.));
  vec3 rock = mix(vec3(.46, .44, .4), vec3(.36, .34, .3), id) * (.82 + .3 * fbm(p / 5. + id * 4.));
  rock = mix(rock, vec3(.72, .72, .64), smoothstep(.8, .86, vnoise(p / 1.8 + id * 30.)) * .5);   // lichen
  rock = mix(rock, vec3(.24, .31, .13), smoothstep(.55, .7, fbm(p / 11. + 3. + id)) * .75);      // moss
  vec3 earth = mix(vec3(.15, .13, .09), vec3(.2, .27, .11), smoothstep(.35, .65, fbm(p / 15.)));
  earth = mix(earth, vec3(.5, .12, .05), smoothstep(.86, .9, vnoise(p / 3.5)) * .8);             // fallen momiji
  vec3 col = mix(earth, rock, stone);
  col *= mix(1., .55, smoothstep(-5., 1.5, s));   // wet near the water
  vec3 rad = lin(col) * (SKY_E * (.6 + .4 * nrm.z) + SUN_E * max(dot(nrm, SUN), 0.) * canopy(p, 0.));
  float a = max(stone, step(s, 0.)) * smoothstep(4., 2.5, s);
  o = vec4(enc(rad) * a, a);
}`;

const sv = new Float32Array(400 * 6 * 8);
let sn = 0;
function quad(x, y, size, rot, uvs, type, seed, tx, ty) {
  if (sn >= 400) return;
  const c = Math.cos(rot) * size, s = Math.sin(rot) * size;
  let o = sn++ * 48;
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
    sv[o] = x + u * c - v * s; sv[o + 1] = y + u * s + v * c; sv[o + 2] = u * uvs; sv[o + 3] = v * uvs;
    sv[o + 4] = type; sv[o + 5] = seed; sv[o + 6] = tx; sv[o + 7] = ty;
    o += 8;
  }
}

// shadow: each thing's shadow lands down-sun by the depth of the bed beneath it
function build(pond, shadow) {
  sn = 0;
  const off = (x, y) => shadow ? pond.bedDepth(x, y) * pond.ppm : 0;
  const at = o => [o.x + .345 * off(o.x, o.y), o.y + .46 * off(o.x, o.y)];   // SUN_DRIFT
  for (const s of pond.stones) { const [x, y] = at(s); quad(x, y, s.r * 1.12, 0, 1.12, STONE, s.seed, 0, 0); }
  for (const p of pond.pads.slice().sort((a, b) => a.seed - b.seed)) { const [x, y] = at(p); quad(x, y, p.r * 1.05, p.rot, 1.05, PAD, p.seed, p.gx, p.gy); }
  for (const l of pond.leaves) { const [x, y] = at(l); quad(x, y, l.r, l.rot, 1, LEAF, l.seed, l.gx, l.gy); }
  for (const f of pond.food) { const [x, y] = at(f); quad(x, y, f.r, 0, 1, FOOD, f.seed, f.gx, f.gy); }
}

export function createSurface(gl, quadFull, hdrChunk) {
  const prog = U.program(gl, VS, FS(hdrChunk)), bank = U.program(gl, VS_FULL, FS_BANK(hdrChunk)), geo = U.geometry(gl, [2, 2, 4]);
  const run = (pond, ctx, shadow) => {
    gl.useProgram(bank.p);
    U.uniforms(gl, bank, { ...ctx.world, u_shadow: shadow ? 1 : 0 });
    U.textures(gl, bank, { u_dapple: ctx.tex.dapple });
    quadFull();
    build(pond, shadow);
    U.upload(gl, geo, sv, sn * 48);
    gl.useProgram(prog.p);
    U.uniforms(gl, prog, { ...ctx.world, u_shadow: shadow ? 1 : 0 });
    U.textures(gl, prog, { u_dapple: ctx.tex.dapple });
    gl.drawArrays(gl.TRIANGLES, 0, sn * 6);
  };
  return { shadow: (pond, ctx) => run(pond, ctx, true), draw: (pond, ctx) => run(pond, ctx, false) };
}
