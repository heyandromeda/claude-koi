// Koi behaviour. No DOM or GL: positions are CSS px (y down), depth is metres below the surface.
//
// What the renderer reads from a Koi (keep these): x, y (snout), dir (heading, radians), len (px),
// girth (body-width factor, ~0.85-1.15), depth (m), pitch (radians, + nose up), mouth (0 shut .. 1 gaping
// at the surface), phase (tail-beat phase), swim (body-wave amplitude factor), fins (0 tucked .. 1 spread),
// finL / finR (extra spread per side, 0..1), turn (rad/s), variety (name), seed (0..1, pattern seed),
// and spine(nb, nt, out, z) below. The pond may also read speed (px/s along dir, e.g. for wakes).
// Pectoral fins: the renderer draws each at .25 + 1.1 * clamp(fins + finL|finR, 0, 1.3) radians from the
// body axis and adds no motion of its own, so every tuck, flare and sculling stroke is set here. finL is
// the fish's own left side; a right turn (turn > 0, since y points down) flares finR, the inside fin.
//
// What a Koi may use from the pond: w, h, ppm, cell, time, koi, food, stones, water, rand(),
// shore(x, y) (px into the water from the bank; negative on land), bedDepth(x, y) (m),
// splash(x, y, amount, radiusPx, ring), eat(food, koi), and when present pads and leaves ({ x, y, r }).
// The pond calls k.update(dt, pond) every frame, and k.onTouch / onDrag / onHold on user input.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = a => a - TAU * Math.floor((a + Math.PI) / TAU); // to [-pi, pi)
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// closest point of the segment a-b to p: [distance, x, y]
function nearest(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return [Math.hypot(ax + dx * t - px, ay + dy * t - py), ax + dx * t, ay + dy * t];
}

const ACTIVITY = 0.85;     // mid-October water (~14 C): a touch slower and lazier, still keen on food
const PIVOT = 0.3;         // a koi turns about a point this far back along it, so its snout swings
const BODY = 0.76;         // share of the spine that is body; the rest is tail fin
const VMAX = 3.5;          // body lengths per second: a bolt, briefly
const SHADE = [0.6, 0.8];  // the way shadows fall from the rocks (sun high in the top-left)

export class Koi {
  constructor(variety, x, y, len, rand) {
    Object.assign(this, {
      variety, x, y, len, rand, seed: rand(),
      girth: 0.9 + rand() * 0.25,
      dir: rand() * TAU, speed: len * 0.3, slip: 0, rate: 0, turn: 0,
      depth: 0.3 + rand() * 0.4, vz: 0, pitch: 0, mouth: 0, gulpT: 0, gapeP: rand() * TAU,
      phase: rand() * TAU, swim: 0, fins: 0.1, finL: 0, finR: 0, fin: rand() * TAU,
      // personal tempo and habits, so that no two fish move alike
      t: 0, nerve: rand(), stride: 0.56 + rand() * 0.1, scull: 1.1 + rand() * 0.6, circ: rand() < 0.7 ? 1 : -1,
      mode: 'cruise', modeT: 4 + rand() * 10, legT: 0, legAim: 0, pace: 1, riseT: 20 + rand() * 120, st: 0, settled: false,
      fear: 0, wary: 0, wx: 0, wy: 0, cur: null, hold: null, begT: null, foodT: null, meal: null, bites: 0, biteMax: 4, diveT: 0,
      ev: null, stroke: null, lowFrac: 0.7, glide: 1, turnReady: 0, evAng: 0, tailEv: 0, tailV: 0, bendC: 0, bendP: 0,
      flp: 1, fla: 0, tl: 0, pa: 0, px: 0, py: 0, dragLen: 0, dragNear: Infinity, dragX: 0, dragY: 0, taps: 0, tapAt: -9,
      hist: [], histT: -1, g: { dist: Infinity },
    });
    this.legAim = this.aim = this.dir;
  }

  // Size sets the temperament: big fish are ponderous and bold, small ones quick and shy.
  traits(pond) {
    const sz = this.len / (pond.ppm * 0.5);
    this.sz = sz;
    this.slow = Math.sqrt(sz);   // turn and glide time scale
    this.tempo = sz ** -0.3;     // speeds in body lengths: small fish are relatively quicker
    this.bold = clamp(0.2 + (0.6 * (sz - 0.55)) / 0.8 + 0.35 * (this.nerve - 0.5) + (this.variety === 'chagoi' ? 0.25 : 0), 0.05, 1);
    this.cruiseV = (0.34 + 0.2 * this.rand()) * this.tempo * ACTIVITY;
    this.cdepth = 0.3 + 0.5 * this.rand();
    this.waryT = 20 + 70 * (1 - this.bold);
  }

  update(dt, pond) {
    if (!this.sz) this.traits(pond);
    this.t += dt;
    this.sense(dt, pond);
    this.decide(dt, pond);
    this.steer(pond);
    this.locomote(dt, pond);
    this.move(dt, pond);
    if (this.t - this.histT >= 0.1) { // where it has been, for a follower to copy with a lag
      this.histT = this.t;
      this.hist.unshift({ x: this.x, y: this.y, dir: this.dir, depth: this.depth, speed: this.speed });
      if (this.hist.length > 10) this.hist.pop();
    }
  }

  sense(dt, pond) {
    const L = this.len;
    // a finger swept fast over a fish spooks it; a slow one is just a finger in the water
    if (this.dragLen > 0) {
      const fast = clamp((this.dragLen / Math.max(dt, 1 / 120) - 1.5 * pond.ppm) / (2 * pond.ppm), 0, 1), near = 1 - this.dragNear / (0.9 * L);
      if (fast > 0 && near > 0) this.startle(this.dragX, this.dragY, (0.3 + 0.7 * fast) * near * (1.25 - 0.5 * Math.min(1, this.depth)));
      this.dragLen = 0; this.dragNear = Infinity;
    }
    // fright passes in a second or two; wariness lingers, and food or a familiar hand wears it off faster
    this.fear *= Math.exp(-dt / (1.6 * this.slow));
    const lure = pond.food.length > 0 || this.mode === 'beg';
    this.wary *= Math.exp((-dt / this.waryT) * (lure ? 1 + 2 * this.bold : 1));
    if (this.cur && (this.cur.T -= dt) < 0) this.cur = null;
    if (!pond.food.length) this.foodT = null;
  }

  setMode(m, T = 0) {
    if (this.mode === m) return;
    this.mode = m; this.modeT = T; this.settled = false; this.st = 0;
  }

  // ---------- what it wants: a point or a heading, a speed (L/s), a depth, a posture ----------
  decide(dt, pond) {
    const L = this.len, g = this.g, h = this.hold;
    Object.assign(g, {
      tx: null, ty: null, aim: this.dir, face: null, arrive: 0.3 * L, want: this.cruiseV, depth: this.cdepth + 0.35 * this.wary,
      vz: 0.08, urg: 0, hover: 0, gape: 0, hz: 1.5, mouth: 0, space: 1 + 0.5 * this.wary, pitch: 0,
    });
    const held = h && pond.time - h.at < 0.25 && h.dur > 0.5;
    if (held) this.begT = this.begT ?? this.latency(h.x, h.y) + (this.mode === 'rest' ? 3 + 6 * this.rand() : 0) + 4 * this.wary;
    else this.begT = null;
    if (held) this.begT -= dt;

    // what pulls hardest: a fright, then food, then a person leaning over, then a tap
    if (this.fear > 0.15) this.setMode('flee');
    else if (pond.food.length && this.hungry(dt, pond)) this.setMode('feed');
    else if (held && this.begT < 0) this.setMode('beg');
    else if (this.cur && (this.cur.delay -= dt) < 0) this.setMode('curious');
    else if (this.mode === 'feed' || this.mode === 'beg') {
      const sp = this.mode === 'beg' ? h : this.spot;
      this.setMode('linger', (this.mode === 'beg' ? 5 + 10 * this.rand() : 3 + 6 * this.rand()));
      this.spot = { x: sp.x, y: sp.y, T: this.modeT };
    } else if (this.mode === 'flee' || this.mode === 'curious') this.disperse(pond, this.mode === 'flee' ? this.dir : null);
    else if (['cruise', 'rest', 'follow', 'nose', 'rise'].includes(this.mode) && (this.modeT -= dt) < 0) this.idle(pond);

    switch (this.mode) {
      case 'flee': {
        const cx = this.x - Math.cos(this.dir) * 0.4 * L, cy = this.y - Math.sin(this.dir) * 0.4 * L;
        g.aim = Math.atan2(cy - this.wy, cx - this.wx);
        g.want = (0.5 + 2.6 * this.fear) * this.tempo; g.urg = 1;
        g.depth = Math.max(this.depth, 0.55 + 0.3 * this.wary); g.vz = 0.3;
        break;
      }
      case 'feed': this.feed(dt, pond, g); break;
      case 'beg': {
        // a person at the edge means food: crowd in under the hand, heads up, mouths working, jostling
        if (!this.settled) {
          this.settled = true; this.st = 0;
          this.shy = this.bold < 0.3 || this.wary > 0.4;
          this.begA = Math.atan2(this.y - h.y, this.x - h.x) + (this.rand() - 0.5) * 1.2;
          this.begR = (this.shy ? 1.1 + 0.6 * this.rand() : 0.2 + 0.8 * this.rand()) * L;
          this.begD = this.shy ? 0.2 + 0.1 * this.rand() : 0.02 + 0.12 * (1 - this.bold) * this.rand();
        }
        if ((this.st -= dt) < 0) { // shuffle for a better place, nose in
          this.st = 0.8 + 2 * this.rand(); this.dart = 0.3 * this.rand();
          this.begA += (this.rand() - 0.5) * 0.9;
          this.begR = clamp(this.begR + (this.rand() - 0.5) * 0.5 * L, 0.15 * L, (this.shy ? 1.8 : 1.2) * L);
        }
        this.dart -= dt;
        this.slot(pond, h, g);
        const d = Math.hypot(g.tx - this.x, g.ty - this.y);
        g.face = Math.atan2(h.y - this.y, h.x - this.x); g.arrive = 0.45 * L;
        g.want = d > 1.5 * L ? (0.9 + 0.6 * this.bold) * this.tempo : 0.15 + (0.5 * d) / L + (this.dart > 0 ? 0.5 : 0);
        g.depth = this.begD; g.vz = 0.2; g.hover = 1; g.gape = this.shy ? 0 : 1; g.hz = 1 + this.nerve; g.pitch = 0.5;
        g.space = 0.3; g.urg = 0.5;
        break;
      }
      case 'curious': {
        // a tap might be a pellet: come and look, hang under the spot a few seconds, mouth at it
        const c = this.cur, d = Math.hypot(c.x - this.x, c.y - this.y);
        if (d < 0.9 * L) c.hover -= dt;
        if (c.hover < 0) { this.cur = null; this.disperse(pond, Math.atan2(this.y - c.y, this.x - c.x)); break; }
        g.tx = c.x - Math.cos(c.a) * 0.2 * L; g.ty = c.y - Math.sin(c.a) * 0.2 * L;
        g.face = Math.atan2(c.y - this.y, c.x - this.x); g.arrive = 0.4 * L;
        g.want = d > 1.5 * L ? (0.7 + 0.3 * this.bold) * this.tempo : 0.15 + (0.4 * d) / L;
        g.depth = 0.05 + 0.25 * this.wary; g.vz = 0.15; g.hover = 1; g.gape = 0.6; g.hz = 0.8 + 0.5 * this.nerve; g.pitch = 0.3;
        g.space = 0.5;
        break;
      }
      case 'linger': {
        // the hand (or the food) has gone: hang about, less and less hopeful, then drift off
        const sp = this.spot;
        if ((this.modeT -= dt) < 0) { this.disperse(pond, Math.atan2(this.y - sp.y, this.x - sp.x)); break; }
        if (!this.settled) { this.settled = true; this.begA = Math.atan2(this.y - sp.y, this.x - sp.x); this.begR = (0.6 + 0.8 * this.rand()) * L; }
        this.slot(pond, sp, g);
        g.face = Math.atan2(sp.y - this.y, sp.x - this.x); g.arrive = 0.6 * L;
        g.want = 0.1 + (0.3 * Math.hypot(g.tx - this.x, g.ty - this.y)) / L;
        g.depth = 0.08 + 0.15 * (1 - this.bold); g.vz = 0.06; g.hover = 0.7; g.gape = 0.5 * (this.modeT / sp.T); g.hz = 0.7; g.space = 0.6;
        break;
      }
      case 'rest': {
        // hang just off the bed in the lee of a rock or under the pads, barely moving
        const sp = this.spot, d = Math.hypot(sp.x - this.x, sp.y - this.y);
        if (d < 0.5 * L) this.settled = true;
        g.tx = sp.x; g.ty = sp.y;
        if (this.settled) {
          g.arrive = 0.7 * L; g.face = sp.dir; g.want = 0; g.hover = 0.4; g.vz = 0.05;
          g.depth = pond.bedDepth(sp.x, sp.y) - 0.1;
        } else { g.want = 0.32 * this.tempo; g.depth = Math.min(this.cdepth, pond.bedDepth(sp.x, sp.y) - 0.1); }
        break;
      }
      case 'follow': {
        // trail a bigger or bolder fish nose to tail, copying its turns a beat late
        const o = this.lead, p = o.hist[Math.min(o.hist.length - 1, Math.round(this.lag / 0.1))];
        if (!p || o.mode !== 'cruise' || Math.hypot(o.x - this.x, o.y - this.y) > 5 * L) { this.disperse(pond, this.dir + (this.rand() < 0.5 ? -1 : 1) * (0.6 + 0.5 * this.rand())); break; }
        const c = Math.cos(p.dir), s = Math.sin(p.dir), Lo = o.len;
        g.tx = p.x - c * this.gap * Lo - s * this.side * Lo; g.ty = p.y - s * this.gap * Lo + c * this.side * Lo;
        g.arrive = 0.6 * L; g.face = p.dir;
        g.want = clamp(p.speed / L + (((g.tx - this.x) * c + (g.ty - this.y) * s) / L) * 0.8, 0, 1.6 * this.tempo);
        g.depth = p.depth + 0.05;
        break;
      }
      case 'nose': {
        // root about on the bed: hang head-down over a spot for a moment, then move on a little
        if (!this.spot || (this.settled && (this.st -= dt) < 0)) { this.spot = this.near(pond, 0.4 + 0.6 * this.rand(), 0.6); this.settled = false; }
        const sp = this.spot, d = Math.hypot(sp.x - this.x, sp.y - this.y);
        if (!this.settled && d < 0.3 * L) { this.settled = true; this.st = 1 + 2 * this.rand(); }
        g.tx = sp.x; g.ty = sp.y; g.arrive = 0.4 * L; g.face = sp.dir;
        g.want = this.settled ? 0 : 0.35 * this.tempo; g.hover = this.settled ? 0.6 : 0;
        g.depth = pond.bedDepth(sp.x, sp.y) - 0.07; g.vz = 0.1;
        if (this.settled) { g.pitch = -0.45; g.mouth = 0.3 * Math.max(0, Math.sin(this.t * 7)); }
        break;
      }
      case 'rise': {
        // come up under a floating leaf, mouth it, let it go
        const lf = this.spot, d = Math.hypot(lf.x - this.x, lf.y - this.y);
        g.tx = lf.x; g.ty = lf.y; g.arrive = 0.3 * L; g.face = Math.atan2(lf.y - this.y, lf.x - this.x);
        g.want = d > L ? 0.5 * this.tempo : 0.15 + (0.3 * d) / L; g.hover = d < 0.6 * L ? 0.6 : 0;
        g.depth = d < 2 * L ? 0.03 : this.cdepth; g.vz = 0.12; g.pitch = d < L ? 0.35 : 0;
        if (!this.settled && d < 0.2 * L && this.depth < 0.07) {
          this.settled = true; this.st = 0.35; pond.splash(this.x, this.y, -0.2, L * 0.03, true);
          if (lf.vx !== undefined) { lf.vx += Math.cos(this.dir) * 6; lf.vy += Math.sin(this.dir) * 6; }
        }
        if (this.settled) { g.mouth = this.st > 0 ? 1 : 0; if ((this.st -= dt) < -0.5) this.disperse(pond, this.dir + (this.rand() - 0.5) * 2); }
        break;
      }
      default: { // cruise: hold a heading a while, then turn deliberately; patrol along the banks
        if ((this.legT -= dt) < 0) this.newLeg(pond);
        g.aim = this.legAim + 0.12 * Math.sin(this.t * 0.23 + this.nerve * 9);
        g.want = this.cruiseV * this.pace + 0.2 * this.wary;
        if (this.wary < 0.2 && (this.riseT -= dt) < 0) { this.riseT = 60 + 120 * this.rand(); this.rise(pond); }
      }
    }
  }

  // Seconds before it reacts to something at (x, y): bold fish first, near ones sooner.
  latency(x, y) {
    return (0.2 + 1.4 * (1 - this.bold)) * (0.6 + 0.8 * this.rand()) + Math.hypot(x - this.x, y - this.y) / (8 * this.len);
  }

  // A place in the crowd around a point, kept in the water.
  slot(pond, c, g) {
    const L = this.len;
    for (let i = 0; i < 4; i++) {
      g.tx = c.x + Math.cos(this.begA) * this.begR; g.ty = c.y + Math.sin(this.begA) * this.begR;
      if (pond.shore(g.tx, g.ty) > 0.3 * L && !pond.stones.some(s => Math.hypot(g.tx - s.x, g.ty - s.y) < s.r + 0.3 * L)) return;
      this.begA += 1.3;
    }
  }

  hungry(dt, pond) {
    if (this.mode === 'feed') return true;
    this.foodT = this.foodT ?? this.latency(pond.food[0].x, pond.food[0].y) + 5 * this.wary + (this.mode === 'rest' ? 1 + 3 * this.rand() : 0);
    if ((this.foodT -= dt) > 0) return false;
    if (pond.food.length > 3) return true;
    // a pellet or two: only the nearest fish bother
    const dist = k => Math.min(...pond.food.map(f => Math.hypot(f.x - k.x, f.y - k.y)));
    const mine = dist(this);
    return pond.koi.filter(o => o !== this && dist(o) < mine).length <= pond.food.length;
  }

  feed(dt, pond, g) {
    const L = this.len, food = pond.food;
    if ((this.st -= dt) < 0 || !food.includes(this.meal)) { this.st = 0.3 + 0.3 * this.rand(); this.meal = this.pick(pond); }
    const p = this.meal, d = Math.hypot(p.x - this.x, p.y - this.y);
    this.spot = { x: p.x, y: p.y };
    g.tx = p.x; g.ty = p.y; g.face = Math.atan2(p.y - this.y, p.x - this.x); g.arrive = 0.5 * L;
    g.want = d > 2.5 * L ? Math.min(2.5, (1.5 + this.bold) * this.tempo) : 0.25 + (0.6 * d) / L;
    g.urg = d > 1.5 * L ? 0.8 : 0.3; g.space = 0.25; g.hover = d < L ? 1 : 0; g.vz = 0.25;
    if ((this.diveT -= dt) > 0) { g.depth = 0.35; g.want = 0.4; g.hover = 0; return; }
    g.depth = d < 2.5 * L ? 0.02 : 0.2;
    g.pitch = d < 1.5 * L ? 0.5 : 0;
    g.mouth = this.depth < 0.12 ? clamp(1.4 - d / (0.45 * L), 0, 1) : 0;
    // slurp: a pellet goes when the open mouth reaches it, with any others right there
    if (this.depth < 0.08 && this.mouth > 0.5) {
      let n = 0;
      for (let i = food.length - 1; i >= 0 && n < 3; i--) {
        const f = food[i];
        if (Math.hypot(f.x - this.x, f.y - this.y) < 0.1 * L + 2 * f.r) { pond.eat(f, this); n++; }
      }
      if (n) {
        this.bites += n; this.gulpT = 0.25;
        if (this.bites >= this.biteMax) { this.bites = 0; this.biteMax = 3 + 4 * this.rand(); this.diveT = 1 + 1.5 * this.rand(); }
      }
    }
  }

  // Bold fish go for the thick of it; shy ones take the stragglers.
  pick(pond) {
    let best = null, bs = Infinity;
    for (const f of pond.food) {
      let crowd = 0;
      for (const o of pond.koi) if (o !== this && (o.x - f.x) ** 2 + (o.y - f.y) ** 2 < (0.7 * o.len) ** 2) crowd++;
      const s = Math.hypot(f.x - this.x, f.y - this.y) * (f === this.meal ? 0.8 : 1) + crowd * (1 - this.bold) * 0.7 * this.len;
      if (s < bs) { bs = s; best = f; }
    }
    return best;
  }

  idle(pond) {
    const r = this.rand();
    if (this.mode !== 'rest' && r < 0.15 * (1 + this.wary)) {
      this.setMode('rest', 10 + 50 * this.rand());
      this.spot = this.restSpot(pond);
    } else if (r < 0.4 && this.follow(pond)) {
    } else if (r < 0.5) {
      this.setMode('nose', 5 + 8 * this.rand()); this.spot = null;
    } else {
      this.setMode('cruise', 8 + 14 * this.rand());
      if (this.legT > 1) this.legT = 0.5 * this.rand();
    }
  }

  disperse(pond, away) {
    this.setMode('cruise', 6 + 10 * this.rand());
    this.newLeg(pond, away);
    this.pace = 0.7;
  }

  newLeg(pond, away = null) {
    const { rand, len: L } = this;
    this.legT = (3 + 7 * rand()) * this.slow;
    this.pace = rand() < 0.2 ? 0.55 : 0.8 + 0.45 * rand();
    let best = this.dir, bs = -Infinity;
    for (let i = 0; i < 6; i++) {
      const a = away !== null ? away + (rand() - 0.5) * 1.4 : this.dir + (i === 0 ? (rand() - 0.5) * 0.6 : (rand() < 0.5 ? -1 : 1) * (0.5 + 1.6 * rand()));
      const px = this.x + Math.cos(a) * 2.5 * L, py = this.y + Math.sin(a) * 2.5 * L, sh = pond.shore(px, py);
      let s = Math.min(sh, 2 * L) - 1.5 * Math.max(0, px - pond.w + L, py - pond.h + L) + rand() * 1.5 * L;
      for (const st of pond.stones) s -= Math.max(0, st.r + L - Math.hypot(px - st.x, py - st.y));
      // most of them go round the pond the same way, along the banks
      const [gx, gy] = this.grad(pond, px, py);
      s += this.circ * (Math.cos(a) * gy - Math.sin(a) * gx) * 0.8 * L * clamp(1 - sh / (3 * L), 0, 1);
      if (s > bs) { bs = s; best = a; }
    }
    this.legAim = best;
  }

  // A spot a little ahead, in open water and in view.
  near(pond, ahead, spread) {
    const L = this.len;
    for (let i = 0; ; i++) {
      const a = this.dir + (this.rand() - 0.5) * 2 * spread * (1 + i * 0.3), x = this.x + Math.cos(a) * ahead * L, y = this.y + Math.sin(a) * ahead * L;
      if (i > 8 || this.ok(pond, x, y)) return { x, y, dir: a };
    }
  }

  ok(pond, x, y) {
    const L = this.len;
    return pond.shore(x, y) > 0.5 * L && x < pond.w - 0.6 * L && y < pond.h - 0.6 * L && pond.stones.every(s => Math.hypot(x - s.x, y - s.y) > s.r + 0.35 * L);
  }

  // Where a koi likes to rest: in the shade of a rock, under the pads, beside another resting fish, or deep.
  restSpot(pond) {
    const L = this.len, r = this.rand, opts = [];
    for (const s of pond.stones) {
      const d = s.r + (0.4 + 0.3 * r()) * L, a = Math.atan2(SHADE[1], SHADE[0]) + (r() - 0.5) * 1.6;
      opts.push([s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, 2]);
    }
    const pads = pond.pads || [];
    if (pads.length) { const p = pads[Math.floor(r() * pads.length)]; opts.push([p.x + (r() - 0.5) * L, p.y + (r() - 0.5) * L, 3]); }
    for (const o of pond.koi) {
      if (o === this || o.mode !== 'rest' || !o.settled) continue;
      const side = r() < 0.5 ? -1 : 1, d = (0.35 + 0.3 * r()) * L;
      opts.push([o.x - Math.sin(o.dir) * d * side - Math.cos(o.dir) * (r() - 0.3) * 0.5 * L, o.y + Math.cos(o.dir) * d * side - Math.sin(o.dir) * (r() - 0.3) * 0.5 * L, 2, o.dir]);
    }
    opts.push([pond.w * (0.3 + 0.5 * r()), pond.h * (0.3 + 0.5 * r()), 1]);
    const good = opts.filter(o => this.ok(pond, o[0], o[1]));
    let pick = good.reduce((s, o) => s + o[2], 0) * r(), o = good[0];
    for (o of good) if ((pick -= o[2]) < 0) break;
    if (!o) return this.near(pond, 1, 1);
    return { x: o[0], y: o[1], dir: o[3] !== undefined ? o[3] + (r() - 0.5) * 0.5 : this.dir + (r() - 0.5) * 1.2 };
  }

  follow(pond) {
    if (pond.koi.filter(k => k.mode === 'follow').length >= 2) return false;
    let best = null, bs = 0;
    for (const o of pond.koi) {
      const d = Math.hypot(o.x - this.x, o.y - this.y);
      if (o === this || o.mode !== 'cruise' || d > 5 * this.len || o.len < this.len * 0.9 && o.bold < this.bold) continue;
      if (pond.koi.some(k => k.mode === 'follow' && k.lead === o)) continue;
      const s = (o.len / this.len + o.bold) * (1 - d / (5 * this.len)) * this.rand();
      if (s > bs) { bs = s; best = o; }
    }
    if (!best) return false;
    this.setMode('follow', 10 + 30 * this.rand());
    Object.assign(this, { lead: best, lag: 0.3 + 0.5 * this.rand(), gap: 0.9 + 0.5 * this.rand(), side: (this.rand() < 0.5 ? -1 : 1) * (0.2 + 0.25 * this.rand()) });
    return true;
  }

  rise(pond) {
    const L = this.len;
    let leaf = null, bd = 4 * L;
    for (const f of pond.leaves || []) {
      const d = Math.hypot(f.x - this.x, f.y - this.y);
      if (d < bd && pond.shore(f.x, f.y) > 0.4 * L) { bd = d; leaf = f; }
    }
    this.setMode('rise', 14);
    this.spot = leaf || this.near(pond, 1.5, 0.5);
  }

  // ---------- where to point: the wish, bent by banks, rocks and other fish ----------
  steer(pond) {
    const g = this.g, L = this.len, fx = Math.cos(this.dir), fy = Math.sin(this.dir);
    let ax, ay;
    g.dist = Infinity;
    if (g.tx !== null) {
      const dx = g.tx - this.x, dy = g.ty - this.y, a = Math.atan2(dy, dx);
      g.dist = Math.hypot(dx, dy); g.along = dx * fx + dy * fy; g.lat = dy * fx - dx * fy; // lat: + to the fish's right
      const f = g.dist < g.arrive && g.face !== null ? g.face : a;
      ax = Math.cos(f); ay = Math.sin(f);
    } else { ax = Math.cos(g.aim); ay = Math.sin(g.aim); }

    // banks: slide along them rather than bounce off
    const look = Math.min(L * (0.5 + 0.6 * Math.abs(this.speed) / L), g.dist);
    const hx = this.x + fx * look, hy = this.y + fy * look, sh = pond.shore(hx, hy);
    const margin = g.tx !== null ? clamp(pond.shore(g.tx, g.ty) - 0.1 * L, 0.25 * L, L) : L;
    if (sh < margin) {
      const [gx, gy] = this.grad(pond, hx, hy), k = clamp((margin - sh) / margin, 0, 1);
      if (ax * gx + ay * gy < 0.3) {
        let tx = -gy, ty = gx;
        const along = tx * ax + ty * ay;
        if (along < 0 || (Math.abs(along) < 0.15 && this.circ < 0)) { tx = gy; ty = -gx; }
        ax += (tx + gx * 0.5 - ax) * k; ay += (ty + gy * 0.5 - ay) * k;
      }
    }
    // the edges of the view: the pond goes on, but turn back before leaving it
    const ex = hx - pond.w, ey = hy - pond.h;
    if (ex > -0.6 * L) ax -= 1.5 * clamp((ex + 0.6 * L) / (0.8 * L), 0, 1);
    if (ey > -0.6 * L) ay -= 1.5 * clamp((ey + 0.6 * L) / (0.8 * L), 0, 1);
    // rocks ahead: go round them
    const n = Math.hypot(ax, ay) || 1;
    ax /= n; ay /= n;
    for (const s of pond.stones) {
      const ox = s.x - this.x, oy = s.y - this.y, along = ox * ax + oy * ay, R = s.r + 0.35 * L;
      if (along < -0.2 * L || along > R + 1.5 * L || g.dist < along - s.r) continue;
      const lat = oy * ax - ox * ay, k = clamp(1 - Math.abs(lat) / R, 0, 1) * clamp(1.5 - (along - s.r) / L, 0, 1);
      const sd = lat > 0 ? -1 : 1; // pass on the side the fish is already on
      ax += -ay * sd * k * 1.5; ay += ax * sd * k * 1.5;
    }
    // personal space at about the same depth; bodies at different depths overlap freely
    const cx = this.x - fx * 0.4 * L, cy = this.y - fy * 0.4 * L;
    this.px = this.py = 0;
    for (const o of pond.koi) {
      if (o === this) continue;
      const ox = cx - (o.x - Math.cos(o.dir) * 0.4 * o.len), oy = cy - (o.y - Math.sin(o.dir) * 0.4 * o.len), d = Math.hypot(ox, oy);
      const same = 1 - Math.abs(this.depth - o.depth) / 0.15, r = (L + o.len) * 0.38 * g.space;
      if (same > 0 && d < r && d > 1e-6) {
        const k = (1 - d / r) * same;
        ax += (ox / d) * k * 1.2; ay += (oy / d) * k * 1.2;
        const m = (k * (r - d) * o.len) / (L + o.len); // the bigger fish shoulders the smaller aside
        this.px += (ox / d) * m; this.py += (oy / d) * m;
      }
    }
    // keep away from where it was frightened
    if (this.wary > 0.05) {
      const ox = cx - this.wx, oy = cy - this.wy, d = Math.hypot(ox, oy) || 1, R = 2.5 * L;
      if (d < R) { const k = this.wary * (1 - d / R) * 2; ax += (ox / d) * k; ay += (oy / d) * k; }
    }
    this.aim = Math.atan2(ay, ax);
  }

  grad(pond, x, y) {
    const gx = pond.shore(x + 2, y) - pond.shore(x - 2, y), gy = pond.shore(x, y + 2) - pond.shore(x, y - 2), n = Math.hypot(gx, gy) || 1;
    return [gx / n, gy / n];
  }

  // ---------- how it swims: C-bend turns, beats and flicks, glides, fins ----------
  locomote(dt, pond) {
    const g = this.g, L = this.len, r = this.rand, want = g.want * L;
    const hovering = g.hover > 0 && g.dist < g.arrive * 1.5;
    const e = wrap(this.aim - this.dir);
    let w = 0, wc = 0; // heading rate: from turn events and flicks; from gentle steering

    if (!this.ev && Math.abs(e) > 0.52 && this.t > this.turnReady) this.turnStart(e, g.urg > 0.5 ? 1 : 0, want);
    if (this.ev) {
      // stage 1: the head swings round and the body curls into a C; stage 2: the tail flips back and pushes off
      const v = this.ev;
      v.t += dt;
      const one = v.t < v.T1, step = Math.min(dt, Math.max(0, v.T1 + v.T2 - (v.t - dt)));
      w = ((one ? v.w1 : v.w2) * step) / dt;
      if (one) this.speed *= Math.exp(-dt * 0.6);
      else this.speed += (Math.max(this.speed, v.kick) - this.speed) * ease(8, dt);
      this.evAng += w * dt;
      if (v.t >= v.T1 + v.T2) {
        this.ev = null;
        this.turnReady = this.t + (0.3 + 0.5 * r()) * this.slow * (1 - 0.6 * Math.min(1, g.urg));
        if (v.c) this.stroke = this.beats(1 + Math.floor(3 * r()), Math.min(VMAX, 2.4 * this.tempo) * L);
      }
    } else wc = clamp(e * 1.5, -1, 1) * (0.3 + 0.5 * g.urg + (hovering ? 0.3 : 0)) / this.slow;

    // thrust: a burst of tail beats or a single flick, then a glide with the body straight
    const st = this.stroke, brake = !this.ev && this.speed > want * 1.35 + 0.1 * L && (g.dist < 2 * L || hovering);
    if (st) {
      if (st.flick) {
        st.t += dt;
        const p = st.t / st.T, q = Math.min(dt, Math.max(0, st.T - (st.t - dt)));
        if (p > 0.5) w += (st.yaw / (st.T * 0.5)) * (q / dt) * (st.t - dt >= st.T * 0.5 ? 1 : (st.t - st.T * 0.5) / dt);
        this.speed += (st.v - this.speed) * ease(4, dt);
        this.flp = Math.min(1, p);
        if (p >= 1) this.stroke = null;
      } else {
        this.speed += (st.v - this.speed) * ease(2.8 / this.slow, dt);
        if (this.phase >= st.end || (st.tmax -= dt) < 0) this.stroke = null;
      }
      if (!this.stroke) { this.lowFrac = 0.5 + 0.3 * r(); this.glide = 0.6 + 0.8 * r(); }
    } else if (!this.ev && !hovering) {
      this.speed *= Math.exp(-dt / (2.4 * this.slow * this.glide)); // a koi glides far
      if (want > 0.05 * L && this.speed < want * this.lowFrac) this.stroke = this.strokeFor(want);
    }
    if (brake) this.speed *= Math.exp(-dt * 1.6);
    if (hovering && !this.ev) {
      // fine positioning with the fins: forward, back, a little sideways
      this.speed += (clamp(g.along * 1.2, -0.12 * L, 0.35 * L) - this.speed) * ease(1.5, dt);
      this.slip += (clamp(g.lat * 1.5, -0.12 * L, 0.12 * L) - this.slip) * ease(2, dt);
    } else this.slip *= Math.exp(-dt * 3);
    this.speed = clamp(this.speed, -0.15 * L, VMAX * L);
    this.rate = w + wc;

    // tail phase follows distance swum (a beat per ~0.6 L), plus a little idle sway
    const beating = this.stroke && !this.stroke.flick, still = this.mode === 'rest' && this.settled;
    const [idleAmp, idleHz] = still ? [0.06, 0.35] : hovering ? [0.1, 0.7] : [0, 0.15];
    this.phase += TAU * ((Math.abs(this.speed) * dt) / (this.stride * L * (beating ? this.stroke.jit : 1)) + idleHz * dt);
    const amp = beating ? this.stroke.amp * (0.9 + 0.5 * clamp(this.speed / L - 1, 0, 1.2)) : idleAmp;
    this.swim += (amp - this.swim) * ease(beating ? 6 : 4, dt);

    // the body: a C that lags the head through turn events, and a gentle curve along a curving path
    for (let n = Math.ceil(dt / (1 / 120)), h = dt / n, wn = 6.5 / this.slow; n--;) {
      this.tailV += (wn * wn * (this.evAng - this.tailEv) - 2 * 0.55 * wn * this.tailV) * h;
      this.tailEv += this.tailV * h;
    }
    if (Math.abs(this.evAng - this.tailEv) > 2.6) this.tailEv = this.evAng - Math.sign(this.evAng - this.tailEv) * 2.6;
    if (Math.abs(this.evAng) > 100) { this.tailEv -= this.evAng; this.evAng = 0; }
    this.bendC = this.evAng - this.tailEv;
    this.bendP += (clamp((wc * L * 0.9) / Math.max(Math.abs(this.speed), 0.3 * L), -0.9, 0.9) - this.bendP) * ease(4, dt);

    // pectorals: folded to bolt, tucked to cruise, flared to brake, the inside one out in a slow turn,
    // and sculling left-right out of phase to hover
    const vL = this.speed / L;
    let base, sc = 0;
    if (this.mode === 'flee' || vL > 1.6 || this.ev?.c) base = 0;
    else if (brake) base = 1.05;
    else if (hovering) { base = 0.3 + 0.2 * g.hover; sc = (still ? 0.1 : 0.28) * g.hover; }
    else base = 0.05 + 0.15 * clamp(1 - vL / 0.5, 0, 1);
    this.fin += dt * TAU * this.scull * (still ? 0.5 : 1);
    const s = Math.sin(this.fin), inside = base > 0 && vL < 1.2 ? clamp(Math.abs(this.turn) * 0.3, 0, 0.6) : 0;
    const l = sc * (0.5 + 0.5 * s) + (this.turn < 0 ? inside : 0), rr = sc * (0.5 - 0.5 * s) + (this.turn > 0 ? inside : 0);
    this.fins += (base - this.fins) * ease(brake ? 14 : 5, dt);
    this.finL += (Math.min(l, 1.3 - base) - this.finL) * ease(9, dt);
    this.finR += (Math.min(rr, 1.3 - base) - this.finR) * ease(9, dt);
  }

  turnStart(d, kind, want) {
    const s = this.slow, j = 0.85 + 0.3 * this.rand(), L = this.len;
    const T1 = kind === 2 ? 0.11 * s * j : Math.max(0.3 * s * j, (0.85 * Math.abs(d)) / ((kind ? 5.2 : 3.5) / s));
    const T2 = (kind === 2 ? 0.13 : 0.24) * s * j;
    this.ev = {
      t: 0, T1, T2, w1: (0.85 * d) / T1, w2: (0.15 * d) / T2, c: kind === 2,
      kick: kind === 2 ? Math.min(VMAX, 3.3 * this.tempo) * L : clamp(want, 0.12 * L, 2.2 * L),
    };
    this.stroke = null; this.flp = 1;
  }

  strokeFor(want) {
    const L = this.len, r = this.rand, deficit = want - this.speed;
    if (this.g.urg < 0.5 && deficit < 0.35 * L && this.speed > 0.25 * want) {
      // a single half-beat: the tail flicks out to one side and back, and the head yaws the other way
      const e = wrap(this.aim - this.dir), yaw = (Math.abs(e) > 0.05 ? Math.sign(e) : r() < 0.5 ? -1 : 1) * Math.min(Math.abs(e) + 0.04, 0.09 + 0.17 * r());
      this.fla = Math.sign(yaw) * (0.2 + 0.12 * r()) * (1.15 - 0.3 * this.slow);
      return { flick: true, t: 0, T: (0.3 + 0.12 * this.slow) * (0.85 + 0.3 * r()), yaw, v: Math.min(want * (1.1 + 0.25 * r()), this.speed + 0.35 * L) };
    }
    return this.beats(clamp(Math.ceil(deficit / (0.45 * L)), 1, 4), Math.min(want * (1.12 + 0.2 * r()), VMAX * L));
  }

  // n full tail beats, ending as the tail crosses the midline
  beats(n, v) {
    const K9 = 6.3 * 0.9;
    return { v, end: Math.ceil((this.phase - K9 + n * TAU) / Math.PI) * Math.PI + K9, tmax: n * 2 + 1, amp: 0.85 + 0.3 * this.rand(), jit: 0.9 + 0.2 * this.rand() };
  }

  // ---------- integrate: turn about the pivot, move, stay in the water, rise and sink ----------
  move(dt, pond) {
    const L = this.len, g = this.g, pv = PIVOT * L, before = this.dir;
    const qx = this.x - Math.cos(this.dir) * pv, qy = this.y - Math.sin(this.dir) * pv;
    this.dir = wrap(this.dir + this.rate * dt);
    const c = Math.cos(this.dir), s = Math.sin(this.dir);
    this.x = qx + (c * this.speed - s * this.slip + this.px * 3) * dt + c * pv;
    this.y = qy + (s * this.speed + c * this.slip + this.py * 3) * dt + s * pv;
    this.turn += (wrap(this.dir - before) / dt - this.turn) * ease(15, dt);

    // never up onto the bank or into a rock, and not far past the edges of the view
    for (const k of [0.5, 0]) {
      const bx = this.x - c * k * L, by = this.y - s * k * L, m = (0.05 + 0.1 * k) * L * this.girth, sh = pond.shore(bx, by);
      if (sh < m) { const [gx, gy] = this.grad(pond, bx, by); this.x += gx * (m - sh); this.y += gy * (m - sh); }
      for (const st of pond.stones) {
        const ox = bx - st.x, oy = by - st.y, d = Math.hypot(ox, oy) || 1, r = st.r + 0.08 * L;
        if (d < r) { this.x += (ox / d) * (r - d); this.y += (oy / d) * (r - d); }
      }
    }
    this.x = Math.min(this.x, pond.w + 0.45 * L); this.y = Math.min(this.y, pond.h + 0.45 * L);

    // depth: rise and sink at a fish's pace; the nose follows the climb, and tips up to the surface
    const bed = pond.bedDepth(this.x, this.y);
    this.vz += (clamp((clamp(g.depth, 0.02, bed - 0.08) - this.depth) * 1.5, -g.vz, g.vz) - this.vz) * ease(3, dt);
    this.depth = clamp(this.depth + this.vz * dt, 0.02, Math.max(0.03, bed - 0.06));
    const up = g.pitch > 0 ? g.pitch * clamp(1 - this.depth / 0.3, 0, 1) : g.pitch;
    const climb = Math.atan2(-this.vz, Math.max(Math.abs(this.speed) / pond.ppm, 0.08)) * 0.7;
    this.pitch += (clamp(climb + up, -0.6, 0.7) - this.pitch) * ease(3, dt);

    // mouth: opens on a pellet, and works at the surface when begging, each gulp a small ring
    let m = g.mouth;
    if (this.gulpT > 0) { this.gulpT -= dt; m = 1; }
    if (g.gape && this.depth < 0.1) {
      const was = Math.sin(this.gapeP);
      this.gapeP += dt * TAU * g.hz;
      const now = Math.sin(this.gapeP);
      m = Math.max(m, g.gape * Math.max(0, now) ** 0.6);
      if (was < 0 && now >= 0 && this.depth < 0.06) pond.splash(this.x, this.y, -0.15 * g.gape, L * 0.035, true);
    }
    this.mouth = clamp(this.mouth + (m - this.mouth) * ease(m > this.mouth ? 12 : 6, dt), 0, 1);

    // the tail fin trails the peduncle's swing
    const pa = this.dir - (this.bendC + this.bendP) * 0.73 + this.flick(BODY);
    this.tl += (clamp((-wrap(pa - this.pa) / dt) * 0.06, -0.5, 0.5) - this.tl) * ease(10, dt);
    this.pa = pa;
  }

  flick(s) { return this.fla * smooth(0.3, 1, s) * Math.sin(Math.PI * clamp(this.flp * 1.15 - 0.15 * s, 0, 1)); }

  // ---------- input ----------
  onTouch(x, y, pond) {
    if (!this.sz) this.traits(pond);
    const L = this.len, d = this.reach(x, y);
    this.taps = this.taps * Math.exp(-(pond.time - this.tapAt) * 1.5) + 1; this.tapAt = pond.time;
    const close = 1 - d / (0.6 * L), shallow = 1 - this.depth / 0.4;
    // only a fish right under the finger and near the top bolts; a flurry of taps is a slap
    if (close > 0 && shallow > 0) return this.startle(x, y, (0.5 + 0.6 * close * shallow) * (1.25 - 0.3 * this.sz));
    if (this.taps > 2.5 && d < 3 * L) return this.startle(x, y, 0.6 * (1 - d / (3 * L)));
    // the rest have learned a tap may be food
    if (d < 4 * L && this.mode !== 'flee' && this.rand() < (0.55 + 0.4 * this.bold - this.wary) * (this.mode === 'rest' ? 0.4 : 1)) {
      this.cur = { x, y, a: Math.atan2(y - this.y, x - this.x), delay: this.latency(x, y) * 0.6, T: 10, hover: 2 + 2 * this.rand() };
    }
  }

  onDrag(x0, y0, x1, y1, pond) {
    if (!this.sz) this.traits(pond);
    this.dragLen += Math.hypot(x1 - x0, y1 - y0);
    for (const k of [0, 0.35, 0.7]) {
      const [d, nx, ny] = nearest(this.x - Math.cos(this.dir) * k * this.len, this.y - Math.sin(this.dir) * k * this.len, x0, y0, x1, y1);
      if (d < this.dragNear) { this.dragNear = d; this.dragX = nx; this.dragY = ny; }
    }
  }

  // A finger resting on the water: someone leaning over the edge.
  onHold(x, y, dt, pond) {
    const h = (this.hold ??= { x, y, at: -9, dur: 0 });
    if (h.at === pond.time) { // two fingers: heed the nearer
      if (Math.hypot(x - this.x, y - this.y) < Math.hypot(h.x - this.x, h.y - this.y)) { h.x = x; h.y = y; }
      return;
    }
    if (pond.time - h.at > 0.3 || Math.hypot(x - h.x, y - h.y) > 0.5 * pond.ppm * Math.max(dt, 1 / 60) + 2) h.dur = 0;
    h.dur += dt; h.x = x; h.y = y; h.at = pond.time;
  }

  // distance from (x, y) to the fish's body
  reach(x, y) {
    const b = 0.85 * this.len;
    return nearest(x, y, this.x, this.y, this.x - Math.cos(this.dir) * b, this.y - Math.sin(this.dir) * b)[0];
  }

  startle(x, y, s) {
    if (s < 0.12) return;
    this.wary = Math.min(1, this.wary + 0.5 * s); this.wx = x; this.wy = y;
    if (this.mode === 'flee' && s < this.fear + 0.2) { this.fear = Math.max(this.fear, s); return; }
    this.fear = Math.max(this.fear, s); this.cur = null;
    this.setMode('flee');
    // C-start: whip round away from it, then bolt
    const L = this.len, cx = this.x - Math.cos(this.dir) * 0.4 * L, cy = this.y - Math.sin(this.dir) * 0.4 * L;
    const d = wrap(Math.atan2(cy - y, cx - x) + (this.rand() - 0.5) * 0.7 - this.dir);
    this.turnStart(Math.sign(d || 1) * clamp(Math.abs(d), 0.9, 2.6), 2, 0);
  }

  // Spine from snout to tail tip as [x, y, angle] triples (angle points tailward); z scales the fish.
  // Planar: the renderer foreshortens for pitch.
  spine(nb, nt, out, z = 1) {
    const L = this.len * z, n = nb + nt, K = 6.3, sw = this.swim, ph = this.phase, bend = this.bendC + this.bendP;
    let x = this.x, y = this.y, lat = 0, mw = 0, my = 0;
    for (let i = 0; i <= n; i++) {
      const s = i <= nb ? (i / nb) * BODY : BODY + ((i - nb) / nt) * (1 - BODY), u = Math.max(0, (s - BODY) / (1 - BODY));
      // a travelling wave that grows toward the tail (the head barely moves); the tail fin lags the peduncle
      const wave = sw * ((0.012 + 0.28 * s ** 2.5) * Math.sin(ph - K * s) + 0.3 * u * Math.sin(ph - K * s - 1.2));
      const fl = this.flick(s);
      // C-bend: even curvature behind the head
      const a = this.dir + Math.PI - bend * clamp((s - 0.1) / 0.9, 0, 1) + wave + fl + this.tl * u;
      out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = a;
      const m = s > BODY ? 0 : s < 0.3 ? 0.5 + s / 0.6 : 1 - (s - 0.3) / 0.5;
      mw += m; my += m * lat;
      if (i < n) {
        const ds = (i < nb ? BODY / nb : (1 - BODY) / nt) * L;
        x += Math.cos(a) * ds; y += Math.sin(a) * ds; lat += (wave + fl) * ds;
      }
    }
    // recoil: the body swings about its centre of mass, so the snout sways a little against the tail
    const sh = my / mw, hx = Math.cos(this.dir), hy = Math.sin(this.dir);
    for (let i = 0; i <= n; i++) { out[i * 3] -= sh * hy; out[i * 3 + 1] += sh * hx; }
    return out;
  }
}
