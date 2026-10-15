import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pond } from './pond.js';

test('koi stay in the water through a minute of touches, food and a rotation', () => {
  const pond = new Pond(390, 844, 3);
  for (let i = 0; i < 3600; i++) {
    if (i % 300 === 0) pond.touch(pond.w * (0.3 + 0.6 * pond.rand()), pond.h * (0.3 + 0.6 * pond.rand()));
    if (i === 900) pond.feed();
    if (i === 1800) pond.resize(844, 390);
    pond.update(1 / 60);
  }
  for (const k of pond.koi) {
    for (const v of [k.x, k.y, k.dir, k.speed, k.depth]) assert.ok(Number.isFinite(v));
    assert.ok(pond.shore(k.x, k.y) > 0, 'not on the bank');
    assert.ok(k.x < pond.w + k.len && k.y < pond.h + k.len, 'not far off-screen');
    assert.ok(k.depth > 0 && k.depth < pond.bedDepth(k.x, k.y), 'between surface and bed');
    for (const r of pond.stones) assert.ok(Math.hypot(k.x - r.x, k.y - r.y) > r.r * 0.9, 'not inside a rock');
  }
  assert.ok(pond.water.height.every(Number.isFinite));
  assert.ok(pond.food.length < 32, 'koi ate');
});

test('the bed is a shallow shelf by the banks and a deep basin beyond', () => {
  const pond = new Pond(390, 844, 5);
  assert.ok(pond.bedDepth(pond.bank.left + 4, 400) < 0.4);
  assert.ok(pond.bedDepth(300, 700) > 1.3);
  assert.ok(pond.shore(2, 400) < 0 && pond.shore(300, 2) < 0, 'bank along the left and top');
});
