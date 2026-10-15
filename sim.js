// The pond surface: linear water waves on a grid, with capillary dispersion so a touch rings out as a
// train of fine rings rather than one soft bump. Grid units are cells; the caller maps pixels to cells.

const C2 = 0.34;      // wave speed squared (cells²/step²)
const DISP = 0.015;   // capillary term: short waves outrun long ones, as on a real pond (unstable above ~0.025)
const VISC = 0.07;    // viscosity: damps short waves much faster than long ones
const DAMP = 0.9965;  // per-step damping: ripples fade over a couple of seconds
const SETTLE = 0.9995; // pulls the surface back to rest so it never drifts

export class Water {
  constructor(w, h) {
    this.w = w; this.h = h; this.s = w + 2;
    const n = this.s * (h + 2);
    this.height = new Float32Array(n);
    this.vel = new Float32Array(n);
    this.next = new Float32Array(n);
    this.lap = new Float32Array(n);
    this.mask = new Float32Array(n).fill(1); // 0 pins the surface (rock, bank); below 1 soaks waves up (open edges)
  }

  // Impulse centred on grid coords (gx, gy); radius in cells. Negative pushes the surface down.
  // ring: a Mexican hat (down in the middle, up around it), the dent a fingertip or a pellet makes.
  disturb(gx, gy, radius, amount, ring = false) {
    const { w, h, s, vel } = this, reach = radius * 2.5, k = 1 / (radius * radius);
    const x0 = Math.max(0, Math.floor(gx - reach)), x1 = Math.min(w - 1, Math.ceil(gx + reach));
    const y0 = Math.max(0, Math.floor(gy - reach)), y1 = Math.min(h - 1, Math.ceil(gy + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - gx, dy = y + 0.5 - gy, r2 = (dx * dx + dy * dy) * k;
        vel[(y + 1) * s + x + 1] += amount * (ring ? 1 - r2 : 1) * Math.exp(-r2);
      }
    }
  }

  // Something standing in the water over a disc (grid units): the surface is held still there.
  block(gx, gy, r) {
    for (let y = Math.max(0, Math.floor(gy - r)); y <= Math.min(this.h - 1, Math.ceil(gy + r)); y++) {
      for (let x = Math.max(0, Math.floor(gx - r)); x <= Math.min(this.w - 1, Math.ceil(gx + r)); x++) {
        if ((x + 0.5 - gx) ** 2 + (y + 0.5 - gy) ** 2 < r * r) this.pin(x, y);
      }
    }
  }

  pin(x, y) {
    const i = (y + 1) * this.s + x + 1;
    this.mask[i] = this.height[i] = this.vel[i] = 0;
  }

  // Waves leaving through the right and bottom edges (the pond goes on beyond the screen) are absorbed.
  sponge(cells) {
    const { w, h, s, mask } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.min(w - 1 - x, h - 1 - y);
        if (d < cells) mask[(y + 1) * s + x + 1] *= 1 - 0.08 * (1 - d / cells) ** 2;
      }
    }
  }

  // Mirror the edge cells into the 1-cell border, so walls reflect.
  mirror(A) {
    const { w, h, s } = this, b = (h + 1) * s;
    for (let x = 1; x <= w; x++) { A[x] = A[s + x]; A[b + x] = A[b - s + x]; }
    for (let y = 0; y <= h + 1; y++) { A[y * s] = A[y * s + 1]; A[y * s + w + 1] = A[y * s + w]; }
  }

  step() {
    const { w, h, s, height: H, vel: V, next: N, lap: Lp, mask: M } = this;
    this.mirror(H);
    for (let y = 1; y <= h; y++) {
      for (let i = y * s + 1, e = i + w; i < e; i++) {
        // isotropic 9-point Laplacian keeps rings round instead of squarish
        Lp[i] = (4 * (H[i - 1] + H[i + 1] + H[i - s] + H[i + s])
          + H[i - s - 1] + H[i - s + 1] + H[i + s - 1] + H[i + s + 1] - 20 * H[i]) / 6;
      }
    }
    this.mirror(Lp);
    for (let y = 1; y <= h; y++) {
      for (let i = y * s + 1, e = i + w; i < e; i++) {
        N[i] = (V[i] + C2 * Lp[i] - DISP * (Lp[i - 1] + Lp[i + 1] + Lp[i - s] + Lp[i + s] - 4 * Lp[i])
          + VISC * (V[i - 1] + V[i + 1] + V[i - s] + V[i + s] - 4 * V[i])) * DAMP * M[i];
      }
    }
    for (let y = 1; y <= h; y++) {
      for (let i = y * s + 1, e = i + w; i < e; i++) H[i] = (H[i] + N[i]) * SETTLE * M[i];
    }
    this.vel = N; this.next = V;
  }

  idx(gx, gy) {
    const x = Math.min(this.w - 1, Math.max(0, Math.floor(gx))), y = Math.min(this.h - 1, Math.max(0, Math.floor(gy)));
    return (y + 1) * this.s + x + 1;
  }

  // Surface slope (height per cell) at grid coords.
  slope(gx, gy, out) {
    const i = this.idx(gx, gy), H = this.height;
    out[0] = (H[i + 1] - H[i - 1]) / 2;
    out[1] = (H[i + this.s] - H[i - this.s]) / 2;
    return out;
  }
}
