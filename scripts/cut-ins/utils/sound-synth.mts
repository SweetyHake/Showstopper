const AudioContext = typeof window !== 'undefined'
  ? (window.AudioContext || (window as any).webkitAudioContext)
  : null;

let _ctx = null;

function getAudioContext() {
  if (!AudioContext) return null;
  if (!_ctx) _ctx = new AudioContext();
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}

function getInterfaceVolume() {
  try {
    return game.settings.get("core", "globalInterfaceVolume") ?? 0.5;
  } catch {
    return 0.5;
  }
}

// Registry of active synthesized voices: allows muting everything at once
// when the user skips an intro (otherwise scheduled audio plays to the end).
const _activeVoices = new Set<any>();

function _registerVoice(master, stoppables, hardEndTimeSec) {
  const voice = {
    master,
    stoppables,
    timer: null
  };
  voice.timer = setTimeout(() => _activeVoices.delete(voice), hardEndTimeSec * 1000 + 500);
  _activeVoices.add(voice);
}

/**
 * Quickly fades out and stops all sounds synthesized by this module.
 */
export function stopAllSynthSounds() {
  for (const voice of [..._activeVoices]) {
    clearTimeout(voice.timer);
    _activeVoices.delete(voice);
    try { voice.onStop?.(); } catch { /* ignore */ }
    try {
      const ctx = voice.master.context;
      const t = ctx.currentTime;
      voice.master.gain.cancelScheduledValues(t);
      voice.master.gain.setValueAtTime(voice.master.gain.value, t);
      voice.master.gain.linearRampToValueAtTime(0.0001, t + 0.08);
      for (const node of voice.stoppables) {
        try { node.stop(t + 0.1); } catch (e) { /* already stopped */ }
      }
    } catch (e) { /* ignore */ }
  }
}

function getFinalVolume(volume) {
  return Math.max(0, volume) * getInterfaceVolume();
}

// Reverb impulse cache: AudioBuffers are immutable and reusable across any number
// of ConvolverNodes, whereas generating one allocates ~0.5–1MB stereo + hundreds of
// thousands of Math.random() calls per play (intros broadcast to ALL clients)
const _impulseCache = new Map();

function createReverb(ctx, duration = 2, decay = 3) {
  const rate = ctx.sampleRate;
  const key = `${duration}|${decay}|${rate}`;
  let impulse = _impulseCache.get(key);
  if (!impulse) {
    const length = rate * duration;
    impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    _impulseCache.set(key, impulse);
  }
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse;
  return convolver;
}

export function playDramaticImpact(volume = 0.6) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 3, 2);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.5;
  dry.connect(master);

  const wet = ctx.createGain();
  wet.gain.value = 0.6;
  wet.connect(reverb);

  const swoosh = ctx.createBufferSource();
  const sLen = ctx.sampleRate * 1.5;
  const sBuf = ctx.createBuffer(1, sLen, ctx.sampleRate);
  const sData = sBuf.getChannelData(0);
  for (let i = 0; i < sLen; i++) {
    sData[i] = (Math.random() * 2 - 1);
  }
  swoosh.buffer = sBuf;

  const swooshFilter = ctx.createBiquadFilter();
  swooshFilter.type = 'bandpass';
  swooshFilter.frequency.setValueAtTime(100, now);
  swooshFilter.frequency.exponentialRampToValueAtTime(600, now + 0.4);
  swooshFilter.frequency.exponentialRampToValueAtTime(150, now + 1.2);
  swooshFilter.Q.value = 1.5;

  const swooshEnv = ctx.createGain();
  swooshEnv.gain.setValueAtTime(0, now);
  swooshEnv.gain.linearRampToValueAtTime(0.35, now + 0.3);
  swooshEnv.gain.exponentialRampToValueAtTime(0.001, now + 1.5);

  swoosh.connect(swooshFilter);
  swooshFilter.connect(swooshEnv);
  swooshEnv.connect(dry);
  swooshEnv.connect(wet);
  swoosh.start(now);

  const tone = ctx.createOscillator();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(120, now + 0.2);
  tone.frequency.exponentialRampToValueAtTime(80, now + 2.5);

  const toneEnv = ctx.createGain();
  toneEnv.gain.setValueAtTime(0, now + 0.2);
  toneEnv.gain.linearRampToValueAtTime(0.25, now + 0.4);
  toneEnv.gain.exponentialRampToValueAtTime(0.001, now + 2.5);

  tone.connect(toneEnv);
  toneEnv.connect(dry);
  toneEnv.connect(wet);
  tone.start(now + 0.2);
  tone.stop(now + 3);

  _registerVoice(master, [swoosh, tone], 3);
}

export function playMelodicChime(volume = 0.5) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 2.5, 2.5);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.4;
  dry.connect(master);

  const wet = ctx.createGain();
  wet.gain.value = 0.5;
  wet.connect(reverb);

  const noise = ctx.createBufferSource();
  const nLen = ctx.sampleRate * 0.6;
  const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
  const nData = nBuf.getChannelData(0);
  for (let i = 0; i < nLen; i++) {
    nData[i] = (Math.random() * 2 - 1);
  }
  noise.buffer = nBuf;

  const nFilter = ctx.createBiquadFilter();
  nFilter.type = 'bandpass';
  nFilter.frequency.setValueAtTime(200, now);
  nFilter.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
  nFilter.frequency.exponentialRampToValueAtTime(300, now + 0.5);
  nFilter.Q.value = 1;

  const nEnv = ctx.createGain();
  nEnv.gain.setValueAtTime(0, now);
  nEnv.gain.linearRampToValueAtTime(0.2, now + 0.08);
  nEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

  noise.connect(nFilter);
  nFilter.connect(nEnv);
  nEnv.connect(dry);
  nEnv.connect(wet);
  noise.start(now);

  const tone = ctx.createOscillator();
  tone.type = 'sine';
  tone.frequency.value = 440;

  const toneEnv = ctx.createGain();
  toneEnv.gain.setValueAtTime(0, now + 0.05);
  toneEnv.gain.linearRampToValueAtTime(0.15, now + 0.08);
  toneEnv.gain.exponentialRampToValueAtTime(0.001, now + 2);

  tone.connect(toneEnv);
  toneEnv.connect(dry);
  toneEnv.connect(wet);
  tone.start(now + 0.05);
  tone.stop(now + 2.5);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 220;

  const subEnv = ctx.createGain();
  subEnv.gain.setValueAtTime(0, now + 0.05);
  subEnv.gain.linearRampToValueAtTime(0.1, now + 0.1);
  subEnv.gain.exponentialRampToValueAtTime(0.001, now + 1.5);

  sub.connect(subEnv);
  subEnv.connect(dry);
  subEnv.connect(wet);
  sub.start(now + 0.05);
  sub.stop(now + 2);

  _registerVoice(master, [noise, tone, sub], 2.5);
}

export function playOminousDrone(volume = 0.6) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const stoppables = [];

  const reverb = createReverb(ctx, 3, 1.5);
  reverb.connect(master);

  const wet = ctx.createGain();
  wet.gain.value = 0.7;
  wet.connect(reverb);

  const dry = ctx.createGain();
  dry.gain.value = 0.5;
  dry.connect(master);

  [40, 41, 80, 120].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    stoppables.push(osc);
    osc.type = i < 2 ? 'sawtooth' : 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.linearRampToValueAtTime(freq * 0.7, now + 3);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.3 - i * 0.05, now + 0.5);
    env.gain.setValueAtTime(0.3 - i * 0.05, now + 1.5);
    env.gain.exponentialRampToValueAtTime(0.001, now + 3.5);

    const distortion = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let j = 0; j < 256; j++) {
      const x = (j / 128) - 1;
      curve[j] = (Math.PI + 10) * x / (Math.PI + 10 * Math.abs(x));
    }
    distortion.curve = curve;

    osc.connect(distortion);
    distortion.connect(env);
    env.connect(dry);
    env.connect(wet);
    osc.start(now);
    osc.stop(now + 4);
  });

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 3;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 20;
  lfo.connect(lfoGain);

  const subOsc = ctx.createOscillator();
  subOsc.type = 'sine';
  subOsc.frequency.setValueAtTime(55, now);
  lfoGain.connect(subOsc.frequency);

  const subEnv = ctx.createGain();
  subEnv.gain.setValueAtTime(0, now);
  subEnv.gain.linearRampToValueAtTime(0.5, now + 0.8);
  subEnv.gain.exponentialRampToValueAtTime(0.001, now + 3.5);

  subOsc.connect(subEnv);
  subEnv.connect(dry);
  subEnv.connect(wet);
  lfo.start(now);
  subOsc.start(now);
  // `noise` is declared BELOW (`const` — TDZ): push it separately AFTER creation,
  // otherwise calling the function throws a ReferenceError immediately
  stoppables.push(lfo, subOsc);
  lfo.stop(now + 4);
  subOsc.stop(now + 4);

  const noise = ctx.createBufferSource();
  const nLen = ctx.sampleRate * 0.5;
  const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
  const nData = nBuf.getChannelData(0);
  for (let i = 0; i < nLen; i++) {
    nData[i] = (Math.random() * 2 - 1) * 0.15;
  }
  noise.buffer = nBuf;

  const nEnv = ctx.createGain();
  nEnv.gain.setValueAtTime(0.4, now + 0.1);
  nEnv.gain.exponentialRampToValueAtTime(0.001, now + 1);

  const nFilter = ctx.createBiquadFilter();
  nFilter.type = 'lowpass';
  nFilter.frequency.value = 400;

  noise.connect(nFilter);
  nFilter.connect(nEnv);
  nEnv.connect(dry);
  noise.start(now + 0.1);
  stoppables.push(noise);

  _registerVoice(master, stoppables, 4);
}

export function playEnergeticSwipe(volume = 0.5) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 1, 4);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.8;
  dry.connect(master);

  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  wet.connect(reverb);

  const noise = ctx.createBufferSource();
  const nLen = ctx.sampleRate * 0.4;
  const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
  const nData = nBuf.getChannelData(0);
  for (let i = 0; i < nLen; i++) {
    nData[i] = (Math.random() * 2 - 1);
  }
  noise.buffer = nBuf;

  const nFilter = ctx.createBiquadFilter();
  nFilter.type = 'bandpass';
  nFilter.frequency.setValueAtTime(8000, now);
  nFilter.frequency.exponentialRampToValueAtTime(800, now + 0.2);
  nFilter.Q.value = 3;

  const nEnv = ctx.createGain();
  nEnv.gain.setValueAtTime(0.7, now);
  nEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

  noise.connect(nFilter);
  nFilter.connect(nEnv);
  nEnv.connect(dry);
  nEnv.connect(wet);
  noise.start(now);

  const slap = ctx.createOscillator();
  slap.type = 'sine';
  slap.frequency.setValueAtTime(800, now + 0.05);
  slap.frequency.exponentialRampToValueAtTime(80, now + 0.15);

  const slapEnv = ctx.createGain();
  slapEnv.gain.setValueAtTime(0, now + 0.05);
  slapEnv.gain.linearRampToValueAtTime(0.6, now + 0.06);
  slapEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

  slap.connect(slapEnv);
  slapEnv.connect(dry);
  slapEnv.connect(wet);
  slap.start(now + 0.05);
  slap.stop(now + 0.4);

  const impact = ctx.createOscillator();
  impact.type = 'sine';
  impact.frequency.setValueAtTime(60, now + 0.08);
  impact.frequency.exponentialRampToValueAtTime(30, now + 0.5);

  const impactEnv = ctx.createGain();
  impactEnv.gain.setValueAtTime(0, now + 0.08);
  impactEnv.gain.linearRampToValueAtTime(0.8, now + 0.1);
  impactEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

  impact.connect(impactEnv);
  impactEnv.connect(dry);
  impact.start(now + 0.08);
  impact.stop(now + 0.7);

  const click = ctx.createOscillator();
  click.type = 'square';
  click.frequency.value = 4000;

  const clickEnv = ctx.createGain();
  clickEnv.gain.setValueAtTime(0.3, now + 0.05);
  clickEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

  const clickFilter = ctx.createBiquadFilter();
  clickFilter.type = 'highpass';
  clickFilter.frequency.value = 3000;

  click.connect(clickFilter);
  clickFilter.connect(clickEnv);
  clickEnv.connect(dry);
  click.start(now + 0.05);
  click.stop(now + 0.1);

  _registerVoice(master, [noise, slap, impact, click], 0.8);
}

/**
 * JoJo: heavy "menacing" brass chord + sub-bass impact (ゴゴゴ).
 */
export function playMenacingRumble(volume = 0.6) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 2.5, 2.2);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.65;
  dry.connect(master);

  const wet = ctx.createGain();
  wet.gain.value = 0.5;
  wet.connect(reverb);

  const stoppables = [];

  // Tritone brass stab (D2, G#2, D3, F3)
  [73.42, 103.83, 146.83, 174.61].forEach((freq, idx) => {
    const osc = ctx.createOscillator();
    osc.type = idx % 2 === 0 ? 'sawtooth' : 'triangle';
    osc.frequency.setValueAtTime(freq * 1.03, now);
    osc.frequency.exponentialRampToValueAtTime(freq, now + 0.12);
    osc.frequency.linearRampToValueAtTime(freq * 0.98, now + 2.4);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1600, now);
    filter.frequency.exponentialRampToValueAtTime(420, now + 2.2);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.22 - idx * 0.03, now + 0.06);
    env.gain.exponentialRampToValueAtTime(0.001, now + 2.5);

    osc.connect(filter);
    filter.connect(env);
    env.connect(dry);
    env.connect(wet);
    osc.start(now);
    osc.stop(now + 2.6);
    stoppables.push(osc);
  });

  _registerVoice(master, stoppables, 2.6);
}

/**
 * Arcane: crystalline Hextech resonance with a deep mystical hum.
 */
export function playArcaneShimmer(volume = 0.5) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 3, 2);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.4;
  dry.connect(master);

  const wet = ctx.createGain();
  wet.gain.value = 0.65;
  wet.connect(reverb);

  const stoppables = [];
  // Hextech minor 9th arpeggio shimmer (C4, G4, D5, Eb5, Bb5)
  [261.63, 392.0, 587.33, 622.25, 932.33].forEach((freq, i) => {
    const start = now + i * 0.06;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(0.16, start + 0.05);
    env.gain.exponentialRampToValueAtTime(0.001, start + 2.4);

    osc.connect(env);
    env.connect(dry);
    env.connect(wet);
    osc.start(start);
    osc.stop(start + 2.5);
    stoppables.push(osc);
  });

  const sub = ctx.createOscillator();
  sub.type = 'triangle';
  sub.frequency.setValueAtTime(65.41, now);
  const subEnv = ctx.createGain();
  subEnv.gain.setValueAtTime(0, now);
  subEnv.gain.linearRampToValueAtTime(0.28, now + 0.25);
  subEnv.gain.exponentialRampToValueAtTime(0.001, now + 2.6);
  sub.connect(subEnv);
  subEnv.connect(dry);
  sub.start(now);
  sub.stop(now + 2.7);
  stoppables.push(sub);

  _registerVoice(master, stoppables, 2.8);
}

/**
 * Neon / Cyberpunk: detuned synthwave chord with a lowpass filter sweep.
 */
export function playSynthwaveChord(volume = 0.5) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 2.2, 2.5);
  reverb.connect(master);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(180, now);
  filter.frequency.exponentialRampToValueAtTime(2800, now + 0.35);
  filter.frequency.exponentialRampToValueAtTime(350, now + 2.2);
  filter.Q.value = 2.5;

  filter.connect(master);
  filter.connect(reverb);

  const stoppables = [];
  // A minor synth brass (A2, E3, A3, C4, E4)
  [110, 164.81, 220, 261.63, 329.63].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, now);
    osc.detune.setValueAtTime((i - 2) * 9, now);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.14, now + 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, now + 2.3);

    osc.connect(env);
    env.connect(filter);
    osc.start(now);
    osc.stop(now + 2.4);
    stoppables.push(osc);
  });

  _registerVoice(master, stoppables, 2.4);
}

/**
 * Yakuza / Ronin: heavy taiko drum strike and pentatonic koto plucks.
 */
export function playSakuraKoto(volume = 0.55) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 2.2, 2.5);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.7;
  dry.connect(master);

  const wet = ctx.createGain();
  wet.gain.value = 0.45;
  wet.connect(reverb);

  const stoppables = [];

  // Taiko drum hit
  const taiko = ctx.createOscillator();
  taiko.type = 'sine';
  taiko.frequency.setValueAtTime(135, now);
  taiko.frequency.exponentialRampToValueAtTime(48, now + 0.45);
  const taikoEnv = ctx.createGain();
  taikoEnv.gain.setValueAtTime(0, now);
  taikoEnv.gain.linearRampToValueAtTime(0.65, now + 0.015);
  taikoEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
  taiko.connect(taikoEnv);
  taikoEnv.connect(dry);
  taikoEnv.connect(wet);
  taiko.start(now);
  taiko.stop(now + 1.0);
  stoppables.push(taiko);

  // Japanese In-sen scale koto plucks (D4, Eb4, G4, A4, D5)
  [293.66, 311.13, 392.0, 440.0, 587.33].forEach((freq, i) => {
    const start = now + 0.12 + i * 0.07;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(0.22, start + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, start + 1.2);

    osc.connect(env);
    env.connect(dry);
    env.connect(wet);
    osc.start(start);
    osc.stop(start + 1.3);
    stoppables.push(osc);
  });

  _registerVoice(master, stoppables, 2.2);
}

/**
 * Typewriter / Terminal: CRT monitor power-on hum and dossier telemetry beeps.
 */
export function playTerminalBeeps(volume = 0.45) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const stoppables = [];

  // CRT hum
  const hum = ctx.createOscillator();
  hum.type = 'sine';
  hum.frequency.setValueAtTime(60, now);
  const humEnv = ctx.createGain();
  humEnv.gain.setValueAtTime(0, now);
  humEnv.gain.linearRampToValueAtTime(0.12, now + 0.05);
  humEnv.gain.exponentialRampToValueAtTime(0.001, now + 1.6);
  hum.connect(humEnv);
  humEnv.connect(master);
  hum.start(now);
  hum.stop(now + 1.7);
  stoppables.push(hum);

  // Telemetry data beeps
  const freqs = [1200, 1600, 1400, 1800, 1200, 2000, 1500, 2200];
  freqs.forEach((freq, i) => {
    const start = now + 0.08 + i * 0.075;
    const beep = ctx.createOscillator();
    beep.type = 'square';
    beep.frequency.setValueAtTime(freq, start);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1600;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(0.12, start + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, start + 0.055);

    beep.connect(filter);
    filter.connect(env);
    env.connect(master);
    beep.start(start);
    beep.stop(start + 0.065);
    stoppables.push(beep);
  });

  _registerVoice(master, stoppables, 1.8);
}

/**
 * Noir: smoky jazz minor 9th chord (vibraphone / Rhodes) with tremolo.
 */
export function playNoirChord(volume = 0.5) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 2.8, 2.0);
  reverb.connect(master);

  const tremolo = ctx.createGain();
  tremolo.gain.value = 0.7;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 4.5;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.2;
  lfo.connect(lfoDepth);
  lfoDepth.connect(tremolo.gain);
  lfo.start(now);
  lfo.stop(now + 3.0);

  tremolo.connect(master);
  tremolo.connect(reverb);

  const stoppables = [lfo];
  // C minor 9th jazz voicing (C3, Eb3, G3, Bb3, D4)
  [130.81, 155.56, 196.0, 233.08, 293.66].forEach((freq, i) => {
    const start = now + i * 0.04;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(0.18 - i * 0.02, start + 0.04);
    env.gain.exponentialRampToValueAtTime(0.001, start + 2.8);

    osc.connect(env);
    env.connect(tremolo);
    osc.start(start);
    osc.stop(start + 2.9);
    stoppables.push(osc);
  });

  _registerVoice(master, stoppables, 3.0);
}

/**
 * Western: paper poster slap against wood, two iron nail strikes, and a
 * spaghetti-western tremolo baritone guitar fifth twang with canyon echo.
 */
export function playWesternStinger(volume = 0.55, options: { stamp?: boolean } = {}) {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 2.8, 2.1);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.62;
  dry.connect(master);

  const wet = ctx.createGain();
  wet.gain.value = 0.68;
  wet.connect(reverb);

  // Tremolo bus for the spaghetti-western baritone guitar
  const guitarBus = ctx.createGain();
  guitarBus.gain.value = 0.82;
  const tremLfo = ctx.createOscillator();
  tremLfo.type = 'sine';
  tremLfo.frequency.setValueAtTime(5.2, now);
  const tremDepth = ctx.createGain();
  tremDepth.gain.setValueAtTime(0.18, now);
  tremLfo.connect(tremDepth);
  tremDepth.connect(guitarBus.gain);
  tremLfo.start(now);
  tremLfo.stop(now + 3.2);

  guitarBus.connect(dry);
  guitarBus.connect(wet);

  const stoppables: any[] = [tremLfo];

  // 1. Desert wind breath + parchment rustle on drop (0.15s - 0.75s)
  const windLen = Math.floor(ctx.sampleRate * 1.4);
  const windBuf = ctx.createBuffer(1, windLen, ctx.sampleRate);
  const windData = windBuf.getChannelData(0);
  for (let i = 0; i < windLen; i++) {
    windData[i] = Math.random() * 2 - 1;
  }
  const windNoise = ctx.createBufferSource();
  windNoise.buffer = windBuf;

  const windFilter = ctx.createBiquadFilter();
  windFilter.type = 'bandpass';
  windFilter.frequency.setValueAtTime(320, now);
  windFilter.frequency.exponentialRampToValueAtTime(950, now + 0.36);
  windFilter.frequency.exponentialRampToValueAtTime(260, now + 1.3);
  windFilter.Q.value = 1.8;

  const windEnv = ctx.createGain();
  windEnv.gain.setValueAtTime(0.001, now);
  windEnv.gain.linearRampToValueAtTime(0.22, now + 0.34);
  windEnv.gain.exponentialRampToValueAtTime(0.001, now + 1.35);

  windNoise.connect(windFilter);
  windFilter.connect(windEnv);
  windEnv.connect(dry);
  windEnv.connect(wet);
  windNoise.start(now);
  windNoise.stop(now + 1.4);
  stoppables.push(windNoise);

  // 2. Crisp paper slap against the wooden board (~0.42s) + two iron tack hits (0.58s, 0.72s)
  const scheduleBoardHit = (time: number, lowFreq: number, gainAmt: number, metallic: boolean) => {
    // Low wooden board thud
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(lowFreq, time);
    thud.frequency.exponentialRampToValueAtTime(36, time + 0.11);
    const thudEnv = ctx.createGain();
    thudEnv.gain.setValueAtTime(0, time);
    thudEnv.gain.linearRampToValueAtTime(gainAmt, time + 0.006);
    thudEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
    thud.connect(thudEnv);
    thudEnv.connect(dry);
    thud.start(time);
    thud.stop(time + 0.16);
    stoppables.push(thud);

    // Parchment / wood transient snap
    const snapLen = Math.floor(ctx.sampleRate * 0.07);
    const snapBuf = ctx.createBuffer(1, snapLen, ctx.sampleRate);
    const snapData = snapBuf.getChannelData(0);
    for (let i = 0; i < snapLen; i++) {
      snapData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / snapLen, 2.2);
    }
    const snap = ctx.createBufferSource();
    snap.buffer = snapBuf;
    const snapFilter = ctx.createBiquadFilter();
    snapFilter.type = 'bandpass';
    snapFilter.frequency.value = metallic ? 2400 : 1150;
    snapFilter.Q.value = metallic ? 2.4 : 1.1;
    const snapEnv = ctx.createGain();
    snapEnv.gain.setValueAtTime(gainAmt * 0.65, time);
    snapEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.065);
    snap.connect(snapFilter);
    snapFilter.connect(snapEnv);
    snapEnv.connect(dry);
    snap.start(time);
    stoppables.push(snap);

    if (metallic) {
      // Forged iron tack ring
      const ping = ctx.createOscillator();
      ping.type = 'triangle';
      ping.frequency.setValueAtTime(3100 + (Math.random() * 220 - 110), time);
      ping.frequency.exponentialRampToValueAtTime(1850, time + 0.07);
      const pingEnv = ctx.createGain();
      pingEnv.gain.setValueAtTime(0, time);
      pingEnv.gain.linearRampToValueAtTime(gainAmt * 0.22, time + 0.003);
      pingEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.075);
      ping.connect(pingEnv);
      pingEnv.connect(dry);
      ping.start(time);
      ping.stop(time + 0.085);
      stoppables.push(ping);
    }
  };

  scheduleBoardHit(now + 0.40, 118, 0.34, false); // Poster slaps onto wood
  scheduleBoardHit(now + 0.58, 96, 0.28, true);   // Left iron tack
  scheduleBoardHit(now + 0.72, 92, 0.25, true);   // Right iron tack

  if (options?.stamp) {
    // Heavy Marshal rubber stamp thud at ~1.68s
    scheduleBoardHit(now + 1.68, 84, 0.38, false);
  }

  // 3. Spaghetti-Western twang guitar chord (E2, B2, E3, G3, B3, E4)
  const chordNotes = [82.41, 123.47, 164.81, 196.0, 246.94, 329.63];
  chordNotes.forEach((freq, i) => {
    const start = now + 0.08 + i * 0.048;

    // Main metallic twang oscillator (sawtooth) + warm body (triangle)
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    // Slight pitch bend on attack like a hard plectrum pluck
    osc.frequency.setValueAtTime(freq * 1.018, start);
    osc.frequency.exponentialRampToValueAtTime(freq, start + 0.045);

    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = 'triangle';
    bodyOsc.frequency.setValueAtTime(freq, start);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1850 - i * 90, start);
    filter.frequency.exponentialRampToValueAtTime(480, start + 1.65);
    filter.Q.value = 2.1;

    const env = ctx.createGain();
    const peak = Math.max(0.11, 0.22 - i * 0.016);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.008);
    env.gain.exponentialRampToValueAtTime(peak * 0.42, start + 0.35);
    env.gain.exponentialRampToValueAtTime(0.001, start + 2.25);

    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.45;

    osc.connect(filter);
    bodyOsc.connect(bodyGain);
    bodyGain.connect(filter);
    filter.connect(env);
    env.connect(guitarBus);

    osc.start(start);
    osc.stop(start + 2.3);
    bodyOsc.start(start);
    bodyOsc.stop(start + 2.3);
    stoppables.push(osc, bodyOsc);
  });

  // 4. Deep bass root resonance (E1 = 41.20 Hz) for cinematic weight
  const bass = ctx.createOscillator();
  bass.type = 'triangle';
  bass.frequency.setValueAtTime(41.2, now + 0.08);
  const bassFilter = ctx.createBiquadFilter();
  bassFilter.type = 'lowpass';
  bassFilter.frequency.value = 180;
  const bassEnv = ctx.createGain();
  bassEnv.gain.setValueAtTime(0, now + 0.08);
  bassEnv.gain.linearRampToValueAtTime(0.32, now + 0.14);
  bassEnv.gain.exponentialRampToValueAtTime(0.001, now + 2.3);
  bass.connect(bassFilter);
  bassFilter.connect(bassEnv);
  bassEnv.connect(dry);
  bass.start(now + 0.08);
  bass.stop(now + 2.4);
  stoppables.push(bass);

  // 5. Lonely high desert harmonic swell (B4 -> E5) with gentle vibrato
  const whistle = ctx.createOscillator();
  whistle.type = 'sine';
  whistle.frequency.setValueAtTime(493.88, now + 0.55);
  whistle.frequency.exponentialRampToValueAtTime(659.25, now + 0.92);

  const vibLfo = ctx.createOscillator();
  vibLfo.type = 'sine';
  vibLfo.frequency.value = 5.8;
  const vibGain = ctx.createGain();
  vibGain.gain.value = 4.2;
  vibLfo.connect(vibGain);
  vibGain.connect(whistle.frequency);

  const whistleEnv = ctx.createGain();
  whistleEnv.gain.setValueAtTime(0, now + 0.55);
  whistleEnv.gain.linearRampToValueAtTime(0.065, now + 0.85);
  whistleEnv.gain.exponentialRampToValueAtTime(0.001, now + 2.45);

  whistle.connect(whistleEnv);
  whistleEnv.connect(wet);
  whistle.start(now + 0.55);
  whistle.stop(now + 2.5);
  vibLfo.start(now + 0.55);
  vibLfo.stop(now + 2.5);
  stoppables.push(whistle, vibLfo);

  _registerVoice(master, stoppables, 2.9);
}

/* =========================================================================
 *Controllable original musical themes for openings and endings
 * (compatible with Foundry's Sound handle contract: { volume, stop() })
 * ========================================================================= */

export interface SynthSoundHandle {
  volume: number;
  stop: () => void;
}

function createSynthSoundHandle(
  ctx: any,
  master: any,
  stoppables: any[],
  initialVol: number,
  hardEndSec: number,
  onStopExtra?: () => void
): SynthSoundHandle {
  let currentVol = Math.max(0, Number(initialVol) || 0.8);
  let stopped = false;

  const voice: any = {
    master,
    stoppables,
    timer: null,
    onStop: onStopExtra
  };
  voice.timer = setTimeout(() => {
    _activeVoices.delete(voice);
    try { onStopExtra?.(); } catch { /* ignore */ }
  }, hardEndSec * 1000 + 800);
  _activeVoices.add(voice);

  return {
    get volume() {
      return currentVol;
    },
    set volume(val: number) {
      currentVol = Math.max(0, Number(val) || 0);
      if (stopped) return;
      try {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(getFinalVolume(currentVol), t + 0.04);
      } catch { /* ignore */ }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(voice.timer);
      _activeVoices.delete(voice);
      try { onStopExtra?.(); } catch { /* ignore */ }
      try {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(0.0001, t + 0.06);
        for (const n of stoppables) {
          try { n.stop(t + 0.08); } catch { /* already stopped */ }
        }
        setTimeout(() => { try { master.disconnect(); } catch { /* ignore */ } }, 150);
      } catch { /* ignore */ }
    }
  };
}

let _sharedNoiseBuf: any = null;
function getSharedNoiseBuffer(ctx: any) {
  if (!_sharedNoiseBuf || _sharedNoiseBuf.sampleRate !== ctx.sampleRate) {
    const len = Math.floor(ctx.sampleRate * 2);
    _sharedNoiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = _sharedNoiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  }
  return _sharedNoiseBuf;
}

/**
 * Original driving cliffhanger bass theme (for the "To Be Continued" ending):
 * acoustic harmonic build-up timed right up to the freeze-frame (dropDelayMs),
 * followed by a tight funk bass groove with drums.
 */
export function playCliffhangerBassTheme(volume = 0.8, dropDelayMs = 3800): SynthSoundHandle | null {
  if (volume <= 0) return null;
  const ctx = getAudioContext();
  if (!ctx) return null;

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 1.6, 2.8);
  const wet = ctx.createGain();
  wet.gain.value = 0.24;
  wet.connect(reverb);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.82;
  dry.connect(master);

  const stoppables: any[] = [];
  const dropSec = Math.max(0.4, Math.min(12, (Number(dropDelayMs) || 3800) / 1000));

  // Plucked acoustic harmonic for the intro build-up
  const pluckHarmonic = (t: number, freq: number, dur: number, amp: number) => {
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = 'triangle';
    o2.type = 'sine';
    o1.frequency.setValueAtTime(freq, t);
    o2.frequency.setValueAtTime(freq * 2, t);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3400, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(amp, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0008, t + dur);

    const g2 = ctx.createGain();
    g2.gain.value = 0.35;

    o1.connect(lp);
    o2.connect(g2);
    g2.connect(lp);
    lp.connect(env);
    env.connect(dry);
    env.connect(wet);

    o1.start(t); o1.stop(t + dur + 0.03);
    o2.start(t); o2.stop(t + dur + 0.03);
    stoppables.push(o1, o2);
  };

  // Original ascending harmonic figure in D Dorian (D4 - A4 - C5 - E5 - F5 - A5)
  const buildMotif = [293.66, 440.0, 523.25, 659.25, 587.33, 440.0, 523.25, 698.46];
  const introStep = Math.max(0.14, Math.min(0.28, (dropSec - 0.32) / 14));
  let cursor = 0.04;
  let idx = 0;
  while (cursor < dropSec - 0.28) {
    const progress = cursor / dropSec;
    pluckHarmonic(now + cursor, buildMotif[idx % buildMotif.length], 0.42, 0.14 + 0.14 * progress);
    cursor += introStep * (1 - 0.22 * progress);
    idx++;
  }

  // Sliding bass glissando pickup right before the freeze-frame
  {
    const slideT = now + Math.max(0.05, dropSec - 0.26);
    const sl = ctx.createOscillator();
    sl.type = 'sawtooth';
    sl.frequency.setValueAtTime(220, slideT);
    sl.frequency.exponentialRampToValueAtTime(73.42, now + dropSec); // drop into D2
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, slideT);
    g.gain.linearRampToValueAtTime(0.32, slideT + 0.05);
    g.gain.exponentialRampToValueAtTime(0.01, now + dropSec + 0.03);
    sl.connect(flt); flt.connect(g); g.connect(dry);
    sl.start(slideT); sl.stop(now + dropSec + 0.05);
    stoppables.push(sl);
  }

  // Post-freeze groove instruments
  const playPickedBass = (t: number, freq: number, dur: number, accent = 1) => {
    const saw = ctx.createOscillator();
    const sq = ctx.createOscillator();
    saw.type = 'sawtooth';
    sq.type = 'triangle';
    saw.frequency.setValueAtTime(freq * 1.012, t);
    saw.frequency.exponentialRampToValueAtTime(freq, t + 0.025);
    sq.frequency.setValueAtTime(freq, t);

    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.setValueAtTime(1650 * accent, t);
    bp.frequency.exponentialRampToValueAtTime(340, t + dur);
    bp.Q.value = 2.6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.30 * accent, t + 0.007);
    env.gain.exponentialRampToValueAtTime(0.14 * accent, t + dur * 0.45);
    env.gain.exponentialRampToValueAtTime(0.0008, t + dur);

    saw.connect(bp);
    sq.connect(bp);
    bp.connect(env);
    env.connect(dry);

    saw.start(t); saw.stop(t + dur + 0.02);
    sq.start(t); sq.stop(t + dur + 0.02);
    stoppables.push(saw, sq);
  };

  const playDrumHit = (t: number, kind: 'kick' | 'snare' | 'hat') => {
    if (kind === 'kick') {
      const k = ctx.createOscillator();
      k.type = 'sine';
      k.frequency.setValueAtTime(135, t);
      k.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.38, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      k.connect(g); g.connect(dry);
      k.start(t); k.stop(t + 0.20);
      stoppables.push(k);
      return;
    }
    const n = ctx.createBufferSource();
    n.buffer = getSharedNoiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = kind === 'snare' ? 'bandpass' : 'highpass';
    f.frequency.value = kind === 'snare' ? 1650 : 6500;
    f.Q.value = 1.2;
    const dur = kind === 'snare' ? 0.16 : 0.055;
    const g = ctx.createGain();
    g.gain.setValueAtTime(kind === 'snare' ? 0.24 : 0.09, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(f); f.connect(g); g.connect(dry);
    if (kind === 'snare') g.connect(wet);
    n.start(t); n.stop(t + dur + 0.02);
    stoppables.push(n);
  };

  // Original 16-step riff in D Dorian (124 BPM -> 16th = 0.121s)
  const step16 = 0.121;
  const barDur = step16 * 16;
  // [stepIndex, freqHz, lengthInSteps, accent]
  const riffPattern: [number, number, number, number][] = [
    [0,  73.42, 2, 1.15], // D2 freeze-frame downbeat
    [2,  73.42, 1, 0.85],
    [3, 146.83, 1, 0.95], // D3 octave
    [5, 130.81, 2, 1.00], // C3
    [7, 110.00, 1, 0.90], // A2
    [8,  98.00, 2, 1.05], // G2
    [10, 110.00, 2, 0.95], // A2
    [12, 123.47, 1, 0.92], // B2 (Dorian sixth)
    [13, 130.81, 1, 0.96], // C3
    [14, 146.83, 2, 1.05]  // D3
  ];

  const scheduleBar = (barStart: number) => {
    for (const [st, hz, len, acc] of riffPattern) {
      playPickedBass(barStart + st * step16, hz, len * step16 * 0.92, acc);
    }
    for (let s = 0; s < 16; s += 2) {
      playDrumHit(barStart + s * step16, 'hat');
    }
    playDrumHit(barStart, 'kick');
    playDrumHit(barStart + 6 * step16, 'kick');
    playDrumHit(barStart + 10 * step16, 'kick');
    playDrumHit(barStart + 4 * step16, 'snare');
    playDrumHit(barStart + 12 * step16, 'snare');
  };

  // Schedule 2 bars ahead via a lightweight interval so credits of any length stay scored
  let nextBarTime = now + dropSec;
  scheduleBar(nextBarTime);
  nextBarTime += barDur;
  scheduleBar(nextBarTime);
  nextBarTime += barDur;

  const loopTimer = setInterval(() => {
    if (ctx.currentTime + barDur * 1.5 >= nextBarTime) {
      scheduleBar(nextBarTime);
      nextBarTime += barDur;
    }
  }, 450);

  return createSynthSoundHandle(ctx, master, stoppables, volume, 90, () => clearInterval(loopTimer));
}

/**
 * Original ceremonial symphonic fanfare for the space crawl ("Star Wars Opening").
 */
export function playSpaceCrawlFanfare(volume = 0.7, durationSec = 45): SynthSoundHandle | null {
  if (volume <= 0) return null;
  const ctx = getAudioContext();
  if (!ctx) return null;

  const now = ctx.currentTime;
  const totalSec = Math.max(8, Math.min(130, Number(durationSec) || 45));
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 2.8, 2.1);
  const wet = ctx.createGain();
  wet.gain.value = 0.52;
  wet.connect(reverb);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.62;
  dry.connect(master);

  const stoppables: any[] = [];

  // Brass section (French horns + trumpets): detuned sawtooth pair + brass bell filter
  const playBrassNote = (t: number, freq: number, dur: number, amp = 0.16) => {
    for (const det of [-4.5, 4.5]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.value = det;

      const bell = ctx.createBiquadFilter();
      bell.type = 'lowpass';
      bell.frequency.setValueAtTime(650, t);
      bell.frequency.exponentialRampToValueAtTime(2450, t + Math.min(0.12, dur * 0.35));
      bell.frequency.exponentialRampToValueAtTime(1250, t + dur);
      bell.Q.value = 1.6;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(amp * 0.5, t + 0.045);
      env.gain.setValueAtTime(amp * 0.44, t + Math.max(0.06, dur - 0.12));
      env.gain.exponentialRampToValueAtTime(0.0008, t + dur);

      osc.connect(bell);
      bell.connect(env);
      env.connect(dry);
      env.connect(wet);
      osc.start(t);
      osc.stop(t + dur + 0.04);
      stoppables.push(osc);
    }
  };

  const playTimpani = (t: number, freq: number, amp = 0.28) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.18, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.09);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(amp, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
    osc.connect(env);
    env.connect(dry);
    env.connect(wet);
    osc.start(t);
    osc.stop(t + 0.7);
    stoppables.push(osc);
  };

  // Cymbal crash at crawl opening
  {
    const cym = ctx.createBufferSource();
    cym.buffer = getSharedNoiseBuffer(ctx);
    cym.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now + 0.05);
    g.gain.linearRampToValueAtTime(0.18, now + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 2.6);
    cym.connect(hp); hp.connect(g); g.connect(wet);
    cym.start(now + 0.05); cym.stop(now + 2.7);
    stoppables.push(cym);
  }

  // Original heroic theme in D major / Mixolydian (royalty-free original melody)
  // Bars 1-2: open D fifth chord + ascending fanfare call D4 -> A4 -> B4 -> F#5 -> E5 -> D5
  const fanfareEvents: [number, number[], number, number][] = [
    [0.05, [73.42, 146.83, 220.00, 293.66], 1.15, 0.18],
    [1.25, [293.66, 146.83], 0.28, 0.16],
    [1.55, [329.63, 164.81], 0.28, 0.16],
    [1.85, [440.00, 220.00, 110.00], 1.10, 0.20],
    [3.00, [493.88, 246.94], 0.45, 0.17],
    [3.50, [587.33, 293.66, 146.83], 1.35, 0.21],
    [4.95, [523.25, 261.63, 130.81], 0.75, 0.18], // C natural — epic Mixolydian shift
    [5.75, [440.00, 220.00, 164.81], 1.45, 0.19],
    [7.30, [392.00, 196.00, 98.00],  0.85, 0.17],
    [8.20, [440.00, 220.00, 110.00], 0.85, 0.18],
    [9.10, [587.33, 293.66, 220.00, 146.83], 2.40, 0.20]
  ];

  for (const [offset, chord, dur, amp] of fanfareEvents) {
    if (offset >= totalSec) break;
    for (const hz of chord) {
      playBrassNote(now + offset, hz, dur, amp);
    }
    playTimpani(now + offset, chord[chord.length - 1] <= 150 ? chord[chord.length - 1] : 73.42, 0.24);
  }

  // Cosmic symphonic pad for the remainder of the crawl
  const padChords = [
    [146.83, 220.00, 293.66, 369.99], // D maj
    [130.81, 196.00, 261.63, 329.63], // C maj
    [98.00,  196.00, 246.94, 293.66], // G maj
    [110.00, 164.81, 220.00, 329.63]  // A sus/maj
  ];
  let padCursor = 11.2;
  let pIdx = 0;
  while (padCursor < totalSec) {
    const segDur = Math.min(4.8, totalSec - padCursor + 0.8);
    const chord = padChords[pIdx % padChords.length];
    for (const hz of chord) {
      playBrassNote(now + padCursor, hz, segDur, 0.085);
    }
    playTimpani(now + padCursor, chord[0] * 0.5, 0.15);
    padCursor += 4.5;
    pIdx++;
  }

  return createSynthSoundHandle(ctx, master, stoppables, volume, totalSec + 2);
}

/**
 * Original ironic orchestral theme in the style of comedy end credits ("Directed By"):
 * walking pizzicato double bass and playful staccato woodwind melody.
 */
export function playCreditsJauntTheme(volume = 0.8): SynthSoundHandle | null {
  if (volume <= 0) return null;
  const ctx = getAudioContext();
  if (!ctx) return null;

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 1.2, 3.2);
  const wet = ctx.createGain();
  wet.gain.value = 0.18;
  wet.connect(reverb);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.84;
  dry.connect(master);

  const stoppables: any[] = [];

  // Tuba / pizzicato bass ("oom-pah")
  const playOomPahBass = (t: number, freq: number, dur = 0.22) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * 1.04, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.04);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.32, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc.connect(lp); lp.connect(env); env.connect(dry);
    osc.start(t); osc.stop(t + dur + 0.03);
    stoppables.push(osc);
  };

  // Staccato off-beat accompaniment chord ("pah")
  const playPizzChord = (t: number, freqs: number[]) => {
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.08, t + 0.008);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      osc.connect(env); env.connect(dry); env.connect(wet);
      osc.start(t); osc.stop(t + 0.16);
      stoppables.push(osc);
    }
  };

  // Playful clarinet/oboe lead
  const playReedLead = (t: number, freq: number, dur: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, t);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1350;
    bp.Q.value = 1.4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.14, t + 0.015);
    env.gain.exponentialRampToValueAtTime(0.08, t + dur * 0.65);
    env.gain.exponentialRampToValueAtTime(0.0008, t + dur);

    osc.connect(bp); bp.connect(env); env.connect(dry); env.connect(wet);
    osc.start(t); osc.stop(t + dur + 0.03);
    stoppables.push(osc);
  };

  // Original 4-bar vaudeville phrase in F major (beat = 0.28s)
  const beat = 0.28;
  const cycleDur = beat * 16;
  const bassRoots: [number, number, number[]][] = [
    [0,  87.31,  [261.63, 349.23, 440.00]], // F2
    [2,  130.81, [261.63, 349.23, 440.00]], // C3
    [4,  98.00,  [293.66, 349.23, 440.00]], // G2 (Gm7)
    [6,  130.81, [280.00, 349.23, 466.16]], // C7
    [8,  87.31,  [261.63, 349.23, 440.00]], // F2
    [10, 110.00, [261.63, 329.63, 440.00]], // A2
    [12, 116.54, [293.66, 349.23, 466.16]], // Bb2
    [14, 130.81, [261.63, 329.63, 392.00]]  // C3
  ];

  // Original upbeat melody (no shared phrases with Frolic)
  const leadNotes: [number, number, number][] = [
    [0.0, 523.25, 0.20], [0.5, 587.33, 0.20], [1.0, 698.46, 0.36], [2.0, 659.25, 0.22], [2.5, 587.33, 0.22], [3.0, 523.25, 0.38],
    [4.0, 466.16, 0.22], [4.5, 523.25, 0.22], [5.0, 587.33, 0.42], [6.0, 659.25, 0.24], [7.0, 523.25, 0.38],
    [8.0, 698.46, 0.20], [8.5, 783.99, 0.20], [9.0, 880.00, 0.42], [10.0, 783.99, 0.24], [11.0, 698.46, 0.36],
    [12.0, 659.25, 0.22], [12.5, 587.33, 0.22], [13.0, 659.25, 0.24], [14.0, 698.46, 0.65]
  ];

  const scheduleCycle = (startT: number) => {
    for (const [b, rootHz, chord] of bassRoots) {
      playOomPahBass(startT + b * beat, rootHz, beat * 0.85);
      playPizzChord(startT + (b + 1) * beat, chord);
    }
    for (const [b, hz, dur] of leadNotes) {
      playReedLead(startT + b * beat, hz, dur);
    }
  };

  let nextCycle = now + 0.05;
  scheduleCycle(nextCycle);
  nextCycle += cycleDur;

  const loopTimer = setInterval(() => {
    if (ctx.currentTime + cycleDur * 1.2 >= nextCycle) {
      scheduleCycle(nextCycle);
      nextCycle += cycleDur;
    }
  }, 600);

  return createSynthSoundHandle(ctx, master, stoppables, volume, 120, () => clearInterval(loopTimer));
}

/**
 * Original explosive rock-blockbuster finale ("Blockbuster / Michael Bay Ending"):
 * tense high piano pulse and rising reverse swell right up to dropDelayMs,
 * followed by a heavy cinematic drop (Braaam + overdriven guitar power chords and drums).
 */
export function playBlockbusterFinaleTheme(volume = 0.8, dropDelayMs = 6000): SynthSoundHandle | null {
  if (volume <= 0) return null;
  const ctx = getAudioContext();
  if (!ctx) return null;

  const now = ctx.currentTime;
  const dropSec = Math.max(0.3, Math.min(16, (Number(dropDelayMs) || 6000) / 1000));
  const totalSec = dropSec + 10;

  const master = ctx.createGain();
  master.gain.value = getFinalVolume(volume);
  master.connect(ctx.destination);

  const reverb = createReverb(ctx, 2.6, 2.2);
  const wet = ctx.createGain();
  wet.gain.value = 0.44;
  wet.connect(reverb);
  reverb.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.75;
  dry.connect(master);

  const stoppables: any[] = [];

  // 1. Atmospheric high-note pulse before the cut (original rhythmic ostinato on E5/B4)
  if (dropSec >= 0.6) {
    const pulseNotes = [659.25, 659.25, 783.99, 659.25, 587.33, 659.25, 493.88, 587.33];
    const step = 0.44;
    let tCursor = 0.05;
    let nIdx = 0;
    while (tCursor < dropSec - 0.25) {
      const t = now + tCursor;
      const hz = pulseNotes[nIdx % pulseNotes.length];
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(hz, t);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.16, t + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      o.connect(env); env.connect(dry); env.connect(wet);
      o.start(t); o.stop(t + 0.6);
      stoppables.push(o);
      tCursor += step;
      nIdx++;
    }

    // Rising reverse sweep before the title smash
    const riserStart = now + Math.max(0.05, dropSec - 1.6);
    const riser = ctx.createBufferSource();
    riser.buffer = getSharedNoiseBuffer(ctx);
    riser.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(180, riserStart);
    bp.frequency.exponentialRampToValueAtTime(3800, now + dropSec);
    bp.Q.value = 2.0;
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, riserStart);
    rg.gain.exponentialRampToValueAtTime(0.28, now + dropSec - 0.02);
    rg.gain.linearRampToValueAtTime(0.0001, now + dropSec + 0.05);
    riser.connect(bp); bp.connect(rg); rg.connect(dry); rg.connect(wet);
    riser.start(riserStart); riser.stop(now + dropSec + 0.08);
    stoppables.push(riser);
  }

  // 2. Explosive drop at dropSec: sub-impact + overdriven guitar power chords
  const hitT = now + dropSec;
  const distCurve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 128) - 1;
    distCurve[i] = Math.tanh(x * 4.5);
  }

  const playPowerChord = (t: number, rootHz: number, dur: number) => {
    for (const mult of [1, 1.498, 2]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(rootHz * mult, t);

      const shaper = ctx.createWaveShaper();
      shaper.curve = distCurve;

      const cab = ctx.createBiquadFilter();
      cab.type = 'lowpass';
      cab.frequency.value = 2600;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.15, t + 0.015);
      env.gain.setValueAtTime(0.13, t + Math.max(0.03, dur - 0.15));
      env.gain.exponentialRampToValueAtTime(0.0008, t + dur);

      osc.connect(shaper); shaper.connect(cab); cab.connect(env);
      env.connect(dry); env.connect(wet);
      osc.start(t); osc.stop(t + dur + 0.04);
      stoppables.push(osc);
    }
  };

  // Seismic kick sub-drop + crash on title impact
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(110, hitT);
  sub.frequency.exponentialRampToValueAtTime(34, hitT + 0.85);
  const subG = ctx.createGain();
  subG.gain.setValueAtTime(0.55, hitT);
  subG.gain.exponentialRampToValueAtTime(0.001, hitT + 1.1);
  sub.connect(subG); subG.connect(dry);
  sub.start(hitT); sub.stop(hitT + 1.15);
  stoppables.push(sub);

  // Four heavy blockbuster chords (Em - C - G - D) at 1.8s each
  const prog: [number, number][] = [
    [0.0, 82.41],  // E2
    [1.8, 65.41],  // C2
    [3.6, 98.00],  // G2
    [5.4, 73.42]   // D2
  ];
  for (const [off, hz] of prog) {
    const t = hitT + off;
    playPowerChord(t, hz, 1.85);

    const crash = ctx.createBufferSource();
    crash.buffer = getSharedNoiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3200;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.18, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    crash.connect(hp); hp.connect(cg); cg.connect(wet);
    crash.start(t); crash.stop(t + 0.95);
    stoppables.push(crash);
  }

  return createSynthSoundHandle(ctx, master, stoppables, volume, totalSec);
}
