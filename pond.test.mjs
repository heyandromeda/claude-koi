import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Water, Pond } from './pond.js';

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
  w.disturb(40.5, 40.5, 3, -1);
  for (let i = 0; i < 60; i++) w.step();
  const at = (x, y) => w.height[w.idx(x, y)];
  assert.ok(Math.abs(at(40, 20) - at(40, 60)) < 1e-4);
  assert.ok(Math.abs(at(20, 40) - at(40, 20)) < 1e-4);
  const early = peak(w);
  for (let i = 0; i < 2000; i++) w.step();
  assert.ok(w.height.every(Number.isFinite));
  assert.ok(peak(w) < early * 0.05, 'energy dissipates');
});

test('koi stay in the pond through a minute of startles, food and a rotation', () => {
  const pond = new Pond(390, 844, 3);
  for (let i = 0; i < 3600; i++) {
    if (i % 300 === 0) pond.touch(pond.rand() * pond.w, pond.rand() * pond.h);
    if (i === 900) pond.feed();
    if (i === 1800) pond.resize(844, 390);
    pond.update(1 / 60);
  }
  for (const k of pond.koi) {
    for (const v of [k.x, k.y, k.dir, k.speed, k.depth]) assert.ok(Number.isFinite(v));
    assert.ok(k.x >= 0 && k.x <= pond.w && k.y >= 0 && k.y <= pond.h);
    for (const r of pond.stones) assert.ok(Math.hypot(k.x - r.x, k.y - r.y) > r.r * 0.9, 'not inside a rock');
  }
  assert.ok(pond.water.height.every(Number.isFinite));
  assert.ok(pond.food.length < 9, 'koi ate');
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
