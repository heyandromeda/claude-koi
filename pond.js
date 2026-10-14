// Pond simulation with no DOM/GL dependencies: water heightfield, koi steering, floating things.
// All positions are CSS pixels, y down.

const STEP = 1 / 120;   // fixed water timestep (s)
const C2 = 0.34;        // wave speed² in cells²/step²; stable below 0.75 with the 9-point Laplacian
const DAMP = 0.9965;    // per-step velocity damping: ripples fade over a couple of seconds
const SETTLE = 0.9995;  // pulls the surface back to rest so it never drifts
const VISC = 0.07;      // viscosity: damps short (grid-scale) waves much faster than long ones
const TAU = Math.PI * 2;

export const PAD = 0, FLOWER = 1, LEAF = 2, FOOD = 3;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = a => a - TAU * Math.floor((a + Math.PI) / TAU); // to [-π, π)

export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Linear wave equation on a grid with a 1-cell border that mirrors the edges (reflecting walls).
export class Water {
  constructor(w, h) {
    this.w = w; this.h = h; this.s = w + 2;
    this.height = new Float32Array(this.s * (h + 2));
    this.vel = new Float32Array(this.s * (h + 2));
    this.next = new Float32Array(this.s * (h + 2));
  }

  // Smooth impulse centred on grid coords (gx, gy); radius in cells. Negative pushes the surface down.
  disturb(gx, gy, radius, amount) {
    const { w, h, s, vel } = this, reach = radius * 2.5, k = 1 / (radius * radius);
    const x0 = Math.max(0, Math.floor(gx - reach)), x1 = Math.min(w - 1, Math.ceil(gx + reach));
    const y0 = Math.max(0, Math.floor(gy - reach)), y1 = Math.min(h - 1, Math.ceil(gy + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - gx, dy = y + 0.5 - gy;
        vel[(y + 1) * s + x + 1] += amount * Math.exp(-(dx * dx + dy * dy) * k);
      }
    }
  }

  step() {
    const { w, h, s, height: H, vel: V, next: N } = this, b = (h + 1) * s;
    for (let x = 1; x <= w; x++) { H[x] = H[s + x]; H[b + x] = H[b - s + x]; }
    for (let y = 0; y <= h + 1; y++) { H[y * s] = H[y * s + 1]; H[y * s + w + 1] = H[y * s + w]; }
    for (let y = 1; y <= h; y++) {
      for (let i = y * s + 1, e = i + w; i < e; i++) {
        // isotropic 9-point Laplacian keeps rings round instead of squarish
        const lap = (4 * (H[i - 1] + H[i + 1] + H[i - s] + H[i + s])
          + H[i - s - 1] + H[i - s + 1] + H[i + s - 1] + H[i + s + 1] - 20 * H[i]) / 6;
        N[i] = (V[i] + C2 * lap + VISC * (V[i - 1] + V[i + 1] + V[i - s] + V[i + s] - 4 * V[i])) * DAMP;
      }
    }
    for (let y = 1; y <= h; y++) {
      for (let i = y * s + 1, e = i + w; i < e; i++) H[i] = (H[i] + N[i]) * SETTLE;
    }
    this.vel = N; this.next = V;
  }

  idx(gx, gy) {
    return (clamp(Math.floor(gy), 0, this.h - 1) + 1) * this.s + clamp(Math.floor(gx), 0, this.w - 1) + 1;
  }

  // Surface slope (height per cell) at grid coords.
  slope(gx, gy, out) {
    const i = this.idx(gx, gy), H = this.height;
    out[0] = (H[i + 1] - H[i - 1]) / 2;
    out[1] = (H[i + this.s] - H[i - this.s]) / 2;
    return out;
  }
}

export class Koi {
  constructor(variety, x, y, len, rand) {
    Object.assign(this, {
      variety, x, y, len, rand,
      dir: rand() * TAU, speed: len * 0.4, turn: 0, fear: 0, fleeX: 0, fleeY: 0,
      depth: 0.3 + rand() * 0.3, gulp: 0, gulped: false,
      phase: rand() * TAU, fin: rand() * TAU, t: rand() * 100,
      // incommensurate wander frequencies so no two fish (or two laps) look alike
      f1: 0.05 + rand() * 0.07, f2: 0.13 + rand() * 0.12, f3: 0.02 + rand() * 0.03,
      p1: rand() * TAU, p2: rand() * TAU, pace: 0.38 + rand() * 0.3,
    });
  }

  update(dt, pond) {
    this.t += dt;
    const { w, h } = pond, L = this.len;
    const fx = Math.cos(this.dir), fy = Math.sin(this.dir);
    let sx = fx, sy = fy;

    // walls: look ahead so turning starts early and smoothly
    const m = Math.min(L * 1.5, Math.min(w, h) * 0.3);
    const ax = this.x + fx * L * 0.7, ay = this.y + fy * L * 0.7;
    sx += 2.5 * (Math.max(0, m - ax) - Math.max(0, ax - (w - m))) / m;
    sy += 2.5 * (Math.max(0, m - ay) - Math.max(0, ay - (h - m))) / m;

    // keep some personal space from fish at a similar depth
    for (const o of pond.koi) {
      if (o === this) continue;
      const ox = this.x - o.x, oy = this.y - o.y, r = (L + o.len) * 0.45, d2 = ox * ox + oy * oy;
      if (d2 < r * r && d2 > 1e-6) {
        const d = Math.sqrt(d2), k = (1 - d / r) * 0.9 * (1 - Math.abs(this.depth - o.depth));
        sx += (ox / d) * k; sy += (oy / d) * k;
      }
    }

    // ripples washing over the head spook the fish a little
    const v = Math.abs(pond.water.vel[pond.water.idx(this.x / pond.cell, this.y / pond.cell)]);
    if (v > 0.05) this.fear = Math.max(this.fear, Math.min(0.45, (v - 0.05) * 3));

    if (this.fear > 0.05) { sx += this.fleeX * this.fear * 3; sy += this.fleeY * this.fear * 3; }

    // food: nearest pellet, unless too scared to care
    let food = null, best = Infinity;
    if (this.fear < 0.35) {
      for (const f of pond.food) {
        const d2 = (f.x - this.x) ** 2 + (f.y - this.y) ** 2;
        if (d2 < best) { best = d2; food = f; }
      }
    }
    let target = L * this.pace * (0.7 + 0.3 * Math.sin(this.t * this.f3 * TAU + this.p2));
    if (food) {
      const d = Math.sqrt(best);
      if (d < L * 0.2) { pond.eat(food, this); food = null; } else {
        sx += ((food.x - this.x) / d) * 2; sy += ((food.y - this.y) / d) * 2;
        target = Math.min(L * 1.1, d * 1.2 + L * 0.25);
      }
    }
    target += this.fear * L * 3.2;

    const wander = (Math.sin(this.t * this.f1 * TAU + this.p1) * 0.6 + Math.sin(this.t * this.f2 * TAU + this.p2) * 0.4) * 0.6;
    const maxTurn = 1.3 + this.fear * 3 + (food ? 1 : 0);
    const want = clamp(wrap(Math.atan2(sy, sx) - this.dir) * 2.2 + wander, -maxTurn, maxTurn);
    this.turn += (want - this.turn) * Math.min(1, dt * 2.5);
    this.dir = wrap(this.dir + this.turn * dt);

    const accel = target > this.speed ? (this.fear > 0.3 ? 6 : 1.2) : 0.8;
    this.speed += (target - this.speed) * Math.min(1, dt * accel);
    const sp = this.speed * (1 - Math.min(0.45, Math.abs(this.turn) * 0.18)); // slow into tight turns
    this.x = clamp(this.x + Math.cos(this.dir) * sp * dt, 2, w - 2);
    this.y = clamp(this.y + Math.sin(this.dir) * sp * dt, 2, h - 2);

    this.fear *= Math.exp(-dt * 1.3);
    this.phase += dt * (2.5 + (9 * sp) / L);          // tail beat quickens with speed
    this.fin += dt * (5 - 3 * Math.min(1, sp / L));    // fins paddle more when hovering

    // drift in depth; now and then rise to the surface for a gulp
    if (this.gulp > 0) this.gulp -= dt;
    else if (this.rand() < dt / 35) { this.gulp = 2.2; this.gulped = false; }
    const goal = this.gulp > 0 ? 0.03 : 0.38 + 0.2 * Math.sin(this.t * this.f3 * 4 + this.p1);
    this.depth += (goal - this.depth) * Math.min(1, dt * 0.8);
    if (this.gulp > 0 && !this.gulped && this.depth < 0.08) {
      this.gulped = true;
      pond.splash(this.x, this.y, -0.35, L * 0.06);
    }
  }

  // Spine from snout to tail tip as [x, y, angle] triples (angle points tailward).
  spine(nb, nt, out) {
    const L = this.len, body = 0.76;
    const curv = clamp(this.turn / Math.max(this.speed, L * 0.3), -2.5 / L, 2.5 / L);
    const swim = 0.45 + 0.55 * Math.min(1, this.speed / L);
    let x = this.x, y = this.y;
    for (let i = 0; i <= nb + nt; i++) {
      const s = i <= nb ? (i / nb) * body : body + ((i - nb) / nt) * (1 - body);
      const a = this.dir + Math.PI - curv * s * L + (0.03 + 0.42 * s * s) * swim * Math.sin(this.phase - s * 5.5);
      out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = a;
      const ds = (i < nb ? body / nb : (1 - body) / nt) * L;
      x += Math.cos(a) * ds; y += Math.sin(a) * ds;
    }
    return out;
  }
}

export class Pond {
  constructor(w, h, seed = 7) {
    this.rand = rng(seed);
    this.time = 0; this.acc = 0; this.drip = 2;
    this.food = []; this.g = [0, 0];
    this.resize(w, h);
    this.populate();
  }

  resize(w, h) {
    const sx = this.w ? w / this.w : 1, sy = this.h ? h / this.h : 1;
    this.w = w; this.h = h;
    this.cell = Math.max(2, Math.min(w, h) / 180);
    this.water = new Water(Math.ceil(w / this.cell), Math.ceil(h / this.cell));
    for (const o of [...(this.koi || []), ...(this.pads || []), ...(this.leaves || []), ...this.food]) {
      o.x = clamp(o.x * sx, 2, w - 2); o.y = clamp(o.y * sy, 2, h - 2);
    }
  }

  populate() {
    const { w, h, rand } = this, m = Math.min(w, h);
    const base = clamp(m * 0.22, 60, 190);
    this.koi = [];
    for (let i = 0; i < 7; i++) {
      this.koi.push(new Koi(i, w * (0.2 + 0.6 * rand()), h * (0.2 + 0.6 * rand()), base * (0.8 + 0.35 * rand()), rand));
    }
    this.pads = [];
    const want = clamp(Math.round((w * h) / 42000), 4, 10);
    for (let tries = 0; this.pads.length < want && tries < 400; tries++) {
      const r = Math.min(70, m * (0.07 + 0.05 * rand())), x = r + rand() * (w - 2 * r), y = r + rand() * (h - 2 * r);
      if (Math.hypot((x - w / 2) / w, (y - h / 2) / h) < 0.22 && rand() < 0.85) continue; // keep the centre open
      if (this.pads.some(p => Math.hypot(p.x - x, p.y - y) < p.r + r + 6)) continue;
      this.pads.push(this.floater(PAD, x, y, r));
    }
    this.flowers = this.pads.slice(0, 2).map(pad => ({ pad, seed: rand() }));
    this.leaves = [];
    for (let i = 0; i < 5; i++) this.leaves.push(this.floater(LEAF, rand() * w, rand() * h, Math.min(22, m * 0.035)));
  }

  floater(type, x, y, r) {
    const { rand } = this;
    return { type, x, y, r, vx: 0, vy: 0, rot: rand() * TAU, vr: (rand() - 0.5) * 0.1, seed: rand(), gx: 0, gy: 0, age: 0 };
  }

  splash(x, y, amount, radiusPx) {
    this.water.disturb(x / this.cell, y / this.cell, Math.max(1.5, radiusPx / this.cell), amount);
  }

  startle(x, y, strength) {
    for (const k of this.koi) {
      const dx = k.x - x, dy = k.y - y, d = Math.hypot(dx, dy) || 1, R = Math.max(130, k.len * 1.8);
      const s = strength * (1 - d / R) * (1.15 - k.depth);
      if (s > k.fear) { k.fear = s; k.fleeX = dx / d; k.fleeY = dy / d; }
    }
  }

  touch(x, y) {
    this.splash(x, y, -0.9, 9);
    this.startle(x, y, 1);
  }

  // Finger dragged from (x0,y0) to (x1,y1): a trail of pushes along the path.
  drag(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0), n = Math.min(60, Math.ceil(d / (this.cell * 1.5)));
    for (let i = 1; i <= n; i++) this.splash(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, -0.06, 7);
    if (n) this.startle(x1, y1, 0.5);
  }

  // A resting finger keeps pressing the surface.
  hold(x, y, dt) {
    this.splash(x, y, -1.2 * dt, 7);
  }

  feed() {
    const { w, h, rand } = this, cx = w * (0.25 + 0.5 * rand()), cy = h * (0.25 + 0.5 * rand());
    for (let i = 0; i < 9 && this.food.length < 60; i++) {
      const a = rand() * TAU, r = rand() * 34, f = this.floater(FOOD, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3.5);
      this.food.push(f);
      this.splash(f.x, f.y, -0.18, 3);
    }
  }

  eat(food, koi) {
    this.food.splice(this.food.indexOf(food), 1);
    this.splash(food.x, food.y, -0.3, koi.len * 0.05);
    koi.gulp = 1; koi.gulped = true;
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const { water, cell, rand } = this;

    for (this.acc += dt; this.acc >= STEP; this.acc -= STEP) water.step();

    for (const k of this.koi) {
      k.update(dt, this);
      // pressure wake from the head, fainter the deeper the fish
      const sh = 1 - k.depth;
      water.disturb(k.x / cell, k.y / cell, Math.max(1.5, (k.len * 0.07) / cell), -(k.speed / k.len) * 0.6 * sh * sh * dt);
    }

    // ambient life: the odd drip or insect touching down
    if ((this.drip -= dt) < 0) {
      this.drip = 2 + rand() * 5;
      this.splash(rand() * this.w, rand() * this.h, -0.25, 3);
    }

    const wind = this.time * 0.05;
    const wx = Math.cos(wind * 1.3) * 1.5, wy = Math.sin(wind) * 1.5;
    const all = [...this.pads, ...this.leaves, ...this.food];
    for (const f of all) {
      water.slope(f.x / cell, f.y / cell, this.g);
      f.gx = this.g[0]; f.gy = this.g[1];
      const push = f.type === PAD ? 260 : 700, drift = f.type === PAD ? 1 : 3;
      f.vx += (-f.gx * push + wx * drift) * dt;
      f.vy += (-f.gy * push + wy * drift) * dt;
      const r = f.r;
      f.vx += (Math.max(0, r - f.x) - Math.max(0, f.x - (this.w - r))) * 4 * dt;
      f.vy += (Math.max(0, r - f.y) - Math.max(0, f.y - (this.h - r))) * 4 * dt;
      const drag = Math.exp(-dt * 1.5);
      f.vx *= drag; f.vy *= drag;
      f.x = clamp(f.x + f.vx * dt, 0, this.w); f.y = clamp(f.y + f.vy * dt, 0, this.h);
      f.vr += (f.gx - f.gy) * 0.4 * dt;
      f.vr *= Math.exp(-dt * 0.6);
      f.rot += f.vr * dt;
      f.age += dt;
    }
    // floating things nudge each other apart instead of overlapping
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j], dx = b.x - a.x, dy = b.y - a.y, r = a.r + b.r, d2 = dx * dx + dy * dy;
        if (d2 < r * r && d2 > 1e-6) {
          const d = Math.sqrt(d2), p = ((r - d) / d) * 1.5 * dt;
          const wa = b.r / r, wb = a.r / r; // the smaller one moves more
          a.vx -= dx * p * wa * 10; a.vy -= dy * p * wa * 10;
          b.vx += dx * p * wb * 10; b.vy += dy * p * wb * 10;
        }
      }
    }
    this.food = this.food.filter(f => f.age < 60);
  }
}
