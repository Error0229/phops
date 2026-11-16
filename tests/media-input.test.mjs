import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaInput } from '../media-input.mjs';
import {
  Input, ALL_FORMATS, BlobSource, Output, BufferTarget, WavOutputFormat, Conversion,
} from '../vendor/mediabunny.min.mjs';

// A valid one-second PCM file: exercises the real bundled demuxer and converter
// without requiring a browser's hardware codecs or downloading any fixture.
function wave() {
  const dataSize = 48000 * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => bytes.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true); view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, dataSize, true);
  return bytes;
}

// Simulate the browser's Blob stream failing while ordinary slice reads work.
class BrokenStreamBlob extends Blob {
  slice(...args) { return new BrokenStreamBlob([super.slice(...args)]); }
  stream() {
    return new ReadableStream({ start(controller) { controller.error(new TypeError('network error')); } });
  }
}

test('reproduces the misleading network error in the old local stream reader', async () => {
  const input = new Input({ source: new BlobSource(new BrokenStreamBlob([wave()])), formats: ALL_FORMATS });
  try {
    await assert.rejects(input.computeDuration(), /network error/);
  } finally {
    input.dispose();
  }
});

test('inspection and repeated conversions work with broken streams and no network', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const file = new BrokenStreamBlob([wave()]);
  const inspection = createMediaInput(file);
  try {
    assert.equal(await inspection.computeDuration(), 1);
    assert.equal((await inspection.getPrimaryAudioTrack()).sampleRate, 48000);
  } finally {
    inspection.dispose();
  }

  // Each compression pass creates a new input over the same selected file.
  for (let pass = 0; pass < 3; pass++) {
    const input = createMediaInput(file);
    const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
    try {
      const conversion = await Conversion.init({ input, output });
      assert.equal(conversion.isValid, true);
      await conversion.execute();
      assert.ok(output.target.buffer.byteLength >= 96000);
      const result = createMediaInput(new Blob([output.target.buffer]));
      try { assert.equal(await result.computeDuration(), 1); } finally { result.dispose(); }
    } finally {
      input.dispose();
    }
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('unreadable files still surface an error instead of a successful empty result', async () => {
  class UnreadableBlob extends Blob {
    slice(...args) { return new UnreadableBlob([super.slice(...args)]); }
    async arrayBuffer() { throw new DOMException('File is no longer available', 'NotReadableError'); }
  }
  const input = createMediaInput(new UnreadableBlob([wave()]));
  try {
    await assert.rejects(input.computeDuration(), { name: 'NotReadableError' });
  } finally {
    input.dispose();
  }
});
