/**
 * Synthesised game sounds (WebAudio, no asset files): alarms, missile and
 * lock warnings, explosions, repair tones and the round countdown. Browsers
 * only allow audio after a user gesture, so the context starts on the first
 * click or key press and every call before that is silently skipped.
 */

let context: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
const lastPlayed = new Map<string, number>();

function audio() {
  if (typeof window === 'undefined') return null;
  if (!context) {
    const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return null;
    context = new Constructor();
    master = context.createGain();
    master.gain.value = muted ? 0 : .32;
    master.connect(context.destination);
  }
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context.state === 'running' ? context : null;
}

/** Call from a user gesture (click / key) so later sounds are allowed. */
export function unlockAudio() { audio(); }

export function setMuted(value: boolean) {
  muted = value;
  if (master) master.gain.value = muted ? 0 : .32;
}
export function isMuted() { return muted; }

/** Skips a sound if the same one played within `gap` ms, so bursts of events don't stack. */
function throttle(key: string, gap: number) {
  const now = performance.now();
  if ((lastPlayed.get(key) ?? -Infinity) + gap > now) return false;
  lastPlayed.set(key, now);
  return true;
}

function tone(frequency: number, start: number, duration: number, type: OscillatorType = 'sine', volume = .5, slideTo?: number) {
  const ctx = audio();
  if (!ctx || !master) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, ctx.currentTime + start);
  if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + start + duration);
  gain.gain.setValueAtTime(0, ctx.currentTime + start);
  gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + start + .01);
  gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + start + duration);
  oscillator.connect(gain).connect(master);
  oscillator.start(ctx.currentTime + start);
  oscillator.stop(ctx.currentTime + start + duration + .02);
}

function noise(start: number, duration: number, volume: number, lowpass: number) {
  const ctx = audio();
  if (!ctx || !master) return;
  const length = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / length) ** 2;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lowpass;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(filter).connect(gain).connect(master);
  source.start(ctx.currentTime + start);
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
    tone(220, 0, .9, 'sawtooth', .12); tone(330, 0, .9, 'sawtooth', .08);
  },
};
