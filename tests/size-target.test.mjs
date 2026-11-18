import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibratedScale, projectedVideoRate } from '../size-target.mjs';

test('projects one keyframe per interval across the selected duration', async () => {
  const packets = [
    { type: 'key', byteLength: 5000, duration: 0.1 },
    ...Array.from({ length: 9 }, () => ({ type: 'delta', byteLength: 1000, duration: 0.1 })),
  ];
  // Twelve seconds at ten fps, with keyframes at 0, 5 and 10 seconds.
  const expected = (3 * 5000 + 117 * 1000) * 8 / 12;
  assert.ok(Math.abs(await projectedVideoRate(packets, 12, 5) - expected) < 1e-6);
  assert.equal(await projectedVideoRate(packets.slice(0, 2), 12, 5), null);
});

test('a quiet sample cannot spend the audio or container budget on video', () => {
  const plan = { targetBytes: 1_000_000, dur: 8, audioBps: 128_000, videoBps: 800_000 };
  const requested = plan.videoBps * calibratedScale(plan, 300_000);
  assert.equal(requested, 842_000);
  assert.ok(calibratedScale(plan, 900_000) < 1);
});
