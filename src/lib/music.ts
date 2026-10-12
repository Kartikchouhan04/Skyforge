/**
 * The adaptive soundtrack, generated live with WebAudio (no music files).
 *
 * A step sequencer (16th notes, scheduled ~150 ms ahead) plays one *mood* at a
 * time: the hangar theme, a lobby groove, the preparation build, combat,
 * Sudden Death and the results. Each mood has a tempo, a chord loop and its
 * own drum, bass, pad and arpeggio parts. During play, `setIntensity(0–1)`
 * adds and removes layers (and opens the bass filter) at bar lines, so the
 * music climbs when a missile is inbound or the clock runs down.
 *
 * Moods crossfade: every change starts a new session with its own gain node,
 * and the old one fades out with any notes still ringing.
 */
import { isMusicOn, liveAudio, musicBus, noiseBuffer } from '@/lib/sfx';

export type Mood = 'off' | 'hangar' | 'lobby' | 'prep' | 'combat' | 'sudden' | 'victory' | 'defeat';

type Chord = { root: number; minor: boolean };
type Style = {
  bpm: number;
  chords: Chord[];
  barsPerChord: number;
  /** Plays everything for one 16th note. `bar` counts from the mood's start. */
  step(voice: Voice, step: number, bar: number, chord: Chord, intensity: number): void;
};

const m = (root: number): Chord => ({ root, minor: true });
const M = (root: number): Chord => ({ root, minor: false });
// MIDI roots in the bass register. D minor throughout, so mood changes stay in key.
const D = 38, Eb = 39, F = 41, G = 43, A = 45, Bb = 34, C = 36;

const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const triad = (chord: Chord) => [0, chord.minor ? 3 : 4, 7].map((interval) => chord.root + interval);

/** The instruments, bound to one session's output and one note's start time. */
type Voice = {
  t: number;
  stepSeconds: number;
  kick(volume?: number): void;
  snare(volume?: number): void;
  hat(volume?: number, open?: boolean): void;
  crash(volume?: number): void;
  tom(midi: number, volume?: number): void;
  bass(midi: number, steps: number, cutoff: number, volume?: number, wave?: OscillatorType): void;
  pad(chord: Chord, steps: number, volume?: number, brightness?: number): void;
  pluck(midi: number, volume?: number, wave?: OscillatorType): void;
  riser(steps: number, volume?: number): void;
};

/* ------------------------------------------------------------ styles -- */

const STYLES: Record<Exclude<Mood, 'off'>, Style> = {
  /** Hangar: slow, wide pads and a sparse, echoing arpeggio. */
  hangar: {
    bpm: 84,
    chords: [m(D), M(Bb), m(G), M(A)],
    barsPerChord: 2,
    step(v, step, bar, chord) {
      const first = bar % 2 === 0;
      if (step === 0 && first) { v.pad(chord, 32, .07, .35); v.bass(chord.root - 12, 30, 160, .16, 'sine'); }
      if (step % 4 === 2) {
        const notes = triad(chord);
        v.pluck(notes[(step / 4 + bar * 2) % 3 | 0] + 24, .035, 'triangle');
      }
    },
  },
  /** Lobby and intermission: the hangar theme with a soft half-time beat. */
  lobby: {
    bpm: 96,
    chords: [m(D), M(Bb), M(F), M(C)],
    barsPerChord: 2,
    step(v, step, bar, chord, intensity) {
      const first = bar % 2 === 0;
      if (step === 0 && first) v.pad(chord, 32, .06, .4);
      if (step === 0 || step === 10) v.kick(.45);
      if (step === 8) v.snare(.12 + intensity * .1);
      if (step % 2 === 0) v.hat(step % 4 === 2 ? .05 : .025);
      if (step % 4 === 0) v.bass(chord.root - (step === 0 ? 12 : 0), 3, 300, .14);
      if (step % 4 === 3) v.pluck(triad(chord)[(step + bar) % 3] + 24, .03, 'triangle');
    },
  },
  /** Preparation: a tense pulse that grows a kick and a snare roll in the countdown. */
  prep: {
    bpm: 120,
    chords: [m(D), m(D), M(Bb), M(C)],
    barsPerChord: 1,
    step(v, step, bar, chord, intensity) {
      if (step === 0) v.pad(chord, 16, .05, .3 + intensity * .4);
      if (step % 2 === 0) v.bass(chord.root, 2, 260 + intensity * 900, .17);
      v.hat(step % 4 === 2 ? .045 : .018);
      if (step === 4 || step === 12) v.tom(chord.root + 24, .05);
      if (intensity > .5 && step % 4 === 0) v.kick(.6);
      // The last bar of each four builds: snare roll and a noise riser.
      if (intensity > .5 && bar % 4 === 3) {
        if (step >= 8) v.snare(.06 + (step - 8) * .02);
        if (step === 0) v.riser(16, .08);
      }
    },
  },
  /** Combat: four-on-the-floor, rolling bass, layers added with intensity. */
  combat: {
    bpm: 128,
    chords: [m(D), M(Bb), M(F), M(C)],
    barsPerChord: 2,
    step(v, step, bar, chord, intensity) {
      const phrase = bar % 8;
      if (step === 0 && phrase === 0 && intensity > .45) v.crash(.1);
      if (step === 0 && bar % 2 === 0) v.pad(chord, 32, .05 - intensity * .02, .25 + intensity * .3);
      if (intensity > .2 && step % 4 === 0) v.kick(.8);
      if (intensity > .75 && (step === 14 || step === 7)) v.kick(.45);
      if (intensity > .35 && (step === 4 || step === 12)) v.snare(.22);
      if (step % 2 === 1 || intensity > .6) v.hat(step % 4 === 2 ? .06 : .03, step % 8 === 6 && intensity > .5);
      // Rolling bass: off-beat 16ths on the root, an octave leap at the end of each beat.
      if (step % 4 !== 0) v.bass(chord.root + (step % 4 === 3 ? 12 : 0), 1, 380 + intensity * 1_700, .16);
      if (intensity > .55) {
        const notes = triad(chord);
        v.pluck(notes[step % 3] + (step % 6 < 3 ? 24 : 36), .02 + intensity * .015, 'square');
      }
      // A tom fill into every fourth bar.
      if (intensity > .45 && bar % 4 === 3 && step >= 12) v.tom(chord.root + 24 - (step - 12) * 3, .12);
    },
  },
  /** Sudden Death: faster, Phrygian, always driving, with an alarm-like lead. */
  sudden: {
    bpm: 142,
    chords: [m(D), M(Eb), m(D), M(C)],
    barsPerChord: 1,
    step(v, step, bar, chord, intensity) {
      if (step === 0 && bar % 4 === 0) v.crash(.12);
      if (step === 0) v.pad(chord, 16, .045, .55);
      if (step % 4 === 0) v.kick(.85);
      if (step === 10 && intensity > .5) v.kick(.5);
      if (step === 4 || step === 12) v.snare(.24);
      v.hat(step % 2 === 0 ? .05 : .025);
      v.bass(chord.root + (step % 8 === 6 ? 12 : 0), 1, 500 + intensity * 1_600, .14, 'square');
      if (step % 2 === 0) v.pluck(triad(chord)[(step / 2) % 3] + 24 + (step >= 8 ? 12 : 0), .022 + intensity * .02, 'sawtooth');
      if (bar % 4 === 3 && step >= 8 && step % 2 === 0) v.tom(chord.root + 24 - (step - 8), .13);
    },
  },
  /** Results, won: a bright anthem in F major. */
  victory: {
    bpm: 100,
    chords: [M(F), M(C), m(D), M(Bb)],
    barsPerChord: 1,
    step(v, step, bar, chord) {
      if (step === 0) { v.pad(chord, 16, .07, .55); v.bass(chord.root - 12, 14, 400, .16, 'triangle'); }
      if (step === 0 || step === 8) v.kick(.5);
      if (step === 4 || step === 12) v.snare(.1);
      if (step % 2 === 0) v.hat(.03);
      if (step % 2 === 0) v.pluck(triad(chord)[(step / 2) % 3] + 24 + (bar % 2) * 12, .03, 'triangle');
    },
  },
  /** Results, lost: slow and low. */
  defeat: {
    bpm: 70,
    chords: [m(D), m(G), M(Bb), M(A)],
    barsPerChord: 1,
    step(v, step, bar, chord) {
      if (step === 0) { v.pad(chord, 16, .07, .2); v.bass(chord.root - 12, 15, 140, .17, 'sine'); }
      if (step === 6 || step === 14) v.pluck(triad(chord)[(step / 8 + bar) % 3 | 0] + 12, .035, 'triangle');
    },
  },
};

/* ------------------------------------------------------- instruments -- */

let echo: { input: GainNode; delay: DelayNode } | null = null;

/** A dotted-eighth echo for plucks and leads, shared by every session. */
function echoFor(ctx: AudioContext, bus: GainNode) {
  if (!echo) {
    const input = ctx.createGain();
    input.gain.value = .45;
    const delay = ctx.createDelay(2);
    const feedback = ctx.createGain();
    feedback.gain.value = .38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2_400;
    input.connect(delay).connect(tone).connect(feedback).connect(delay);
    tone.connect(bus);
    echo = { input, delay };
  }
  return echo;
}

function voiceAt(ctx: AudioContext, out: GainNode, echoIn: GainNode, t: number, stepSeconds: number): Voice {
  const noise = noiseBuffer();
  const envelope = (gain: GainNode, volume: number, attack: number, hold: number, release: number) => {
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + attack);
    gain.gain.setValueAtTime(volume, t + attack + hold);
    gain.gain.setTargetAtTime(0, t + attack + hold, release / 4);
  };
  const noiseHit = (volume: number, type: BiquadFilterType, cutoff: number, decay: number) => {
    if (!noise) return;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.setTargetAtTime(0, t, decay / 4);
    source.connect(filter).connect(gain).connect(out);
    source.start(t, Math.random() * 1.5, Math.min(decay * 1.5, .5));
  };
  const oscillator = (wave: OscillatorType, hz: number) => {
    const node = ctx.createOscillator();
    node.type = wave;
    node.frequency.setValueAtTime(hz, t);
    return node;
  };

  return {
    t,
    stepSeconds,
    kick(volume = .8) {
      const body = oscillator('sine', 150);
      body.frequency.exponentialRampToValueAtTime(42, t + .11);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(.001, t + .34);
      body.connect(gain).connect(out);
      body.start(t);
      body.stop(t + .36);
    },
    snare(volume = .2) {
      noiseHit(volume, 'highpass', 1_400, .16);
      const body = oscillator('triangle', 190);
      body.frequency.exponentialRampToValueAtTime(140, t + .08);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume * .8, t);
      gain.gain.exponentialRampToValueAtTime(.001, t + .1);
      body.connect(gain).connect(out);
      body.start(t);
      body.stop(t + .12);
    },
    hat(volume = .04, open = false) { noiseHit(volume, 'highpass', 7_500, open ? .16 : .035); },
    crash(volume = .1) {
      if (!noise) return;
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 4_500;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, t);
      gain.gain.setTargetAtTime(0, t, .4);
      source.connect(filter).connect(gain).connect(out);
      source.start(t);
      source.stop(t + 2);
    },
    tom(midi, volume = .1) {
      const body = oscillator('sine', frequency(midi));
      body.frequency.exponentialRampToValueAtTime(frequency(midi) * .6, t + .18);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(.001, t + .22);
      body.connect(gain).connect(out);
      body.start(t);
      body.stop(t + .24);
    },
    bass(midi, steps, cutoff, volume = .15, wave = 'sawtooth') {
      const length = steps * stepSeconds;
      const source = oscillator(wave, frequency(midi));
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 4;
      filter.frequency.setValueAtTime(cutoff * 2.6, t);
      filter.frequency.setTargetAtTime(cutoff, t, .04);
      const gain = ctx.createGain();
      envelope(gain, volume, .006, Math.max(0, length * .7), Math.min(.25, length * .5 + .05));
      source.connect(filter).connect(gain).connect(out);
      source.start(t);
      source.stop(t + length + .3);
    },
    pad(chord, steps, volume = .06, brightness = .4) {
      const length = steps * stepSeconds;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(300 + brightness * 1_500, t);
      filter.frequency.linearRampToValueAtTime(400 + brightness * 2_200, t + length * .5);
      filter.frequency.linearRampToValueAtTime(300 + brightness * 1_500, t + length);
      const gain = ctx.createGain();
      envelope(gain, volume, Math.min(.8, length * .3), Math.max(0, length - 1.2), 1.2);
      filter.connect(gain).connect(out);
      for (const note of [...triad(chord), chord.root + 12].map((midi) => midi + 12)) {
        for (const detune of [-7, 7]) {
          const source = oscillator('sawtooth', frequency(note));
          source.detune.value = detune;
          source.connect(filter);
          source.start(t);
          source.stop(t + length + 1.4);
        }
      }
    },
    pluck(midi, volume = .03, wave = 'triangle') {
      const source = oscillator(wave, frequency(midi));
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(4_000, t);
      filter.frequency.exponentialRampToValueAtTime(900, t + .2);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(.0005, t + .28);
      source.connect(filter).connect(gain);
      gain.connect(out);
      gain.connect(echoIn);
      source.start(t);
      source.stop(t + .3);
    },
    riser(steps, volume = .08) {
      if (!noise) return;
      const length = steps * stepSeconds;
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 2;
      filter.frequency.setValueAtTime(300, t);
      filter.frequency.exponentialRampToValueAtTime(6_000, t + length);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + length);
      gain.gain.linearRampToValueAtTime(0, t + length + .05);
      source.connect(filter).connect(gain).connect(out);
      source.start(t);
      source.stop(t + length + .1);
    },
  };
}

/* --------------------------------------------------------- sequencer -- */

const LOOKAHEAD = .15;
const CROSSFADE = 1.4;

type Session = { mood: Exclude<Mood, 'off'>; out: GainNode; step: number; nextTime: number };

let mood: Mood = 'off';
let session: Session | null = null;
let target = .3;
let intensity = .3;
let timer: number | undefined;

function startSession(ctx: AudioContext, bus: GainNode, next: Exclude<Mood, 'off'>) {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, ctx.currentTime);
  out.gain.linearRampToValueAtTime(1, ctx.currentTime + CROSSFADE * .7);
  out.connect(bus);
  const style = STYLES[next];
  echoFor(ctx, bus).delay.delayTime.setTargetAtTime(60 / style.bpm * .75, ctx.currentTime, .05);
  return { mood: next, out, step: 0, nextTime: ctx.currentTime + .08 };
}

function endSession(ctx: AudioContext, old: Session) {
  old.out.gain.cancelScheduledValues(ctx.currentTime);
  old.out.gain.setValueAtTime(old.out.gain.value, ctx.currentTime);
  old.out.gain.linearRampToValueAtTime(0, ctx.currentTime + CROSSFADE);
  window.setTimeout(() => old.out.disconnect(), (CROSSFADE + 2) * 1_000);
}

function schedule() {
  const ctx = liveAudio();
  const bus = musicBus();
  if (!ctx || !bus) return;
  if (session && session.mood !== mood) { endSession(ctx, session); session = null; }
  if (mood === 'off' || !isMusicOn() || document.hidden) return;
  session ??= startSession(ctx, bus, mood);
  const style = STYLES[session.mood];
  const stepSeconds = 60 / style.bpm / 4;
  // After a stall (hidden tab, music toggled back on), pick up from now instead of catching up.
  if (session.nextTime < ctx.currentTime) session.nextTime = ctx.currentTime + .05;
  const echoIn = echoFor(ctx, bus).input;
  while (session.nextTime < ctx.currentTime + LOOKAHEAD) {
    const stepInBar = session.step % 16;
    const bar = Math.floor(session.step / 16);
    if (stepInBar === 0) intensity += (target - intensity) * .5;
    const chord = style.chords[Math.floor(bar / style.barsPerChord) % style.chords.length];
    style.step(voiceAt(ctx, session.out, echoIn, session.nextTime, stepSeconds), stepInBar, bar, chord, intensity);
    session.nextTime += stepSeconds;
    session.step += 1;
  }
}

/** Chooses what plays. Calling it again with the same mood does nothing. */
export function setMood(next: Mood) {
  if (typeof window === 'undefined') return;
  mood = next;
  timer ??= window.setInterval(schedule, 25);
}

/** 0 (calm) to 1 (everything at once). Takes effect gradually, at bar lines. */
export function setIntensity(value: number) {
  target = Math.max(0, Math.min(1, value));
}

export function currentMood() { return mood; }
