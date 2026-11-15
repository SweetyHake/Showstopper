/**
 * Procedural finisher sounds (asset-free WebAudio synthesis).
 *
 * Each flavor is assembled from a small set of building blocks:
 * filtered noise, frequency-ramped oscillator, FM wobble, and reverb.
 * When an effect specifies an audio file (`soundPath` in settings), the file
 * takes precedence and synthesis is skipped (see finisher-effect.mjs).
 *
 * An active-voice registry lets us silence everything immediately (skip button,
 * scene teardown): stopAllFinisherSounds().
 */
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let _ctx = null;
function ctx() {
    if (!_ctx)
        _ctx = new AudioCtx();
    if (_ctx.state === 'suspended')
        _ctx.resume();
    return _ctx;
}
function interfaceVolume() {
    try {
        return game.settings.get('core', 'globalInterfaceVolume') ?? 0.5;
    }
    catch {
        return 0.5;
    }
}
const _voices = new Set();
/** Quickly fade out and stop all active finisher sounds. */
export function stopAllFinisherSounds() {
    for (const v of [..._voices]) {
        clearTimeout(v.timer);
        _voices.delete(v);
        try {
            const t = v.master.context.currentTime;
            v.master.gain.cancelScheduledValues(t);
            v.master.gain.setValueAtTime(v.master.gain.value, t);
            v.master.gain.linearRampToValueAtTime(0.0001, t + 0.08);
            for (const n of v.stoppables) {
                try {
                    n.stop(t + 0.1);
                }
                catch { /* already stopped */ }
            }
            // Graph is no longer needed: disconnect master AFTER the brief fade-out
            // (otherwise the gain ramp never gets to play); ignore disconnect errors
            setTimeout(() => { try {
                v.master.disconnect();
            }
            catch { /* noop */ } }, 200);
        }
        catch { /* noop */ }
    }
}
function registerVoice(master, stoppables, hardEndSec) {
    const v = { master, stoppables, timer: null };
    v.timer = setTimeout(() => _voices.delete(v), hardEndSec * 1000 + 500);
    _voices.add(v);
}
// Impulse-response cache: AudioBuffer is immutable and reusable across any number
// of ConvolverNodes; generating stereo 1.8–3.6s (~0.3–0.6 MB) + hundreds of thousands
// of Math.random() calls on EVERY finisher sound causes unnecessary churn during chains
const _impulseCache = new Map();
function reverb(c, duration = 1.8, decay = 2.5) {
    const rate = c.sampleRate;
    const key = `${duration}|${decay}|${rate}`;
    let impulse = _impulseCache.get(key);
    if (!impulse) {
        const len = Math.max(1, Math.floor(rate * duration));
        impulse = c.createBuffer(2, len, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < len; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
            }
        }
        _impulseCache.set(key, impulse);
    }
    const conv = c.createConvolver();
    conv.buffer = impulse;
    return conv;
}
let _noiseBuf = null;
function noiseBuffer(c) {
    if (!_noiseBuf || _noiseBuf.sampleRate !== c.sampleRate) {
        const len = Math.floor(c.sampleRate * 2);
        _noiseBuf = c.createBuffer(1, len, c.sampleRate);
        const d = _noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++)
            d[i] = Math.random() * 2 - 1;
    }
    return _noiseBuf;
}
/**
 * Building block: filtered white noise with a frequency ramp.
 * opts: { dur, type='bandpass', f0, f1, q=1, gain=0.5, at=0, attack=0.02 }
 */
function noise({ dur = 0.5, type = 'bandpass', f0 = 400, f1 = f0, q = 1, gain = 0.5, at = 0, attack = 0.02, dest }) {
    const c = ctx();
    const t = c.currentTime + at;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(Math.max(20, f0), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(t + dur + 0.05);
    return src;
}
/**
 * Building block: oscillator with a pitch glide (glissando).
 * opts: { wave='sine', f0, f1=f0, dur, gain=0.4, at=0, attack=0.01, detune=0 }
 */
function tone({ wave = 'sine', f0 = 440, f1 = f0, dur = 0.5, gain = 0.4, at = 0, attack = 0.01, dest }) {
    const c = ctx();
    const t = c.currentTime + at;
    const o = c.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
}
/** Short snap/crackle burst — used for embers, shattering ice/glass, and static. */
function pop({ at = 0, f = 2000, gain = 0.3, dur = 0.04, dest }) {
    return noise({ dur, type: 'bandpass', f0: f, f1: f * 0.6, q: 6, gain, at, attack: 0.004, dest });
}
/** Voice bus scaffold: master + dry/wet reverb, returns { out, master }. */
function scaffold(volume, reverbAmt = 0.3) {
    const c = ctx();
    const master = c.createGain();
    master.gain.value = Math.max(0.0001, volume * interfaceVolume());
    master.connect(c.destination);
    const wet = c.createGain();
    wet.gain.value = reverbAmt;
    const rev = reverb(c);
    wet.connect(rev);
    rev.connect(master);
    const dry = c.createGain();
    dry.gain.value = 1 - reverbAmt * 0.5;
    dry.connect(master);
    // Shared input bus: building blocks route into both dry and wet paths
    const out = c.createGain();
    out.connect(dry);
    out.connect(wet);
    return { out, master };
}
/* --------------------------------- flavors --------------------------------- */
const Flavors = {
    fire(volume) {
        const { out, master } = scaffold(volume, 0.25);
        const s = [
            noise({ dur: 1.4, type: 'bandpass', f0: 150, f1: 700, q: 0.8, gain: 0.5, dest: out }),
            noise({ dur: 1.8, type: 'lowpass', f0: 350, f1: 120, gain: 0.5, attack: 0.15, dest: out }),
            tone({ wave: 'sine', f0: 90, f1: 45, dur: 1.2, gain: 0.35, attack: 0.1, dest: out })
        ];
        for (let i = 0; i < 10; i++) {
            s.push(pop({ at: 0.2 + Math.random() * 1.4, f: 1200 + Math.random() * 2400, gain: 0.12 + Math.random() * 0.12, dur: 0.03, dest: out }));
        }
        registerVoice(master, s, 2.2);
    },
    cold(volume) {
        const { out, master } = scaffold(volume, 0.45);
        const s = [
            noise({ dur: 0.7, type: 'highpass', f0: 2800, f1: 4200, gain: 0.35, dest: out }),
            noise({ dur: 0.5, type: 'bandpass', f0: 700, f1: 2500, q: 2, gain: 0.4, at: 0.28, dest: out }),
            // Shatter beat (~1.9s into choreography): noise burst — previously the
            // loudest VISUAL climax beat had zero audio backing
            noise({ dur: 0.45, type: 'highpass', f0: 1800, f1: 5200, gain: 0.5, at: 1.9, dest: out })
        ];
        for (let i = 0; i < 7; i++) {
            s.push(tone({ wave: 'sine', f0: 1800 + Math.random() * 2200, f1: 2600, dur: 0.28, gain: 0.10, at: 0.24 + i * 0.05, attack: 0.005, dest: out }));
        }
        // 6 staggered crystal snaps — cracking fracture lines
        for (let i = 0; i < 6; i++) {
            s.push(pop({ at: 1.9 + Math.random() * 0.25, f: 3200 + Math.random() * 2400, gain: 0.18, dest: out }));
        }
        registerVoice(master, s, 2.4);
    },
    lightning(volume) {
        const { out, master } = scaffold(volume, 0.3);
        const s = [
            noise({ dur: 0.12, type: 'highpass', f0: 1600, f1: 4000, gain: 0.7, dest: out }),
            tone({ wave: 'sawtooth', f0: 1400, f1: 90, dur: 0.35, gain: 0.3, at: 0.02, dest: out }),
            tone({ wave: 'sine', f0: 70, f1: 32, dur: 0.8, gain: 0.55, at: 0.04, attack: 0.005, dest: out }),
            noise({ dur: 0.6, type: 'bandpass', f0: 300, f1: 90, q: 1.4, gain: 0.3, at: 0.05, dest: out })
        ];
        for (let i = 0; i < 4; i++) {
            s.push(pop({ at: 0.3 + i * 0.12, f: 2600, gain: 0.15, dest: out }));
        }
        registerVoice(master, s, 1.4);
    },
    thunder(volume) {
        const { out, master } = scaffold(volume, 0.35);
        const s = [
            tone({ wave: 'sine', f0: 55, f1: 24, dur: 2.2, gain: 0.65, attack: 0.02, dest: out }),
            noise({ dur: 2.4, type: 'lowpass', f0: 160, f1: 60, gain: 0.6, attack: 0.05, dest: out }),
            noise({ dur: 0.35, type: 'bandpass', f0: 500, f1: 150, q: 1, gain: 0.5, dest: out }),
            tone({ wave: 'sine', f0: 110, f1: 40, dur: 1.2, gain: 0.3, at: 0.05, dest: out })
        ];
        registerVoice(master, s, 2.8);
    },
    acid(volume) {
        const { out, master } = scaffold(volume, 0.35);
        const s = [
            noise({ dur: 1.6, type: 'lowpass', f0: 900, f1: 250, gain: 0.45, attack: 0.1, dest: out }),
            noise({ dur: 0.4, type: 'bandpass', f0: 1400, f1: 600, q: 3, gain: 0.3, dest: out })
        ];
        for (let i = 0; i < 12; i++) {
            const f = 120 + Math.random() * 480;
            s.push(tone({ wave: 'sine', f0: f, f1: f * (0.5 + Math.random()), dur: 0.09 + Math.random() * 0.08, gain: 0.08, at: 0.15 + Math.random() * 1.5, attack: 0.005, dest: out }));
        }
        registerVoice(master, s, 2.2);
    },
    poison(volume) {
        const { out, master } = scaffold(volume, 0.4);
        const s = [
            tone({ wave: 'sawtooth', f0: 190, f1: 130, dur: 1.8, gain: 0.12, attack: 0.3, dest: out }),
            tone({ wave: 'sawtooth', f0: 196, f1: 120, dur: 1.8, gain: 0.12, attack: 0.35, dest: out }),
            noise({ dur: 1.9, type: 'bandpass', f0: 300, f1: 180, q: 0.7, gain: 0.25, attack: 0.4, dest: out }),
            tone({ wave: 'sine', f0: 320, f1: 90, dur: 1.6, gain: 0.14, at: 0.2, attack: 0.2, dest: out })
        ];
        registerVoice(master, s, 2.3);
    },
    necrotic(volume) {
        const { out, master } = scaffold(volume, 0.45);
        const s = [
            tone({ wave: 'sawtooth', f0: 55, f1: 38, dur: 2.6, gain: 0.22, attack: 0.4, dest: out }),
            tone({ wave: 'sine', f0: 58, f1: 41, dur: 2.6, gain: 0.22, attack: 0.45, dest: out }),
            tone({ wave: 'sine', f0: 460, f1: 70, dur: 2.0, gain: 0.16, at: 0.3, attack: 0.3, dest: out }),
            noise({ dur: 2.4, type: 'bandpass', f0: 220, f1: 140, q: 0.6, gain: 0.18, attack: 0.5, dest: out })
        ];
        registerVoice(master, s, 3.0);
    },
    radiant(volume) {
        const { out, master } = scaffold(volume, 0.55);
        const s = [
            noise({ dur: 1.8, type: 'highpass', f0: 3800, f1: 5200, gain: 0.12, attack: 0.4, dest: out })
        ];
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
            s.push(tone({ wave: 'sine', f0: f, dur: 1.9, gain: 0.16, at: 0.12 + i * 0.13, attack: 0.25, dest: out }));
            s.push(tone({ wave: 'triangle', f0: f * 2, dur: 1.5, gain: 0.05, at: 0.2 + i * 0.13, attack: 0.3, dest: out }));
        });
        registerVoice(master, s, 2.6);
    },
    psychic(volume) {
        const { out, master } = scaffold(volume, 0.5);
        const c = ctx();
        const carrier = c.createOscillator();
        carrier.type = 'sine';
        const mod = c.createOscillator();
        mod.type = 'sine';
        mod.frequency.value = 7;
        const modGain = c.createGain();
        modGain.gain.value = 140;
        mod.connect(modGain);
        modGain.connect(carrier.frequency);
        carrier.frequency.value = 420;
        const g = c.createGain();
        const t = c.currentTime;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.3, t + 0.3);
        g.gain.setValueAtTime(0.3, t + 1.0);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
        carrier.connect(g);
        g.connect(out);
        carrier.start(t);
        carrier.stop(t + 2);
        mod.start(t);
        mod.stop(t + 2);
        const s = [
            carrier, mod,
            tone({ wave: 'sine', f0: 300, f1: 640, dur: 1.4, gain: 0.12, at: 0.4, attack: 0.3, dest: out }),
            noise({ dur: 0.6, type: 'bandpass', f0: 900, f1: 2600, q: 4, gain: 0.22, at: 0.9, dest: out })
        ];
        registerVoice(master, s, 2.3);
    },
    force(volume) {
        const { out, master } = scaffold(volume, 0.3);
        const s = [
            tone({ wave: 'sine', f0: 180, f1: 980, dur: 0.5, gain: 0.3, attack: 0.05, dest: out }),
            tone({ wave: 'sine', f0: 70, f1: 26, dur: 1.0, gain: 0.6, at: 0.45, attack: 0.01, dest: out }),
            noise({ dur: 1.2, type: 'bandpass', f0: 2000, f1: 300, q: 1.2, gain: 0.45, at: 0.45, dest: out }),
            tone({ wave: 'sawtooth', f0: 900, f1: 120, dur: 0.6, gain: 0.14, at: 0.45, dest: out })
        ];
        registerVoice(master, s, 1.8);
    },
    slash(volume) {
        const { out, master } = scaffold(volume, 0.2);
        const s = [
            noise({ dur: 0.22, type: 'bandpass', f0: 500, f1: 2600, q: 2.5, gain: 0.55, dest: out }),
            noise({ dur: 0.2, type: 'bandpass', f0: 700, f1: 2200, q: 2.5, gain: 0.5, at: 0.26, dest: out }),
            noise({ dur: 0.5, type: 'highpass', f0: 2400, f1: 3400, gain: 0.2, at: 0.32, dest: out }),
            tone({ wave: 'sine', f0: 140, f1: 60, dur: 0.4, gain: 0.4, at: 0.3, attack: 0.005, dest: out })
        ];
        registerVoice(master, s, 1.0);
    },
    pierce(volume) {
        const { out, master } = scaffold(volume, 0.25);
        const s = [
            noise({ dur: 0.14, type: 'highpass', f0: 1800, f1: 4200, gain: 0.4, dest: out }),
            tone({ wave: 'sine', f0: 2200, f1: 500, dur: 0.12, gain: 0.2, at: 0.1, dest: out }),
            tone({ wave: 'sine', f0: 95, f1: 34, dur: 0.6, gain: 0.55, at: 0.1, attack: 0.005, dest: out }),
            noise({ dur: 0.35, type: 'bandpass', f0: 350, f1: 110, q: 1.2, gain: 0.4, at: 0.1, dest: out })
        ];
        registerVoice(master, s, 1.1);
    },
    blunt(volume) {
        const { out, master } = scaffold(volume, 0.25);
        const s = [
            tone({ wave: 'sine', f0: 85, f1: 28, dur: 0.9, gain: 0.7, attack: 0.005, dest: out }),
            noise({ dur: 0.3, type: 'lowpass', f0: 500, f1: 150, gain: 0.55, dest: out }),
            noise({ dur: 0.8, type: 'lowpass', f0: 300, f1: 80, gain: 0.35, at: 0.05, attack: 0.05, dest: out })
        ];
        registerVoice(master, s, 1.4);
    },
    blood(volume) {
        const { out, master } = scaffold(volume, 0.25);
        const s = [
            noise({ dur: 0.35, type: 'bandpass', f0: 220, f1: 90, q: 1.6, gain: 0.65, dest: out }),
            tone({ wave: 'sine', f0: 120, f1: 40, dur: 0.5, gain: 0.4, attack: 0.005, dest: out }),
            noise({ dur: 0.28, type: 'bandpass', f0: 300, f1: 120, q: 2, gain: 0.5, at: 0.22, dest: out })
        ];
        for (let i = 0; i < 4; i++) {
            s.push(tone({ wave: 'sine', f0: 900 + Math.random() * 500, f1: 300, dur: 0.07, gain: 0.08, at: 0.5 + i * 0.16, attack: 0.004, dest: out }));
        }
        registerVoice(master, s, 1.6);
    },
    /* Crushing: beat-driven choreography — press rumble (0–0.85s), falling
       whoosh (~0.88s), slam (~1.03s), grinding crunches (~1.3s), blood geyser
       as the press lifts (~1.95s). Timings aligned with the retired bludgeoning finisher. */
    crush(volume) {
        const { out, master } = scaffold(volume, 0.25);
        const s = [
            // Build-up: heavy mass hovering over the victim
            noise({ dur: 0.85, type: 'lowpass', f0: 60, f1: 200, gain: 0.3, attack: 0.6, dest: out }),
            tone({ wave: 'sine', f0: 30, f1: 74, dur: 0.85, gain: 0.3, attack: 0.5, dest: out }),
            // Falling monolith whoosh
            noise({ dur: 0.16, type: 'highpass', f0: 500, f1: 2600, gain: 0.28, attack: 0.02, at: 0.87, dest: out }),
            // Slam: deep impact + crunch
            tone({ wave: 'sine', f0: 95, f1: 24, dur: 1.0, gain: 0.75, attack: 0.005, at: 1.02, dest: out }),
            noise({ dur: 0.25, type: 'lowpass', f0: 600, f1: 140, gain: 0.5, at: 1.02, dest: out }),
            noise({ dur: 0.3, type: 'bandpass', f0: 260, f1: 90, q: 1.6, gain: 0.6, at: 1.05, dest: out }),
            // Grind: press finishes flattening the target
            noise({ dur: 0.25, type: 'bandpass', f0: 220, f1: 80, q: 1.8, gain: 0.45, at: 1.32, dest: out }),
            // Geyser: wound bursts open with spray
            tone({ wave: 'sine', f0: 130, f1: 42, dur: 0.5, gain: 0.45, attack: 0.005, at: 1.95, dest: out }),
            noise({ dur: 0.5, type: 'bandpass', f0: 340, f1: 120, q: 2, gain: 0.55, at: 1.97, dest: out })
        ];
        for (let i = 0; i < 6; i++) {
            s.push(pop({ at: 2.0 + Math.random() * 0.5, f: 700 + Math.random() * 900, gain: 0.09, dur: 0.04, dest: out }));
        }
        registerVoice(master, s, 3.0);
    },
    soul(volume) {
        const { out, master } = scaffold(volume, 0.65);
        const s = [
            noise({ dur: 2.4, type: 'highpass', f0: 3000, f1: 4600, gain: 0.06, attack: 0.8, dest: out })
        ];
        [392, 523.25, 587.33, 783.99].forEach((f, i) => {
            s.push(tone({ wave: 'sine', f0: f, f1: f * 1.01, dur: 2.6, gain: 0.12, at: 0.15 + i * 0.18, attack: 0.6, dest: out }));
        });
        s.push(tone({ wave: 'sine', f0: 240, f1: 700, dur: 2.0, gain: 0.07, at: 0.5, attack: 0.7, dest: out }));
        registerVoice(master, s, 3.2);
    },
    glitch(volume) {
        const { out, master } = scaffold(volume, 0.15);
        const s = [];
        for (let i = 0; i < 12; i++) {
            const f = 120 + Math.random() * 2200;
            s.push(tone({ wave: 'square', f0: f, f1: f * (Math.random() < 0.5 ? 0.5 : 2), dur: 0.045, gain: 0.10, at: i * 0.07, attack: 0.002, dest: out }));
            if (i % 3 === 0)
                s.push(pop({ at: i * 0.07, f: 3000, gain: 0.12, dur: 0.03, dest: out }));
        }
        s.push(noise({ dur: 0.5, type: 'highpass', f0: 2000, f1: 3600, gain: 0.14, at: 0.85, dest: out }));
        registerVoice(master, s, 1.5);
    },
    void(volume) {
        const { out, master } = scaffold(volume, 0.4);
        const s = [
            tone({ wave: 'sine', f0: 34, f1: 30, dur: 2.4, gain: 0.6, attack: 0.5, dest: out }),
            tone({ wave: 'sine', f0: 36.5, f1: 32, dur: 2.4, gain: 0.4, attack: 0.6, dest: out }),
            tone({ wave: 'sine', f0: 900, f1: 180, dur: 1.6, gain: 0.05, at: 0.3, attack: 0.5, dest: out }),
            noise({ dur: 1.0, type: 'lowpass', f0: 500, f1: 100, gain: 0.2, at: 1.3, attack: 0.05, dest: out }),
            // Climax beats (aligned with Singularity timeline): sweep on the "heartbeat"
            // pulse and sub-bass burst on collapse — previously the drone cut into silence
            tone({ wave: 'sine', f0: 60, f1: 24, dur: 0.5, gain: 0.5, at: 2.35, attack: 0.01, dest: out }),
            tone({ wave: 'sine', f0: 48, f1: 20, dur: 0.9, gain: 0.65, at: 2.6, attack: 0.005, dest: out }),
            noise({ dur: 0.7, type: 'lowpass', f0: 700, f1: 80, gain: 0.45, at: 2.6, dest: out })
        ];
        registerVoice(master, s, 3.6);
    },
    generic(volume) {
        const { out, master } = scaffold(volume, 0.35);
        const s = [
            noise({ dur: 1.3, type: 'bandpass', f0: 120, f1: 500, q: 1.2, gain: 0.4, dest: out }),
            tone({ wave: 'sine', f0: 110, f1: 55, dur: 1.8, gain: 0.4, at: 0.1, attack: 0.05, dest: out })
        ];
        registerVoice(master, s, 2.2);
    }
};
/**
 * Play a synthesized finisher sound.
 * @param {string} flavor  key in Flavors
 * @param {number} volume  0..1 (before interface volume scaling)
 */
export function playFinisherSound(flavor, volume = 0.6) {
    const fn = Flavors[flavor] ?? Flavors.generic;
    try {
        fn(Math.min(1, Math.max(0, volume)));
    }
    catch (e) {
        console.warn(`showstopper | finisher sound '${flavor}' failed`, e);
    }
}
export const FINISHER_SOUND_FLAVORS = Object.keys(Flavors);
// Scene teardown: stop finisher voices so they don't bleed into the next canvas
// (same pattern as overlay-utils.mjs — Hooks is available at module top level)
Hooks.on('canvasTearDown', () => stopAllFinisherSounds());
