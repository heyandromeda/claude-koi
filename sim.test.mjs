import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Water } from './sim.js';

// deviation from the mean: a uniform offset is flat water, invisible
const peak = w => {
  let sum = 0, max = 0;
  for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) sum += w.height[w.idx(x, y)];
  const mean = sum / (w.w * w.h);
  for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) max = Math.max(max, Math.abs(w.height[w.idx(x, y)] - mean));
  return max;
};

test('ripple spreads symmetrically, stays finite and dies out', () => {
  const w = new Water(81, 81);
  w.disturb(40.5, 40.5, 1.5, -1, true);
  for (let i = 0; i < 60; i++) w.step();
  const at = (x, y) => w.height[w.idx(x, y)];
  assert.ok(Math.abs(at(40, 20) - at(40, 60)) < 1e-4);
  assert.ok(Math.abs(at(20, 40) - at(40, 20)) < 1e-4);
  const early = peak(w);
  for (let i = 0; i < 2000; i++) w.step();
  assert.ok(w.height.every(Number.isFinite));
  assert.ok(peak(w) < early * 0.05, 'energy dissipates');
});

test('short waves outrun long ones (capillary dispersion)', () => {
  // a narrow dent sends its short-wave front out ahead of where a non-dispersive ring would be
  const w = new Water(161, 41);
  w.disturb(20.5, 20.5, 1.2, -1, true);
  for (let i = 0; i < 80; i++) w.step();
  let front = 0;
  for (let x = 160; x > 20; x--) if (Math.abs(w.height[w.idx(x, 20)]) > 1e-4) { front = x - 20.5; break; }
  assert.ok(front > Math.sqrt(0.34) * 80 * 1.05, `front at ${front} cells`);
});

test('a rock pins the surface and throws ripples back', () => {
  const free = new Water(60, 60), rock = new Water(60, 60);
  rock.block(40, 30, 5);
  for (const w of [free, rock]) {
    w.disturb(20.5, 30.5, 3, -1);
    for (let i = 0; i < 90; i++) w.step();
  }
  assert.equal(rock.height[rock.idx(40, 30)], 0);
  const echo = Math.abs(free.height[free.idx(28, 30)] - rock.height[rock.idx(28, 30)]);
  assert.ok(echo > 1e-3, `reflection reaches back (${echo})`);
});

test('the sponge edge soaks up waves instead of reflecting them', () => {
  const hard = new Water(120, 40), soft = new Water(120, 40);
  soft.sponge(14);
  for (const w of [hard, soft]) {
    w.disturb(90.5, 20.5, 2, -1, true);
    for (let i = 0; i < 260; i++) w.step();
  }
  assert.ok(peak(soft) < peak(hard) * 0.8, `${peak(soft)} vs ${peak(hard)}`);
});
