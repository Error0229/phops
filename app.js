import {
  Input, Output, Conversion, ALL_FORMATS, BlobSource, BufferTarget,
  Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat, MovOutputFormat,
  Quality, canEncodeVideo, canEncodeAudio, ConversionCanceledError,
} from 'mediabunny';

const $ = (id) => document.getElementById(id);
const MB = 1_000_000; // decimal MB: stays under the limit whichever way an app counts

const CODECS = {
  avc:  { label: 'H.264 – plays everywhere', minBpp: 0.050, eff: 1.00, qMax: 51 },
  hevc: { label: 'H.265 / HEVC – smaller',   minBpp: 0.035, eff: 0.70, qMax: 51 },
  vp9:  { label: 'VP9',                      minBpp: 0.035, eff: 0.70, qMax: 63 },
  av1:  { label: 'AV1 – smallest, slow',     minBpp: 0.030, eff: 0.60, qMax: 63 },
  vp8:  { label: 'VP8',                      minBpp: 0.060, eff: 1.15, qMax: 63 },
};
const CONTAINERS = {
  mp4:  { label: 'MP4',  make: () => new Mp4OutputFormat(),  audio: ['aac', 'opus'] },
  mov:  { label: 'MOV',  make: () => new MovOutputFormat(),  audio: ['aac'] },
  webm: { label: 'WebM', make: () => new WebMOutputFormat(), audio: ['opus'] },
  mkv:  { label: 'MKV',  make: () => new MkvOutputFormat(),  audio: ['opus', 'aac'] },
};
const LADDER = [2160, 1440, 1080, 720, 540, 480, 360, 240, 144];
const DISCARD_REASONS = {
  discarded_by_user: 'removed',
  max_track_count_reached: 'the format cannot hold more tracks',
  max_track_count_of_type_reached: 'the format cannot hold more tracks of this type',
  unknown_source_codec: 'unknown codec',
  undecodable_source_codec: 'this device cannot decode it',
  no_encodable_target_codec: 'this device cannot encode the chosen codec',
};

const state = {
  file: null, info: null, srcUrl: null, outUrl: null, outFile: null,
  mode: 'size', quality: 'medium', supported: {}, conversion: null, canceled: false,
  wakeLock: null, aacRegistered: false, busy: false,
};

/* ---------- helpers ---------- */

const fmtSize = (bytes) => {
  if (bytes >= 1000 * MB) return (bytes / (1000 * MB)).toFixed(2) + ' GB';
  if (bytes >= 100 * MB) return (bytes / MB).toFixed(0) + ' MB';
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1000)) + ' KB';
};
const fmtTime = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
const fmtKbps = (bps) => bps >= 1e6 ? (bps / 1e6).toFixed(2) + ' Mbps' : Math.round(bps / 1000) + ' kbps';
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const parseTime = (str) => {
  str = String(str || '').trim();
  if (!str) return null;
  const parts = str.split(':').map((p) => parseFloat(p.replace(',', '.')));
  if (parts.some((p) => !isFinite(p) || p < 0)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
};
const show = (el, on = true) => { el.hidden = !on; };
const showError = (msg) => { $('error').textContent = msg; show($('error'), !!msg); };

function saveSettings() {
  try {
    localStorage.setItem('phops', JSON.stringify({
      mode: state.mode, quality: state.quality, sizeMB: $('sizeMB').value, percent: $('percent').value,
      crf: $('crf').value, kbps: $('kbps').value, codec: $('codec').value, container: $('container').value,
      audio: $('audio').value, channels: $('channels').value, strict: $('strict').checked,
      rc: $('rc').value, hw: $('hw').value, kf: $('kf').value,
    }));
  } catch {}
}
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('phops')) || {}; } catch { return {}; }
}

/* ---------- capability detection ---------- */

async function detect() {
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) {
    const why = window.isSecureContext
      ? 'This browser does not support on-device video encoding (WebCodecs). Update your browser – Chrome, Edge, Samsung Internet, or Safari 17+.'
      : 'Video encoding only works over HTTPS. Open this page from its https:// address.';
    $('unsupported').textContent = why;
    show($('unsupported'));
    $('pickBtn').disabled = true;
    return;
  }
  const entries = await Promise.all(Object.keys(CODECS).map(async (c) => {
    try { return [c, await canEncodeVideo(c, { width: 1280, height: 720 })]; } catch { return [c, false]; }
  }));
  state.supported = Object.fromEntries(entries);
  const sel = $('codec');
  sel.innerHTML = '';
  for (const [c, ok] of entries) {
    const o = new Option(CODECS[c].label + (ok ? '' : ' (not on this device)'), c);
    o.disabled = !ok;
    sel.add(o);
  }
  const saved = loadSettings().codec;
  const first = entries.find(([, ok]) => ok)?.[0];
  if (!first) {
    $('unsupported').textContent = 'This device reports no usable video encoder.';
    show($('unsupported'));
    return;
  }
  sel.value = state.supported[saved] ? saved : first;
  fillContainers();
}

function fillContainers() {
  const codec = $('codec').value;
  const sel = $('container');
  const prev = sel.value || loadSettings().container;
  sel.innerHTML = '';
  for (const [key, c] of Object.entries(CONTAINERS)) {
    if (c.make().getSupportedVideoCodecs().includes(codec)) sel.add(new Option(c.label, key));
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  // keep the CRF slider at the same relative quality when the codec's scale changes (0–51 vs 0–63)
  const crf = $('crf');
  const oldMax = +crf.max, newMax = CODECS[codec].qMax;
  if (oldMax !== newMax) {
    const v = Math.round(+crf.value * newMax / oldMax);
    crf.max = newMax;
    crf.min = Math.round(10 * newMax / 51);
    crf.value = v;
  }
  $('crfOut').textContent = crf.value;
}

/* ---------- loading a file ---------- */

async function loadFile(file) {
  showError('');
  resetOutput();
  state.file = file;
  state.info = null;
  show($('doneCard'), false);
  let input;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('No video track found in this file.');
    const at = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    let fps = 30, vBps = 0, aBps = 0;
    try { const st = await vt.computePacketStats(120); fps = st.averagePacketRate || 30; vBps = st.averageBitrate || 0; } catch {}
    if (at) { try { aBps = (await at.computePacketStats(120)).averageBitrate || 0; } catch {} }
    if (!(duration > 0.05)) throw new Error('The video appears to be empty.');
    if (!isFinite(fps) || fps < 1) fps = 30;
    fps = Math.min(fps, 240);
    state.info = {
      duration, fps, vBps, aBps, size: file.size,
      width: vt.displayWidth, height: vt.displayHeight, codec: vt.codec,
      hasAudio: !!at, aCodec: at?.codec || null, channels: at?.numberOfChannels || 0, sampleRate: at?.sampleRate || 0,
      decodable: await vt.canDecode().catch(() => true),
    };
  } catch (e) {
    console.error(e);
    showError('Could not read this file: ' + (e?.message || e));
    return;
  } finally {
    input?.dispose();
  }

  const i = state.info;
  if (state.srcUrl) URL.revokeObjectURL(state.srcUrl);
  state.srcUrl = URL.createObjectURL(file);
  const v = $('srcVideo');
  v.src = state.srcUrl;
  v.onloadedmetadata = () => { try { v.currentTime = Math.min(0.5, i.duration / 2); } catch {} };
  $('srcName').textContent = file.name || 'video';
  $('srcSize').textContent = fmtSize(i.size);
  $('srcFacts').textContent = [
    `${i.width}×${i.height}`, `${Math.round(i.fps)} fps`, fmtTime(i.duration),
    (i.codec || '?').toUpperCase(), i.hasAudio ? null : 'no audio',
  ].filter(Boolean).join(' · ');

  fillSourceDependent();
  show($('pickCard'), false);
  show($('srcCard'));
  show($('setCard'));
  if (!i.decodable) showError(`This device cannot decode the video's codec (${i.codec || 'unknown'}), so it cannot be compressed here.`);
  updatePlan();
}

function fillSourceDependent() {
  const i = state.info;
  const short = Math.min(i.width, i.height);
  const res = $('res');
  res.innerHTML = '';
  res.add(new Option('Auto', 'auto'));
  res.add(new Option(`Original (${short}p)`, 'orig'));
  for (const p of LADDER) if (p < short) res.add(new Option(p + 'p', p));
  const fps = $('fps');
  fps.innerHTML = '';
  fps.add(new Option('Auto', 'auto'));
  fps.add(new Option(`Original (${Math.round(i.fps)})`, 'orig'));
  for (const f of [60, 30, 24, 15, 10]) if (f < i.fps - 1) fps.add(new Option(f + ' fps', f));
  $('trimStart').value = '';
  $('trimEnd').value = '';
  $('audio').disabled = $('channels').disabled = !i.hasAudio;
}

/* ---------- planning: settings -> concrete encoder parameters ---------- */

function computePlan(audioOverride, videoScale = 1) {
  const i = state.info;
  const codec = $('codec').value, cinfo = CODECS[codec];
  const container = $('container').value;
  const mode = state.mode;
  const notes = [];
  let blocker = null;

  // trim
  let start = parseTime($('trimStart').value) ?? 0;
  let end = parseTime($('trimEnd').value) ?? i.duration;
  start = Math.min(Math.max(0, start), i.duration);
  end = Math.min(Math.max(0, end), i.duration);
  if (end - start < 0.1) { blocker = 'Trim range is empty.'; end = i.duration; start = 0; }
  const trimmed = start > 0.01 || end < i.duration - 0.01;
  const dur = end - start;

  // geometry
  const rotate = +$('rot').value;
  const swap = rotate === 90 || rotate === 270;
  const sw = swap ? i.height : i.width, sh = swap ? i.width : i.height;
  const short = Math.min(sw, sh);

  // audio
  let audioMode = audioOverride ?? $('audio').value;
  if (!i.hasAudio) audioMode = 'none';
  const channels = +$('channels').value || 0;

  // byte budget
  let targetBytes = null;
  if (mode === 'size') {
    const mb = parseFloat($('sizeMB').value);
    if (!(mb > 0)) blocker = 'Enter a target size.';
    else targetBytes = mb * MB;
  } else if (mode === 'percent') {
    targetBytes = i.size * (dur / i.duration) * (+$('percent').value / 100);
  }
  const totalBps = targetBytes ? (targetBytes * 8 / dur) * 0.965 : null; // headroom for container + encoder drift

  let audioBps = 0;
  if (audioMode === 'copy') audioBps = i.aBps || 128000;
  else if (audioMode === 'auto') {
    if (totalBps != null) audioBps = totalBps < 250e3 ? 32e3 : totalBps < 500e3 ? 48e3 : totalBps < 1000e3 ? 64e3 : totalBps < 2500e3 ? 96e3 : 128e3;
    else audioBps = mode === 'quality' && (state.quality === 'very-low' || state.quality === 'low') ? 64e3 : 128e3;
    if (i.aBps && i.aBps < audioBps && i.aBps > 16e3) audioBps = Math.max(32e3, Math.round(i.aBps / 8000) * 8000);
  } else if (audioMode !== 'none') audioBps = +audioMode * 1000;
  if (channels === 1 && audioMode !== 'copy' && audioBps > 96e3) audioBps = 96e3;

  // video bitrate
  let videoBps = null;
  if (totalBps != null) {
    videoBps = totalBps - audioBps;
    if (videoBps < 40e3) {
      blocker = blocker || `That size is too small for ${fmtTime(dur)} of video${audioBps ? ' with audio – try removing the audio, or' : ' –'} trim it or pick a bigger size.`;
      videoBps = 40e3;
    }
  } else if (mode === 'bitrate') {
    const k = parseFloat($('kbps').value);
    if (!(k > 0)) blocker = 'Enter a bitrate.';
    videoBps = Math.max(40, k || 0) * 1000;
  }
  if (videoBps != null) videoBps *= videoScale;

  // frame rate
  const fpsSel = $('fps').value;
  let fps = i.fps || 30, fpsSet = false;
  if (fpsSel !== 'auto' && fpsSel !== 'orig') { fps = +fpsSel; fpsSet = true; }
  else if (fpsSel === 'auto' && videoBps != null && i.fps > 32 && videoBps / (sw * sh * i.fps) < cinfo.minBpp) { fps = 30; fpsSet = true; }

  // resolution
  const resSel = $('res').value;
  let outShort = short;
  if (resSel === 'auto') {
    if (videoBps != null) {
      const fits = (p) => videoBps / ((sw * p / short) * (sh * p / short) * fps) >= cinfo.minBpp;
      const steps = [short, ...LADDER.filter((p) => p < short)];
      outShort = steps.find(fits) ?? Math.max(steps[steps.length - 1], Math.min(short, 240));
    }
  } else if (resSel !== 'orig') outShort = +resSel;
  const k = outShort / short;
  const width = k >= 1 ? even(sw) : even(sw * k), height = k >= 1 ? even(sh) : even(sh * k);

  // quality object
  const bitrateMode = $('rc').value;
  let quality, rateLabel, estBytes = null;
  if (mode === 'quality') {
    quality = new Quality({ quality: state.quality, preferBitrate: true, bitrateMode });
    rateLabel = 'auto · ' + state.quality.replace('-', ' ');
  } else if (mode === 'crf') {
    const q = +$('crf').value;
    const q51 = q * 51 / cinfo.qMax;
    const fallback = Math.max(80e3, width * height * fps * 0.1 * cinfo.eff * Math.pow(2, (23 - q51) / 6));
    quality = new Quality({ quantizer: q, bitrate: Math.round(fallback), bitrateMode });
    rateLabel = `CRF ${q} (or ~${fmtKbps(fallback)})`;
  } else {
    quality = new Quality({ bitrate: Math.round(videoBps), bitrateMode });
    rateLabel = fmtKbps(videoBps);
    estBytes = (videoBps + audioBps) * dur / 8 / 0.985;
  }

  if (targetBytes && targetBytes >= i.size * (dur / i.duration)) notes.push('The video is already smaller than that – the result may come out bigger than the original.');
  else if (videoBps != null && videoBps / (width * height * fps) < cinfo.minBpp * 0.45) notes.push('Very tight budget for this length – expect a soft, blocky picture. Trimming, removing audio, or H.265/AV1 will help.');
  if (mode === 'size' && +$('sizeMB').value && audioMode === 'copy') notes.push('“Keep original” audio takes a fixed chunk of the budget.');

  return {
    codec, container, mode, start, end, trimmed, dur, rotate, width, height, fps, fpsSet, audioMode, audioBps, channels,
    videoBps, quality, rateLabel, estBytes, targetBytes, notes, blocker,
    strict: mode === 'size' && $('strict').checked,
    hw: $('hw').value, kf: +$('kf').value,
  };
}

function updatePlan() {
  if (!state.info) return;
  const p = computePlan();
  const rows = [
    ['Video', `${p.width}×${p.height} · ${Math.round(p.fps)} fps · ${p.codec.toUpperCase()}`],
    ['Video rate', p.rateLabel],
    ['Audio', p.audioMode === 'none' ? 'none' : p.audioMode === 'copy' ? 'original' + (p.audioBps ? ` (~${fmtKbps(p.audioBps)})` : '') : fmtKbps(p.audioBps)],
    ['Length', fmtTime(p.dur) + (p.trimmed ? ' (trimmed)' : '')],
    ['Expected size', p.estBytes ? '≈ ' + fmtSize(p.targetBytes ? Math.min(p.estBytes, p.targetBytes) : p.estBytes) : 'depends on content'],
  ];
  $('plan').innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
  const warn = p.blocker || p.notes.join(' ');
  $('warn').textContent = warn;
  show($('warn'), !!warn);
  $('goBtn').disabled = !!p.blocker || !state.info.decodable || state.busy;
  saveSettings();
}

/* ---------- encoding ---------- */

async function pickAudioCodec(plan) {
  const wanted = CONTAINERS[plan.container].audio;
  // Check against the real parameters: native AAC encoders often refuse low bitrates (Chrome: < 96 kbps).
  const opts = {
    numberOfChannels: plan.channels || state.info.channels || 2,
    sampleRate: state.info.sampleRate || 48000,
    bitrate: plan.audioBps,
  };
  const can = (c) => state.aacRegistered && c === 'aac' ? true : canEncodeAudio(c, opts).catch(() => false);
  if (await can(wanted[0])) return wanted[0];
  if (wanted.includes('aac')) {
    // No suitable native AAC encoder (also Firefox, older Safari): use the bundled WASM one.
    if (!state.aacRegistered) {
      const { registerAacEncoder } = await import('./vendor/mediabunny-aac-encoder.min.mjs');
      registerAacEncoder();
      state.aacRegistered = true;
    }
    return 'aac';
  }
  return null;
}

async function buildConversion(plan, audioMode, hw) {
  const input = new Input({ source: new BlobSource(state.file), formats: ALL_FORMATS });
  const format = CONTAINERS[plan.container].make();
  const output = new Output({ format, target: new BufferTarget() });

  const video = {
    codec: plan.codec, width: plan.width, height: plan.height, fit: 'fill',
    quality: plan.quality, keyFrameInterval: plan.kf, hardwareAcceleration: hw, forceTranscode: true,
  };
  if (plan.fpsSet) video.frameRate = plan.fps;
  if (plan.rotate) video.rotate = plan.rotate;

  let audio;
  if (audioMode === 'none') audio = { discard: true };
  else if (audioMode === 'copy') audio = {};
  else {
    const codec = await pickAudioCodec(plan);
    audio = { codec: codec || undefined, quality: new Quality({ bitrate: plan.audioBps }), forceTranscode: true };
    if (plan.channels) audio.numberOfChannels = plan.channels;
  }

  const conversion = await Conversion.init({
    input, output, video, audio, tracks: 'primary', showWarnings: false,
    trim: plan.trimmed ? { start: plan.start, end: plan.end } : undefined,
  });
  return { conversion, input, output, format };
}

const lost = (conv, type) => conv.discardedTracks.find((d) => d.track.type === type && d.reason !== 'discarded_by_user');

async function encodeOnce(videoScale, onProgress) {
  let plan, built;
  const messages = [];
  // Try the requested audio handling first, then fall back: transcode -> copy -> drop.
  const requested = computePlan(undefined, videoScale).audioMode;
  const chain = requested === 'none' ? ['none'] : requested === 'copy' ? ['copy', 'none'] : [requested, 'copy', 'none'];
  for (const audioMode of chain) {
    plan = computePlan(audioMode, videoScale);
    let hw = plan.hw;
    built = await buildConversion(plan, audioMode, hw);
    if (lost(built.conversion, 'video') && hw !== 'no-preference') {
      built.input.dispose();
      hw = 'no-preference';
      built = await buildConversion(plan, audioMode, hw);
      if (!lost(built.conversion, 'video')) messages.push('The chosen encoder type is not available for this codec – used the automatic one.');
    }
    const v = lost(built.conversion, 'video');
    if (v) {
      built.input.dispose();
      throw new Error(`The video track cannot be converted: ${DISCARD_REASONS[v.reason] || v.reason}. Try another codec.`);
    }
    if (!lost(built.conversion, 'audio')) {
      if (audioMode !== requested) {
        messages.push(audioMode === 'copy'
          ? 'Audio could not be re-encoded on this device – kept the original audio track instead.'
          : 'Audio could not be processed on this device, so the result has no sound.');
      }
      break;
    }
    built.input.dispose();
  }

  const { conversion, input, output, format } = built;
  if (!conversion.isValid) { input.dispose(); throw new Error('This combination of settings is not possible on this device.'); }
  state.conversion = conversion;
  conversion.onProgress = onProgress;
  try {
    await conversion.execute();
  } finally {
    state.conversion = null;
    input.dispose();
  }
  const blob = new Blob([output.target.buffer], { type: format.mimeType });
  return { blob, plan, format, messages };
}

async function run() {
  if (state.busy) return;
  state.busy = true;
  state.canceled = false;
  showError('');
  resetOutput();
  show($('setCard'), false);
  show($('doneCard'), false);
  show($('runCard'));
  setProgress(0, '');
  await acquireWakeLock();

  const t0 = performance.now();
  const maxPasses = 3;
  let scale = 1, best = null, pass = 1;
  try {
    for (;;) {
      const passStart = performance.now();
      $('runTitle').textContent = pass === 1 ? 'Compressing…' : `Over target – pass ${pass} of up to ${maxPasses}…`;
      const res = await encodeOnce(scale, (p, t) => {
        const el = (performance.now() - passStart) / 1000;
        const eta = p > 0.02 ? el * (1 - p) / p : null;
        setProgress(p, [eta != null ? fmtTime(eta) + ' left' : 'starting…', el > 1 && t ? (t / el).toFixed(1) + '× speed' : null].filter(Boolean).join(' · '));
      });
      if (!best || res.blob.size < best.blob.size) best = res;
      const target = res.plan.targetBytes;
      if (!res.plan.strict || res.blob.size <= target || pass >= maxPasses) break;
      // Overshot: shrink the video bitrate proportionally (audio + container stay fixed) and go again.
      const fixed = res.plan.audioBps * res.plan.dur / 8;
      scale *= Math.max(0.3, ((target - fixed) / Math.max(1, res.blob.size - fixed)) * 0.96);
      pass++;
    }
    finish(best, (performance.now() - t0) / 1000, pass);
  } catch (e) {
    show($('runCard'), false);
    show($('setCard'));
    if (!(e instanceof ConversionCanceledError) && !state.canceled) {
      console.error(e);
      showError('Compression failed: ' + (e?.message || e));
    }
  } finally {
    state.busy = false;
    releaseWakeLock();
    updatePlan();
  }
}

function setProgress(p, sub) {
  const pct = Math.min(100, Math.floor(p * 100));
  $('runPct').textContent = pct + '%';
  $('barFill').style.width = pct + '%';
  $('runSub').textContent = sub || ' ';
}

function finish(res, seconds, passes) {
  const { blob, plan, format, messages } = res;
  const base = (state.file.name || 'video').replace(/\.[^.]+$/, '');
  const name = `${base}-phops${format.fileExtension}`;
  state.outFile = new File([blob], name, { type: format.mimeType });
  state.outUrl = URL.createObjectURL(blob);

  const before = state.info.size, after = blob.size;
  $('resBefore').textContent = fmtSize(before);
  $('resAfter').textContent = fmtSize(after);
  const delta = 1 - after / before;
  const saved = $('resSaved');
  saved.textContent = delta >= 0 ? `−${Math.round(delta * 100)}%` : `+${Math.round(-delta * 100)}%`;
  saved.classList.toggle('bad', delta < 0);
  $('outVideo').src = state.outUrl;
  $('resFacts').textContent = [
    `${plan.width}×${plan.height}`, plan.codec.toUpperCase() + ' ' + CONTAINERS[plan.container].label,
    `${after.toLocaleString()} bytes`, `took ${fmtTime(seconds)}` + (passes > 1 ? ` (${passes} passes)` : ''),
  ].join(' · ');

  const warns = [...new Set(messages)];
  if (plan.targetBytes && after > plan.targetBytes) {
    warns.unshift(`Ended up ${fmtSize(after - plan.targetBytes)} over the target – this phone's encoder would not go lower at this resolution. Pick a smaller resolution or frame rate and run again.`);
  }
  $('resWarn').textContent = warns.join(' ');
  show($('resWarn'), warns.length > 0);

  const save = $('saveBtn');
  save.href = state.outUrl;
  save.download = name;
  let canShare = false;
  try { canShare = !!navigator.canShare?.({ files: [state.outFile] }); } catch {}
  show($('shareBtn'), canShare);

  show($('runCard'), false);
  show($('doneCard'));
  $('doneCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { navigator.vibrate?.(60); } catch {}
}

function resetOutput() {
  if (state.outUrl) URL.revokeObjectURL(state.outUrl);
  state.outUrl = null;
  state.outFile = null;
  $('outVideo').removeAttribute('src');
  $('outVideo').load?.();
}

async function acquireWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.busy) acquireWakeLock();
});

/* ---------- UI wiring ---------- */

function setMode(mode) {
  state.mode = mode;
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.mode === mode);
  for (const m of document.querySelectorAll('.mode')) m.hidden = m.dataset.for !== mode;
  updatePlan();
}
function syncChips() {
  for (const b of $('sizeChips').children) b.classList.toggle('on', parseFloat($('sizeMB').value) === +b.dataset.mb);
}

function wire() {
  $('pickBtn').onclick = () => $('file').click();
  $('changeBtn').onclick = () => $('file').click();
  $('file').onchange = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadFile(f); };

  const pick = $('pickCard');
  addEventListener('dragover', (e) => { e.preventDefault(); pick.classList.add('over'); });
  addEventListener('dragleave', () => pick.classList.remove('over'));
  addEventListener('drop', (e) => {
    e.preventDefault();
    pick.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f && !state.busy) loadFile(f);
  });

  $('modeSeg').onclick = (e) => { const m = e.target.closest('button')?.dataset.mode; if (m) setMode(m); };
  $('qualitySeg').onclick = (e) => {
    const q = e.target.closest('button')?.dataset.q;
    if (!q) return;
    state.quality = q;
    for (const b of $('qualitySeg').children) b.classList.toggle('on', b.dataset.q === q);
    updatePlan();
  };
  $('sizeChips').onclick = (e) => {
    const mb = e.target.closest('button')?.dataset.mb;
    if (!mb) return;
    $('sizeMB').value = mb;
    syncChips();
    updatePlan();
  };
  $('sizeMB').oninput = () => { syncChips(); updatePlan(); };
  $('percent').oninput = () => { $('percentOut').textContent = $('percent').value + '%'; updatePlan(); };
  $('crf').oninput = () => { $('crfOut').textContent = $('crf').value; updatePlan(); };
  $('codec').onchange = () => { fillContainers(); updatePlan(); };
  for (const id of ['kbps', 'container', 'res', 'fps', 'audio', 'channels', 'trimStart', 'trimEnd', 'rc', 'hw', 'kf', 'rot', 'strict']) {
    $(id).addEventListener('input', updatePlan);
  }

  $('goBtn').onclick = run;
  $('cancelBtn').onclick = () => { state.canceled = true; state.conversion?.cancel(); };
  $('againBtn').onclick = () => { show($('doneCard'), false); show($('setCard')); $('setCard').scrollIntoView({ behavior: 'smooth' }); };
  $('newBtn').onclick = () => $('file').click();
  $('shareBtn').onclick = async () => {
    try { await navigator.share({ files: [state.outFile] }); } catch (e) { if (e?.name !== 'AbortError') showError('Sharing failed: ' + e.message); }
  };

  // restore settings
  const s = loadSettings();
  if (CODECS[s.codec]) { $('crf').max = CODECS[s.codec].qMax; $('crf').min = Math.round(10 * CODECS[s.codec].qMax / 51); } // saved CRF is on that codec's scale
  for (const id of ['sizeMB', 'percent', 'crf', 'kbps', 'audio', 'channels', 'rc', 'hw', 'kf']) if (s[id] != null) $(id).value = s[id];
  if (s.strict != null) $('strict').checked = s.strict;
  if (s.quality) { state.quality = s.quality; for (const b of $('qualitySeg').children) b.classList.toggle('on', b.dataset.q === s.quality); }
  $('percentOut').textContent = $('percent').value + '%';
  syncChips();
  if (s.mode) { state.mode = s.mode; for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.mode === s.mode); for (const m of document.querySelectorAll('.mode')) m.hidden = m.dataset.for !== s.mode; }
}

/* ---------- PWA bits ---------- */

async function pwa() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW registration failed', e); }
  }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; show($('installBtn')); });
  $('installBtn').onclick = async () => { await deferred?.prompt(); deferred = null; show($('installBtn'), false); };
  addEventListener('appinstalled', () => show($('installBtn'), false));
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS && !standalone) {
    $('installTip').textContent = 'To install: tap the Share button, then “Add to Home Screen”.';
    show($('installTip'));
  }

  // A video shared to the app from the gallery (Android share sheet) is stashed by the service worker.
  if (new URLSearchParams(location.search).has('shared')) {
    history.replaceState(null, '', location.pathname);
    try {
      const cache = await caches.open('phops-share');
      const hit = await cache.match('shared-file');
      if (hit) {
        const blob = await hit.blob();
        const name = decodeURIComponent(hit.headers.get('x-file-name') || 'shared-video');
        await cache.delete('shared-file');
        await loadFile(new File([blob], name, { type: blob.type }));
      }
    } catch (e) { console.warn(e); }
  }
}

wire();
await detect();
pwa();
