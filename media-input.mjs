import { Input, ALL_FORMATS, BlobSource } from './vendor/mediabunny.min.mjs';

export function createMediaInput(file) {
  // Browser Blob streams can fail with "network error" even for local files.
  // Use Mediabunny's bounded slice/arrayBuffer reader for inspection and every
  // compression pass. This avoids the stream path without buffering the whole
  // video in memory. See https://mediabunny.dev/api/BlobSourceOptions.
  return new Input({
    source: new BlobSource(file, { useStreamReader: false }),
    formats: ALL_FORMATS,
  });
}
