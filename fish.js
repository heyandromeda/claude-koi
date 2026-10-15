// Koi behaviour. No DOM or GL: positions are CSS px (y down), depth is metres below the surface.
//
// What the renderer reads from a Koi (keep these): x, y (snout), dir (heading, radians), len (px),
// girth (body-width factor, ~0.85-1.15), depth (m), pitch (radians, + nose up), mouth (0 shut .. 1 gaping
// at the surface), phase (tail-beat phase), swim (body-wave amplitude factor), fins (0 tucked .. 1 spread),
// finL / finR (extra spread per side, 0..1), turn (rad/s), variety (name), seed (0..1, pattern seed),
// and spine(nb, nt, out, z) below.
//
// What a Koi may use from the pond: w, h, ppm, cell, time, koi, food, stones, water, rand(),
// shore(x, y) (px into the water from the bank; negative on land), bedDepth(x, y) (m),
// splash(x, y, amount, radiusPx, ring), eat(food, koi).
// The pond calls k.update(dt, pond) every frame, and k.onTouch / onDrag / onHold on user input.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = a => a - TAU * Math.floor((a + Math.PI) / TAU); // to [-pi, pi)

export class Koi {
  constructor(variety, x, y, len, rand) {
    Object.assign(this, {
      variety, x, y, len, rand, seed: rand(),
      girth: 0.9 + rand() * 0.25,
      dir: rand() * TAU, speed: len * 0.4, turn: 0, fear: 0, fleeX: 0, fleeY: 0,
      depth: 0.3 + rand() * 0.4, pitch: 0, mouth: 0, gulp: 0, gulped: false,
      phase: rand() * TAU, fin: rand() * TAU, t: rand() * 100,
      beat: 1, beating: true, swim: 1, fins: 0.5, finL: 0, finR: 0, mood: 1, moodT: rand() * 8,
      // incommensurate wander frequencies so no two fish (or two laps) look alike
      f1: 0.05 + rand() * 0.07, f2: 0.13 + rand() * 0.12, f3: 0.02 + rand() * 0.03,
      p1: rand() * TAU, p2: rand() * TAU, cruise: 0.45 + rand() * 0.25,
    });
  }

  update(dt, pond) {
    this.t += dt;
    const { w, h } = pond, L = this.len;
    const fx = Math.cos(this.dir), fy = Math.sin(this.dir);
    let sx = fx, sy = fy;

    // moods: mostly cruising, sometimes dawdling, now and then hovering low to nose about the bed
    if ((this.moodT -= dt) < 0) {
      const r = this.rand();
      this.mood = r < 0.55 ? 1 : r < 0.82 ? 0.45 : 0.08;
      this.moodT = 5 + this.rand() * 12;
    }

    // the banks, and the far edges of the view (the pond carries on beyond them): look ahead and turn early
    const m = Math.min(L * 1.5, Math.min(w, h) * 0.3);
    const ax = this.x + fx * L * 0.7, ay = this.y + fy * L * 0.7;
    const sh = pond.shore(ax, ay);
    if (sh < m) {
      const gx = pond.shore(ax + 2, ay) - pond.shore(ax - 2, ay), gy = pond.shore(ax, ay + 2) - pond.shore(ax, ay - 2);
      const g = Math.hypot(gx, gy) || 1;
      sx += (2.5 * (gx / g) * (m - sh)) / m; sy += (2.5 * (gy / g) * (m - sh)) / m;
    }
    sx -= (2.5 * Math.max(0, ax - (w + L * 0.5 - m))) / m;
    sy -= (2.5 * Math.max(0, ay - (h + L * 0.5 - m))) / m;
    for (const s of pond.stones) {
      const ox = ax - s.x, oy = ay - s.y, r = s.r + L * 0.6, d = Math.hypot(ox, oy);
      if (d < r && d > 1e-6) { sx += (ox / d) * 2.5 * (1 - d / r); sy += (oy / d) * 2.5 * (1 - d / r); }
    }

    // neighbours at a similar depth: keep some personal space, loosely match heading
    for (const o of pond.koi) {
      if (o === this) continue;
      const ox = this.x - o.x, oy = this.y - o.y, d2 = ox * ox + oy * oy;
      const same = Math.max(0, 1 - Math.abs(this.depth - o.depth) * 2), r = (L + o.len) * 0.45;
      if (d2 < r * r && d2 > 1e-6) {
        const d = Math.sqrt(d2), k = (1 - d / r) * 0.9 * same;
        sx += (ox / d) * k; sy += (oy / d) * k;
      } else if (d2 < 6 * L * L) {
        sx += Math.cos(o.dir) * 0.15 * same; sy += Math.sin(o.dir) * 0.15 * same;
      }
    }

    if (this.fear > 0.05) { sx += this.fleeX * this.fear * 3; sy += this.fleeY * this.fear * 3; }

    // food: nearest pellet, unless too scared to care
    let food = null, best = Infinity;
    if (this.fear < 0.35) {
      for (const f of pond.food) {
        const d2 = (f.x - this.x) ** 2 + (f.y - this.y) ** 2;
        if (d2 < best) { best = d2; food = f; }
      }
    }
    let target = L * this.cruise * this.mood * (0.8 + 0.2 * Math.sin(this.t * this.f3 * TAU + this.p2));
    if (food) {
      const d = Math.sqrt(best);
      if (d < L * 0.12 && this.depth < 0.12) { pond.eat(food, this); food = null; } else {
        sx += ((food.x - this.x) / d) * 2; sy += ((food.y - this.y) / d) * 2;
        target = Math.min(L * 1.1, d * 1.2 + L * 0.25);
      }
    }
    target += this.fear * L * 3.2;

    const wander = (Math.sin(this.t * this.f1 * TAU + this.p1) * 0.6 + Math.sin(this.t * this.f2 * TAU + this.p2) * 0.4) * (0.25 + 0.35 * this.mood);
    const maxTurn = 1.3 + this.fear * 3 + (food ? 1 : 0);
    const want = clamp(wrap(Math.atan2(sy, sx) - this.dir) * 2.2 + wander, -maxTurn, maxTurn);
    this.turn += (want - this.turn) * Math.min(1, dt * 2.5);
    this.dir = wrap(this.dir + this.turn * dt);

    // thrust comes in bursts of tail beats with glides in between; a scared fish just goes
    if (this.fear > 0.3) this.beating = true;
    else if (this.beating ? this.speed > target * 1.1 : this.speed < target * 0.75) this.beating = !this.beating;
    this.beat += ((this.beating ? 1 : 0) - this.beat) * Math.min(1, dt * 5);
    const k = 0.35 + this.fear * 3;
    this.speed += k * (target * 1.6 * this.beat - this.speed) * dt;
    const brake = clamp((this.speed - target) / (L * 0.5), 0, 1);
    if (!this.beating) this.speed -= brake * L * 0.5 * dt;
    this.speed = clamp(this.speed, 0, L * 4);
    this.fins += (clamp(brake + (1 - this.mood) * 0.7 + Math.abs(this.turn) * 0.25, 0, 1) * (1 - this.fear) - this.fins) * Math.min(1, dt * 3);
    this.finL = Math.max(0, -this.turn) * 0.3; this.finR = Math.max(0, this.turn) * 0.3;

    const sp = this.speed * (1 - Math.min(0.45, Math.abs(this.turn) * 0.18));
    this.x = clamp(this.x + Math.cos(this.dir) * sp * dt, 2, w + L * 0.5);
    this.y = clamp(this.y + Math.sin(this.dir) * sp * dt, 2, h + L * 0.5);
    const shNow = pond.shore(this.x, this.y);
    if (shNow < 2) { // never up onto the bank
      const gx = pond.shore(this.x + 2, this.y) - pond.shore(this.x - 2, this.y), gy = pond.shore(this.x, this.y + 2) - pond.shore(this.x, this.y - 2);
      const g = Math.hypot(gx, gy) || 1;
      this.x += (gx / g) * (2 - shNow); this.y += (gy / g) * (2 - shNow);
    }
    for (const s of pond.stones) {
      const ox = this.x - s.x, oy = this.y - s.y, d = Math.hypot(ox, oy) || 1, r = s.r + L * 0.08;
      if (d < r) { this.x = s.x + (ox / d) * r; this.y = s.y + (oy / d) * r; }
    }

    this.fear *= Math.exp(-dt * 1.3);
    const drive = Math.min(2.5, (target * 1.6) / L);
    this.swim = (0.15 + 0.85 * this.beat) * (0.55 + 0.45 * Math.min(1, drive)) + this.fear * 0.3;
    this.phase += dt * (3 + 8 * drive) * (0.3 + 0.7 * this.beat);
    this.fin += dt * (2 + 4 * this.fins);

    // depth (m): hovering fish go low; now and then one rises to gulp at the surface
    const bed = pond.bedDepth(this.x, this.y);
    if (this.gulp > 0) this.gulp -= dt;
    else if (this.rand() < dt / 60) { this.gulp = 2.2; this.gulped = false; }
    const goal = this.gulp > 0 || food ? 0.03 : this.mood < 0.2 ? bed - 0.15 : 0.3 + 0.2 * Math.sin(this.t * this.f3 * 4 + this.p1);
    const before = this.depth;
    this.depth += (clamp(goal, 0.03, bed - 0.08) - this.depth) * Math.min(1, dt * 0.8);
    this.depth = clamp(this.depth, 0.02, Math.max(0.02, bed - 0.06));
    this.pitch += (clamp((before - this.depth) / dt * 2, -0.5, 0.5) - this.pitch) * Math.min(1, dt * 3);
    this.mouth = Math.max(0, this.mouth - dt * 3);
    if (this.gulp > 0 && !this.gulped && this.depth < 0.06) {
      this.gulped = true; this.mouth = 1;
      pond.splash(this.x, this.y, -0.3, L * 0.04, true);
    }
  }

  onTouch(x, y, pond) { this.startle(x, y, 1, pond); }
  onDrag(x0, y0, x1, y1, pond) { this.startle(x1, y1, 0.5, pond); }
  onHold() {}

  startle(x, y, strength) {
    const dx = this.x - x, dy = this.y - y, d = Math.hypot(dx, dy) || 1, R = Math.max(130, this.len * 1.8);
    const s = strength * (1 - d / R) * (1.15 - Math.min(1, this.depth));
    if (s > this.fear) {
      if (s > 0.4 && s > this.fear + 0.2) { // C-start: whip the body round and bolt
        this.turn = clamp(wrap(Math.atan2(dy, dx) - this.dir) * 4, -5, 5);
        this.beating = true; this.beat = 1; this.speed += this.len * s;
      }
      this.fear = s; this.fleeX = dx / d; this.fleeY = dy / d;
    }
  }

  // Spine from snout to tail tip as [x, y, angle] triples (angle points tailward); z scales the fish.
  spine(nb, nt, out, z = 1) {
    const L = this.len * z, body = 0.76;
    const bend = clamp((this.turn / Math.max(this.speed, this.len * 0.3)) * this.len, -2, 2); // radians over the length
    let x = this.x, y = this.y;
    for (let i = 0; i <= nb + nt; i++) {
      const s = i <= nb ? (i / nb) * body : body + ((i - nb) / nt) * (1 - body);
      const flex = s > body ? ((s - body) / (1 - body)) * 0.35 * Math.sin(this.phase - s * 5.5 - 0.9) : 0;
      const a = this.dir + Math.PI - bend * s + ((0.03 + 0.4 * s * s) * Math.sin(this.phase - s * 5.5) + flex) * this.swim;
      out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = a;
      const ds = (i < nb ? body / nb : (1 - body) / nt) * L;
      x += Math.cos(a) * ds; y += Math.sin(a) * ds;
    }
    return out;
  }
}
