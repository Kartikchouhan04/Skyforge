/**
 * Synthesised game sounds (WebAudio, no asset files): alarms, missile and
 * lock warnings, explosions, repair tones, the round countdown, and the
 * continuous loops (your engine, the crowd). Browsers only allow audio after
 * a user gesture, so the context starts on the first click or key press and
 * every call before that is silently skipped.
 *
 * Mixer:
 *   effects ─┬────────────────┐
 *            └─ reverb send ──┤
 *   loops (engine, crowd) ────┼─ compressor ─ master ─ speakers
 *   music ─ duck ─┬───────────┤
 *                 └─ reverb ──┘
 * The music itself is generated in music.ts and plays into `musicBus()`.
 */

let context: AudioContext | null = null;
let master: GainNode | null = null;
let effects: GainNode | null = null;
let loops: GainNode | null = null;
let music: GainNode | null = null;
let ducker: GainNode | null = null;
let reverbIn: GainNode | null = null;
let whiteNoise: AudioBuffer | null = null;

const MASTER_LEVEL = .32;
const MUSIC_LEVEL = .55;
const SETTINGS_KEY = 'skyforge-audio';

let muted = false;
let musicOn = true;
const lastPlayed = new Map<string, number>();

(function loadSettings() {
  if (typeof window === 'undefined') return;
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}') as { muted?: boolean; music?: boolean };
    muted = saved.muted === true;
    musicOn = saved.music !== false;
  } catch { /* Defaults: sound and music on. */ }
})();

function saveSettings() {
  try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ muted, music: musicOn })); } catch { /* Settings just won't persist. */ }
}

/** A stadium-sized impulse response: 2.6 s of decaying stereo noise, darker as it fades. */
function stadiumImpulse(ctx: AudioContext) {
  const length = Math.floor(ctx.sampleRate * 2.6);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    let smooth = 0;
    for (let index = 0; index < length; index += 1) {
      const t = index / length;
      // A one-pole lowpass that closes over time: the tail loses its highs like a real hall.
      const k = .55 - t * .45;
      smooth += ((Math.random() * 2 - 1) - smooth) * k;
      data[index] = smooth * (1 - t) ** 2.4 * (index < ctx.sampleRate * .012 ? index / (ctx.sampleRate * .012) : 1);
    }
  }
  return impulse;
}

function build(ctx: AudioContext) {
  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER_LEVEL;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 10;
  compressor.ratio.value = 4;
  compressor.attack.value = .004;
  compressor.release.value = .2;
  compressor.connect(master).connect(ctx.destination);

  const reverb = ctx.createConvolver();
  reverb.buffer = stadiumImpulse(ctx);
  reverbIn = ctx.createGain();
  reverbIn.gain.value = 1;
  reverbIn.connect(reverb).connect(compressor);

  effects = ctx.createGain();
  effects.connect(compressor);
  const effectsSend = ctx.createGain();
  effectsSend.gain.value = .22;
  effects.connect(effectsSend).connect(reverbIn);

  loops = ctx.createGain();
  loops.connect(compressor);

  ducker = ctx.createGain();
  ducker.connect(compressor);
  const musicSend = ctx.createGain();
  musicSend.gain.value = .3;
  ducker.connect(musicSend).connect(reverbIn);
  music = ctx.createGain();
  music.gain.value = musicOn ? MUSIC_LEVEL : 0;
  music.connect(ducker);

  const length = ctx.sampleRate * 2;
  whiteNoise = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = whiteNoise.getChannelData(0);
  for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
}

function audio() {
  if (typeof window === 'undefined') return null;
  if (!context) {
    const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return null;
    context = new Constructor();
    build(context);
  }
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context.state === 'running' ? context : null;
}

/** The running context, without creating one (so nothing starts before a user gesture). */
export function liveAudio() {
  return context?.state === 'running' ? context : null;
}
/** Where music.ts plays. */
export function musicBus() { return liveAudio() ? music : null; }
/** Two seconds of white noise, looped or sliced by every noisy sound. */
export function noiseBuffer() { return whiteNoise; }

/** Call from a user gesture (click / key) so later sounds are allowed. */
export function unlockAudio() { audio(); }

export function setMuted(value: boolean) {
  muted = value;
  if (master && context) master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, context.currentTime, .03);
  saveSettings();
}
export function isMuted() { return muted; }

export function setMusicOn(value: boolean) {
  musicOn = value;
  if (music && context) music.gain.setTargetAtTime(musicOn ? MUSIC_LEVEL : 0, context.currentTime, .25);
  saveSettings();
}
export function isMusicOn() { return musicOn; }

/** Pulls the music down under a sting or fanfare, then lets it back up. */
export function duckMusic(seconds: number, depth = .2) {
  const ctx = liveAudio();
  if (!ctx || !ducker) return;
  const now = ctx.currentTime;
  ducker.gain.cancelScheduledValues(now);
  ducker.gain.setTargetAtTime(depth, now, .06);
  ducker.gain.setTargetAtTime(1, now + seconds, .6);
}

/** Skips a sound if the same one played within `gap` ms, so bursts of events don't stack. */
function throttle(key: string, gap: number) {
  const now = performance.now();
  if ((lastPlayed.get(key) ?? -Infinity) + gap > now) return false;
  lastPlayed.set(key, now);
  return true;
}

function tone(frequency: number, start: number, duration: number, type: OscillatorType = 'sine', volume = .5, slideTo?: number) {
  const ctx = audio();
  if (!ctx || !effects) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, ctx.currentTime + start);
  if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + start + duration);
  gain.gain.setValueAtTime(0, ctx.currentTime + start);
  gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + start + .01);
  gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + start + duration);
  oscillator.connect(gain).connect(effects);
  oscillator.start(ctx.currentTime + start);
  oscillator.stop(ctx.currentTime + start + duration + .02);
}

/** A slice of the shared noise buffer, filtered, fading out over `duration`. */
function noise(start: number, duration: number, volume: number, lowpass: number) {
  const ctx = audio();
  if (!ctx || !effects || !whiteNoise) return;
  const source = ctx.createBufferSource();
  source.buffer = whiteNoise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lowpass;
  const gain = ctx.createGain();
  const at = ctx.currentTime + start;
  // Roughly the old (1 - t)² fade, without building a new buffer for every shot.
  gain.gain.setValueAtTime(volume, at);
  gain.gain.setTargetAtTime(0, at, duration / 4);
  source.connect(filter).connect(gain).connect(effects);
  const length = Math.min(duration, 1.9);
  source.start(at, Math.random() * (2 - length), length);
}

export const sfx = {
  /** Two-tone siren: a tower in critical condition or destroyed. */
  alarm() {
    if (!throttle('alarm', 2_500)) return;
    for (let index = 0; index < 4; index += 1) {
      tone(880, index * .5, .24, 'square', .16);
      tone(660, index * .5 + .25, .24, 'square', .16);
    }
  },
  explosion(big = false) {
    if (!throttle(big ? 'boom' : 'pop', big ? 250 : 90)) return;
    noise(0, big ? 1.6 : .5, big ? .9 : .4, big ? 700 : 1_400);
    tone(big ? 70 : 120, 0, big ? 1 : .3, 'sine', big ? .6 : .3, 30);
  },
  /** Fast, high beeping: a missile is homing on you. */
  missileWarning() {
    if (!throttle('missile', 180)) return;
    tone(1_400, 0, .08, 'square', .14);
  },
  /** Slow steady tone: an enemy has a lock on you. */
  lockWarning() {
    if (!throttle('lock', 650)) return;
    tone(920, 0, .16, 'triangle', .12);
  },
  /** Short rising tone: your own lock is ready. */
  lockReady() {
    if (!throttle('ready', 900)) return;
    tone(1_200, 0, .07, 'sine', .1); tone(1_600, .08, .07, 'sine', .1);
  },
  /** A short burst of cannon fire. */
  cannon() {
    if (!throttle('cannon', 65)) return;
    noise(0, .07, .32, 2_600);
    tone(95, 0, .06, 'square', .12, 60);
  },
  /** Missile off the rail: a click, then the motor's roar. */
  missileLaunch() {
    if (!throttle('launch', 250)) return;
    tone(1_800, 0, .03, 'square', .08);
    noise(.2, 1.1, .55, 1_100);
    tone(180, .2, .9, 'sawtooth', .06, 520);
  },
  /** A flak shell bursting nearby. */
  flak() {
    if (!throttle('flak', 110)) return;
    noise(0, .3, .32, 650);
    tone(70, 0, .22, 'sine', .22, 40);
  },
  hit() {
    if (!throttle('hit', 60)) return;
    tone(2_200, 0, .04, 'square', .06);
  },
  repairDone() {
    tone(660, 0, .12, 'sine', .2); tone(880, .12, .12, 'sine', .2); tone(1_320, .24, .2, 'sine', .2);
  },
  repairInterrupted() {
    if (!throttle('interrupt', 400)) return;
    tone(220, 0, .3, 'sawtooth', .14, 140);
  },
  shield() {
    tone(300, 0, .5, 'sine', .22, 900);
  },
  countdown(final = false) {
    tone(final ? 1_320 : 880, 0, final ? .5 : .12, 'sine', .22);
  },
  horn() {
    duckMusic(1.1, .45);
    tone(220, 0, .9, 'sawtooth', .12); tone(330, 0, .9, 'sawtooth', .08);
  },

  /** Your own crew gun: a heavy flak cannon, deeper and longer than a jet's gun. */
  flakGun() {
    if (!throttle('flak-gun', 90)) return;
    noise(0, .16, .42, 1_100);
    tone(62, 0, .16, 'square', .16, 38);
  },
  /**
   * The Weapons Tower's automated flak. `level` 0–1 is the mount's height
   * (low sponsons sound deeper), `gain` 0–1 how close you are.
   */
  towerGun(level: number, gain: number) {
    if (gain <= .02 || !throttle('tower-gun', 120)) return;
    noise(0, .22, .38 * gain, 600 + level * 900);
    tone(48 + level * 40, 0, .2, 'square', .14 * gain, 30 + level * 20);
  },
  /** Riding a tower lift: a motor whine that falls going down and rises going up. */
  lift(up: boolean) {
    if (!throttle('lift', 900)) return;
    tone(up ? 140 : 300, 0, 1.1, 'sawtooth', .05, up ? 300 : 140);
    tone(up ? 280 : 600, 0, 1.1, 'sine', .04, up ? 600 : 280);
    tone(1_200, 0, .05, 'square', .05);
  },
  /** Driving between towers: a diesel rumble, repeated while on the move. */
  drive() {
    if (!throttle('drive', 700)) return;
    tone(46, 0, .75, 'sawtooth', .07, 52);
    noise(0, .75, .06, 260);
  },
  /** Set up at a station: the clunk of locking down. */
  setUp() {
    if (!throttle('setup', 400)) return;
    noise(0, .08, .35, 2_000);
    tone(180, 0, .12, 'square', .1, 90);
    tone(120, .1, .14, 'square', .08, 70);
  },
  /** A tower coming down: groaning steel, then the crash of the upper tower. */
  collapse(gain = 1) {
    if (!throttle('collapse', 1_500)) return;
    tone(110, 0, 1.4, 'sawtooth', .1 * gain, 38);
    tone(73, .15, 1.3, 'triangle', .12 * gain, 30);
    noise(.9, 1.8, .7 * gain, 420);
    noise(1.1, .9, .3 * gain, 1_800);
  },
  /** Your platform gave way: a falling whoosh and a hard landing. */
  thrownDown() {
    tone(900, 0, .55, 'sine', .14, 160);
    noise(0, .55, .12, 3_000);
    noise(.55, .35, .8, 500);
    tone(55, .55, .4, 'sine', .4, 30);
  },
  /** You took damage: a short metallic clank. */
  damaged() {
    if (!throttle('damaged', 140)) return;
    tone(420, 0, .09, 'square', .1, 260);
    noise(0, .07, .2, 3_500);
  },
  /** You got the kill. */
  kill() {
    tone(988, 0, .1, 'sine', .18); tone(1_319, .09, .1, 'sine', .18); tone(1_976, .18, .22, 'sine', .16);
  },
  /** You were eliminated. */
  eliminated() {
    duckMusic(1.6, .3);
    tone(440, 0, .9, 'triangle', .16, 110);
    tone(220, .1, 1, 'sine', .14, 70);
  },
  /** Round won (or lost): a short rising or falling sting. */
  roundResult(won: boolean) {
    duckMusic(1.4);
    const notes = won ? [523, 659, 784, 1_047] : [523, 466, 392, 311];
    notes.forEach((frequency, index) => tone(frequency, index * .14, index === notes.length - 1 ? .6 : .16, 'triangle', .16));
  },
  /** Match won or lost: a longer fanfare or a low fall. */
  matchResult(won: boolean) {
    duckMusic(2.8, .1);
    if (won) {
      [523, 659, 784, 1_047, 784, 1_047].forEach((frequency, index) => tone(frequency, index * .16, index === 5 ? 1.2 : .18, 'sawtooth', .09));
      tone(262, 0, 1.6, 'triangle', .14);
    } else {
      tone(392, 0, .5, 'triangle', .16, 330); tone(311, .5, .5, 'triangle', .16, 262); tone(196, 1, 1.4, 'triangle', .18, 98);
    }
  },
  /** Trigger pulled on an empty weapon. */
  empty() {
    if (!throttle('empty', 220)) return;
    tone(2_400, 0, .025, 'square', .08); tone(1_700, .04, .025, 'square', .06);
  },
  /** A quiet interface click. */
  click() {
    if (!throttle('click', 40)) return;
    tone(1_500, 0, .03, 'sine', .08);
  },
  /** The crowd roars: `strength` 0–1 (a kill ~.5, a tower or a round 1). */
  cheer(strength = 1) {
    crowd.cheer(strength);
  },
};

/* ------------------------------------------------------------- loops -- */

function loopedNoise(ctx: AudioContext) {
  const source = ctx.createBufferSource();
  source.buffer = whiteNoise;
  source.loop = true;
  source.start(ctx.currentTime, Math.random() * 2);
  return source;
}

function filter(ctx: AudioContext, type: BiquadFilterType, frequency: number, q = .7) {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

function silentGain(ctx: AudioContext) {
  const node = ctx.createGain();
  node.gain.value = 0;
  return node;
}

export type EngineState = {
  /** Throttle lever 0–1. */
  throttle: number;
  burner: boolean;
  /** Airspeed as a fraction of a fast jet's top speed (0–1+). */
  speed: number;
  /** Load factor in G. */
  g: number;
  stall: boolean;
};

/**
 * Your own jet, heard from the cockpit: a low rumble and turbine whine that
 * follow the throttle, the exhaust roar, the afterburner's thunder, and wind
 * that rises with airspeed and buffets under high G or in a stall.
 */
export const engine = (() => {
  let nodes: null | {
    out: GainNode;
    rumble: OscillatorNode; rumbleGain: GainNode;
    whine: OscillatorNode; whineGain: GainNode;
    roarFilter: BiquadFilterNode; roarGain: GainNode;
    burnerGain: GainNode;
    windFilter: BiquadFilterNode; windGain: GainNode;
    buffetGain: GainNode;
  } = null;

  function create(ctx: AudioContext) {
    if (!loops || !whiteNoise) return null;
    const out = silentGain(ctx);
    out.connect(loops);

    const rumble = ctx.createOscillator();
    rumble.type = 'sawtooth';
    rumble.frequency.value = 40;
    const rumbleGain = silentGain(ctx);
    rumble.connect(filter(ctx, 'lowpass', 180)).connect(rumbleGain).connect(out);
    rumble.start();

    const whine = ctx.createOscillator();
    whine.type = 'triangle';
    whine.frequency.value = 900;
    const whineGain = silentGain(ctx);
    whine.connect(whineGain).connect(out);
    whine.start();

    const roarFilter = filter(ctx, 'bandpass', 500, .6);
    const roarGain = silentGain(ctx);
    loopedNoise(ctx).connect(roarFilter).connect(roarGain).connect(out);

    const burnerGain = silentGain(ctx);
    loopedNoise(ctx).connect(filter(ctx, 'lowpass', 260, 1.2)).connect(burnerGain).connect(out);

    const windFilter = filter(ctx, 'highpass', 900, .5);
    const windGain = silentGain(ctx);
    loopedNoise(ctx).connect(windFilter).connect(windGain).connect(out);

    // Buffet: low noise, chopped by a 13 Hz square wave.
    const buffetGain = silentGain(ctx);
    const chop = silentGain(ctx);
    const chopper = ctx.createOscillator();
    chopper.type = 'square';
    chopper.frequency.value = 13;
    const chopDepth = ctx.createGain();
    chopDepth.gain.value = .5;
    chopper.connect(chopDepth).connect(chop.gain);
    chop.gain.value = .5;
    chopper.start();
    loopedNoise(ctx).connect(filter(ctx, 'lowpass', 140, 1)).connect(chop).connect(buffetGain).connect(out);

    return { out, rumble, rumbleGain, whine, whineGain, roarFilter, roarGain, burnerGain, windFilter, windGain, buffetGain };
  }

  return {
    /** Call ~10 times a second while you fly; pass null when you aren't in a jet. */
    update(state: EngineState | null) {
      const ctx = liveAudio();
      if (!ctx) return;
      if (!state) { if (nodes) nodes.out.gain.setTargetAtTime(0, ctx.currentTime, .25); return; }
      nodes ??= create(ctx);
      if (!nodes) return;
      const now = ctx.currentTime;
      const ease = .18;
      const throttle = Math.max(0, Math.min(1, state.throttle));
      const speed = Math.max(0, Math.min(1.3, state.speed));
      const burner = state.burner ? 1 : 0;
      nodes.out.gain.setTargetAtTime(1, now, .3);
      nodes.rumble.frequency.setTargetAtTime(34 + throttle * 26 + burner * 8, now, ease);
      nodes.rumbleGain.gain.setTargetAtTime(.14 + throttle * .16 + burner * .12, now, ease);
      nodes.whine.frequency.setTargetAtTime(700 + throttle * 1_500, now, .4);
      nodes.whineGain.gain.setTargetAtTime(.008 + throttle * .016, now, ease);
      nodes.roarFilter.frequency.setTargetAtTime(320 + throttle * 700 + burner * 300, now, ease);
      nodes.roarGain.gain.setTargetAtTime(.05 + throttle * .14, now, ease);
      nodes.burnerGain.gain.setTargetAtTime(burner * .55, now, burner ? .08 : .3);
      nodes.windFilter.frequency.setTargetAtTime(700 + speed * 1_600, now, ease);
      nodes.windGain.gain.setTargetAtTime(speed * speed * .12, now, ease);
      const buffet = state.stall ? .7 : Math.max(0, Math.min(1, (state.g - 5) / 4));
      nodes.buffetGain.gain.setTargetAtTime(buffet * .6, now, .1);
    },
  };
})();

/**
 * The stadium crowd: a murmuring bed that sits higher during play, and roars
 * on big moments. `level` also falls away as you climb out of the bowl.
 */
const crowd = (() => {
  let nodes: null | { out: GainNode; bedFilter: BiquadFilterNode; roar: GainNode; roarFilter: BiquadFilterNode } = null;
  let level = 0;

  function create(ctx: AudioContext) {
    if (!loops || !whiteNoise) return null;
    const out = silentGain(ctx);
    out.connect(loops);
    // The murmur: band-limited noise with a slow, uneven swell.
    const bedFilter = filter(ctx, 'bandpass', 700, .45);
    const swell = ctx.createGain();
    swell.gain.value = .8;
    for (const [rate, depth] of [[.13, .14], [.31, .08]] as const) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const amount = ctx.createGain();
      amount.gain.value = depth;
      lfo.connect(amount).connect(swell.gain);
      lfo.start();
    }
    loopedNoise(ctx).connect(bedFilter).connect(swell).connect(out);
    // The roar: brighter noise that only opens on a cheer.
    const roarFilter = filter(ctx, 'bandpass', 1_100, .35);
    const roar = silentGain(ctx);
    loopedNoise(ctx).connect(roarFilter).connect(roar).connect(out);
    return { out, bedFilter, roar, roarFilter };
  }

  return {
    /** 0 = silent (hangar), 1 = sitting in the stands. */
    setLevel(value: number) {
      const ctx = liveAudio();
      if (!ctx) return;
      level = Math.max(0, Math.min(1, value));
      if (!level && !nodes) return;
      nodes ??= create(ctx);
      if (!nodes) return;
      nodes.out.gain.setTargetAtTime(level * .2, ctx.currentTime, .8);
      nodes.bedFilter.frequency.setTargetAtTime(500 + level * 400, ctx.currentTime, .8);
    },
    cheer(strength: number) {
      const ctx = liveAudio();
      if (!ctx || !nodes || level <= 0 || !throttle('cheer', 500)) return;
      const now = ctx.currentTime;
      const peak = .6 + strength * 1.4;
      nodes.roar.gain.cancelScheduledValues(now);
      nodes.roar.gain.setTargetAtTime(peak, now, .12);
      nodes.roar.gain.setTargetAtTime(0, now + .5 + strength * 1.5, .9);
      nodes.roarFilter.frequency.setTargetAtTime(1_500, now, .1);
      nodes.roarFilter.frequency.setTargetAtTime(1_000, now + 1, .8);
      // A few whistles on the biggest moments.
      if (strength >= .8 && effects) {
        for (let index = 0; index < 3; index += 1) {
          const start = .15 + Math.random() * .9;
          const pitch = 1_700 + Math.random() * 900;
          tone(pitch, start, .35, 'sine', .025 * level, pitch * 1.25);
        }
      }
    },
  };
})();

export const crowdLevel = (value: number) => crowd.setLevel(value);
