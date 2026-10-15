// The pond as a world: banks, depth, rocks, things floating, the fish, and how the water moves them.
// No DOM or GL. Positions are CSS px (y down); depths are metres. The screen shows a corner of a
// garden pond: a stone bank along the top and left edges, open water running on past the right and bottom.
//
// What the renderer reads: w, h, ppm, cell, time, water, bankUniforms(), koi, stones, pads, leaves, food,
// specks. Each floater is { type, x, y, r, rot, seed, gx, gy (surface slope under it), age, ... }.

import { Water } from './sim.js';
import { Koi } from './fish.js';

const STEP = 1 / 120; // fixed water timestep (s)
const TAU = Math.PI * 2;

export const PAD = 0, FLOWER = 1, LEAF = 2, FOOD = 3, STONE = 4;
// Every variety the renderer knows how to draw.
export const VARIETIES = ['kohaku', 'tancho', 'sanke', 'showa', 'shiro', 'yamabuki', 'orenji', 'chagoi', 'shusui', 'soragoi', 'ochiba', 'asagi'];
// A garden pond's fish, not a catalogue: repeats, plain fish, a big bronze chagoi, a few youngsters.
const CAST = [
  ['chagoi', 1.35], ['kohaku', 1.2], ['sanke', 1.1], ['showa', 1.05], ['kohaku', 1], ['shusui', 0.95],
  ['tancho', 0.9], ['yamabuki', 0.9], ['shiro', 0.85], ['soragoi', 0.8], ['kohaku', 0.62], ['sanke', 0.55],
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Pond {
  constructor(w, h, seed = 7) {
    this.rand = rng(seed);
    this.time = 0; this.acc = 0; this.drip = 4;
    this.food = []; this.stones = []; this.pads = []; this.leaves = []; this.specks = []; this.koi = [];
    this.bankPhase = this.rand() * TAU;
    this.g = [0, 0];
    this.resize(w, h);
    this.populate();
  }

  resize(w, h) {
    const sx = this.w ? w / this.w : 1, sy = this.h ? h / this.h : 1;
    this.w = w; this.h = h;
    const m = Math.min(w, h);
    this.ppm = m / 2.2; // the short side of the screen spans 2.2 m of pond
    this.bank = { top: 0.07 * m, left: 0.07 * m, amp: 0.018 * m, freq: TAU / (0.6 * m) };
    this.cell = Math.max(2, m / 180);
    for (const o of [...this.koi, ...this.pads, ...this.leaves, ...this.food, ...this.stones, ...this.specks]) {
      o.x *= sx; o.y *= sy;
    }
    this.water = new Water(Math.ceil(w / this.cell), Math.ceil(h / this.cell));
    this.carve();
  }

  // The water ends at the bank and at rocks; past the right and bottom edges it runs on, so waves leave.
  carve() {
    const { water: wt, cell } = this;
    for (let y = 0; y < wt.h; y++) {
      for (let x = 0; x < wt.w; x++) if (this.shore((x + 0.5) * cell, (y + 0.5) * cell) < 1) wt.pin(x, y);
    }
    for (const s of this.stones) wt.block(s.x / cell, s.y / cell, (s.r * 0.85) / cell);
    wt.sponge(14);
  }

  bankUniforms() {
    const b = this.bank;
    return { u_bank: [b.top, b.left, b.amp, b.freq], u_bankP: this.bankPhase };
  }

  // px from the waterline into the water (negative on the bank). Keep in step with shore() in gl/common.js.
  shore(x, y) {
    const { top, left, amp: a, freq: f } = this.bank, P = this.bankPhase;
    const t = top + a * (0.6 * Math.sin(x * f + P) + 0.4 * Math.sin(x * f * 2.3 + P * 1.7));
    const l = left + a * (0.6 * Math.sin(y * f + P + 2) + 0.4 * Math.sin(y * f * 2.3 + P * 1.7 + 1));
    return Math.min(y - t, x - l);
  }

  // Bed depth in metres. Keep in step with bedDepth() in gl/common.js.
  bedDepth(x, y) {
    const m = Math.min(this.w, this.h), s = this.shore(x, y);
    const ss = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    return 0.24 + 0.08 * ss(0, 0.13 * m, s) + 1.13 * ss(0.13 * m, 0.2 * m, s);
  }

  populate() {
    const { w, h, rand, ppm } = this;
    // a short run of stepping stones out from the left bank
    const y0 = h * (0.5 + 0.2 * rand());
    this.stones = [0, 1, 2].map(i => ({
      x: this.bank.left + ppm * (0.2 + 0.42 * i), y: y0 + ppm * 0.14 * i * i, r: ppm * (0.2 - 0.025 * i), seed: rand(),
    }));
    this.carve();

    this.koi = CAST.map(([variety, size]) => {
      let x, y;
      do { x = w * (0.2 + 0.75 * rand()); y = h * (0.2 + 0.75 * rand()); } while (this.shore(x, y) < ppm * 0.4);
      return new Koi(variety, x, y, ppm * 0.5 * size * (0.93 + 0.14 * rand()), rand);
    });

    // one colony of lily pads rooted on the shelf under the top bank, overlapping, old and young
    const cx = w * (0.45 + 0.3 * rand()), cy = this.bank.top + ppm * 0.3;
    this.pads = [];
    for (let i = 0; i < 11; i++) {
      const a = rand() * TAU, d = ppm * 0.35 * Math.sqrt(rand()), r = ppm * (0.05 + 0.08 * rand());
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.7;
      if (this.shore(x, y) > r * 0.6) this.pads.push({ ...this.floater(PAD, x, y, r), rot: Math.atan2(cy - y, cx - x) + Math.PI });
    }
    this.flowers = [];
    this.leaves = [];
    for (let i = 0; i < 26; i++) {
      let x, y;
      do { x = rand() * w; y = rand() * h; } while (this.shore(x, y) < 8);
      this.leaves.push(this.floater(LEAF, x, y, ppm * (0.03 + 0.015 * rand())));
    }
  }

  floater(type, x, y, r) {
    const { rand } = this;
    return { type, x, y, r, vx: 0, vy: 0, rot: rand() * TAU, vr: (rand() - 0.5) * 0.1, seed: rand(), gx: 0, gy: 0, age: 0 };
  }

  splash(x, y, amount, radiusPx, ring = false) {
    this.water.disturb(x / this.cell, y / this.cell, Math.max(1.2, radiusPx / this.cell), amount, ring);
  }

  touch(x, y) {
    this.splash(x, y, -0.7, 3, true);
    for (const k of this.koi) k.onTouch(x, y, this);
  }

  // Finger dragged from (x0,y0) to (x1,y1): a trail of pushes along the path.
  drag(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0), n = Math.min(60, Math.ceil(d / (this.cell * 1.5)));
    for (let i = 1; i <= n; i++) this.splash(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, -0.05, 4);
    if (n) for (const k of this.koi) k.onDrag(x0, y0, x1, y1, this);
  }

  // A resting finger keeps pressing the surface.
  hold(x, y, dt) {
    this.splash(x, y, -0.9 * dt, 4);
    for (const k of this.koi) k.onHold(x, y, dt, this);
  }

  feed() {
    const { w, h, rand } = this;
    let cx, cy;
    do { cx = w * (0.3 + 0.5 * rand()); cy = h * (0.3 + 0.5 * rand()); } while (this.shore(cx, cy) < this.ppm * 0.4);
    for (let i = 0; i < 32 && this.food.length < 120; i++) {
      // a handful thrown: a gaussian scatter
      const r = 16 * Math.sqrt(-2 * Math.log(rand() + 1e-9)), a = rand() * TAU;
      const f = this.floater(FOOD, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.6);
      this.food.push(f);
      this.splash(f.x, f.y, -0.1, 2, true);
    }
  }

  eat(food, koi) {
    this.food.splice(this.food.indexOf(food), 1);
    this.splash(food.x, food.y, -0.35, koi.len * 0.04, true);
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const { water, cell, rand } = this;

    for (this.acc += dt; this.acc >= STEP; this.acc -= STEP) water.step();

    for (const k of this.koi) {
      k.update(dt, this);
      // only a fish just under the surface marks it
      if (k.depth < 0.15) {
        const near = 1 - k.depth / 0.15;
        water.disturb(k.x / cell, k.y / cell, Math.max(1.5, (k.len * 0.08) / cell), -(k.speed / k.len) * 0.5 * near * near * dt);
      }
    }

    // the odd drip or insect touching down
    if ((this.drip -= dt) < 0) {
      this.drip = 5 + rand() * 7;
      let x, y;
      do { x = rand() * this.w; y = rand() * this.h; } while (this.shore(x, y) < 10);
      this.splash(x, y, -0.15, 2, true);
    }

    // a light breeze from the open water pushes floating things toward the bank
    const wind = this.time * 0.05;
    const wx = -1.2 + 0.6 * Math.cos(wind * 1.3), wy = -1.2 + 0.6 * Math.sin(wind);
    const all = [...this.pads, ...this.leaves, ...this.food];
    for (const f of all) {
      water.slope(f.x / cell, f.y / cell, this.g);
      f.gx = this.g[0]; f.gy = this.g[1];
      const pad = f.type === PAD, push = pad ? 260 : 700, drift = pad ? 0 : 3;
      f.vx += (-f.gx * push + wx * drift) * dt;
      f.vy += (-f.gy * push + wy * drift) * dt;
      // pads are rooted: a stem pulls each back toward where it grew
      if (pad) { f.ox ??= f.x; f.oy ??= f.y; f.vx += (f.ox - f.x) * 0.8 * dt; f.vy += (f.oy - f.y) * 0.8 * dt; }
      const sh = this.shore(f.x, f.y);
      if (sh < f.r) {
        const gx = this.shore(f.x + 2, f.y) - this.shore(f.x - 2, f.y), gy = this.shore(f.x, f.y + 2) - this.shore(f.x, f.y - 2);
        const g = Math.hypot(gx, gy) || 1;
        f.vx += (gx / g) * (f.r - sh) * 4 * dt; f.vy += (gy / g) * (f.r - sh) * 4 * dt;
      }
      f.vx -= Math.max(0, f.x - (this.w - f.r)) * 4 * dt; f.vy -= Math.max(0, f.y - (this.h - f.r)) * 4 * dt;
      const drag = Math.exp(-dt * 1.5);
      f.vx *= drag; f.vy *= drag;
      f.x = clamp(f.x + f.vx * dt, 0, this.w); f.y = clamp(f.y + f.vy * dt, 0, this.h);
      f.vr += (f.gx - f.gy) * 0.4 * dt;
      f.vr *= Math.exp(-dt * 0.6);
      f.rot += f.vr * dt;
      f.age += dt;
      for (const s of this.stones) { // rocks don't move: slide around them
        const dx = f.x - s.x, dy = f.y - s.y, d = Math.hypot(dx, dy) || 1, rr = f.r + s.r;
        if (d < rr) {
          f.x = s.x + (dx / d) * rr; f.y = s.y + (dy / d) * rr;
          const vn = (f.vx * dx + f.vy * dy) / d;
          if (vn < 0) { f.vx -= (vn * dx) / d; f.vy -= (vn * dy) / d; }
        }
      }
    }
    // floating things nudge each other apart (pads may overlap a little: they grow over each other)
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j], dx = b.x - a.x, dy = b.y - a.y;
        const r = (a.r + b.r) * (a.type === PAD && b.type === PAD ? 0.7 : 1), d2 = dx * dx + dy * dy;
        if (d2 < r * r && d2 > 1e-6) {
          const d = Math.sqrt(d2), p = ((r - d) / d) * 15 * dt;
          const wa = b.r / (a.r + b.r), wb = a.r / (a.r + b.r); // the smaller one moves more
          a.vx -= dx * p * wa; a.vy -= dy * p * wa;
          b.vx += dx * p * wb; b.vy += dy * p * wb;
        }
      }
    }
    this.food = this.food.filter(f => f.age < 90);
  }
}
