// Measure video payload only. A short encode starts with a keyframe, so
// extrapolating its file size would charge that startup cost on every sample.
export async function projectedVideoRate(packets, duration, keyInterval) {
  let keyBytes = 0, keySeconds = 0, keyCount = 0;
  let deltaBytes = 0, deltaSeconds = 0, deltaCount = 0;
  for await (const packet of packets) {
    if (packet.type === 'key') {
      keyBytes += packet.byteLength;
      keySeconds += packet.duration;
      keyCount++;
    } else {
      deltaBytes += packet.byteLength;
      deltaSeconds += packet.duration;
      deltaCount++;
    }
  }
  if (!keyCount || deltaCount < 5 || deltaSeconds <= 0) return null;
  const keys = Math.ceil(duration / keyInterval);
  const secondsBetweenKeys = Math.max(0, duration - keys * keySeconds / keyCount);
  return 8 * (keys * keyBytes / keyCount + secondsBetweenKeys * deltaBytes / deltaSeconds) / duration;
}

export function calibratedScale(plan, measuredRate) {
  // Leave room for the muxer and for scenes the sample didn't include.
  const wanted = plan.targetBytes * 8 / plan.dur * 0.97 - plan.audioBps;
  // A quiet sample can underpredict the rest of the clip. Never ask for
  // more than the available video budget to compensate for that sample.
  return Math.max(0.85, Math.min(1.12, wanted / Math.max(plan.videoBps, measuredRate)));
}
