import { ARENA, COMBAT, FLIGHT_SCALE, GRAVITY, JET_FLIGHT, type JetState } from './protocol';

/**
 * The flight model, shared by the authoritative server and offline training so
 * both fly identically.
 *
 * It is an "arcade-sim": the velocity always points along the nose (no
 * sideslip or angle of attack to manage), but everything else is physical.
 * Orientation is a quaternion, so loops, rolls and inverted flight all work.
 * The stick commands LOAD FACTOR (G), and lift acting on the banked wing is
 * what turns the jet. Gravity, thrust, drag and the induced drag of hard turns
 * all trade speed for altitude and manoeuvre, and below its stall speed a jet
 * can't hold itself up.
 *
 * Axes (body frame, model nose down +Z):
 *   forward F = q·(0,0,1)   up U = q·(0,1,0)   right R = q·(-1,0,0)
 * Positive roll banks right, positive pitch raises the nose, positive yaw
 * turns right — all as seen from the chase camera.
 */

export type FlightInput = {
  /** Stick: +1 full back (nose up), -1 full forward. */
  pitch: number;
  /** Turn: +1 right. Banks into a coordinated turn, plus a little rudder. */
  yaw: number;
  /** Manual roll: +1 right. Overrides the turn assist, for aerobatics. */
  roll: number;
  /** Throttle lever: +1 advances it, -1 retards it, 0 leaves it where it is. */
  throttle: number;
  boost: boolean;
  airBrake: boolean;
};

export type FlightResult = { approachingBoundary: boolean; hitBoundary: boolean };

type V3 = [number, number, number];
type Q = [number, number, number, number];

/* ---- small vector/quaternion kit (no three.js, so the server stays lean) -- */

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: V3): V3 => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function multiply(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function normalizeQ(q: Q): Q {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function rotate(q: Q, v: V3): V3 {
  // v' = v + 2w(u × v) + 2u × (u × v)
  const u: V3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

function axisAngle(axis: V3, angle: number): Q {
  const half = angle / 2;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/** Shortest rotation taking unit vector a onto unit vector b. */
function between(a: V3, b: V3): Q {
  const c = cross(a, b);
  return normalizeQ([c[0], c[1], c[2], 1 + dot(a, b)]);
}

/** Matches three.js Euler order 'YXZ' with x = -pitch, the client's render convention. */
function fromYawPitchRoll(yaw: number, pitch: number, roll: number): Q {
  const qy = axisAngle([0, 1, 0], yaw);
  const qx = axisAngle([1, 0, 0], -pitch);
  const qz = axisAngle([0, 0, 1], roll);
  return normalizeQ(multiply(multiply(qy, qx), qz));
}

/** The inverse: Euler YXZ out of a quaternion, so yaw/pitch/roll stay meaningful. */
function toYawPitchRoll(q: Q) {
  const [x, y, z, w] = q;
  const m13 = 2 * (x * z + y * w);
  const m23 = 2 * (y * z - x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const m21 = 2 * (x * y + z * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m31 = 2 * (x * z - y * w);
  const m11 = 1 - 2 * (y * y + z * z);
  const ex = Math.asin(-clamp(m23, -1, 1));
  if (Math.abs(m23) < .9999999) return { yaw: Math.atan2(m13, m33), pitch: -ex, roll: Math.atan2(m21, m22) };
  return { yaw: Math.atan2(-m31, m11), pitch: -ex, roll: 0 };
}

/* ---- public API ------------------------------------------------------- */

/** The lowest speed the model will integrate at, to keep turn maths finite. */
const SPEED_FLOOR = 30 * FLIGHT_SCALE;
/**
 * Beyond ~84° of bank (cos below this) the wing is too near vertical for any G
 * to hold the path. The turn assist's maxBank must stay below it.
 */
const KNIFE_EDGE = .1;

/** Puts a jet into a clean flying state at the given attitude. */
export function initFlight(jet: JetState, yaw: number, pitch = 0, roll = 0) {
  jet.q = fromYawPitchRoll(yaw, pitch, roll);
  jet.yaw = yaw; jet.pitch = pitch; jet.roll = roll;
  jet.throttle = .75;
  jet.gLoad = 1;
  jet.rollRate = 0;
  jet.stall = false;
  jet.gcas = false;
  jet.burner = false;
}

export function stepFlight(jet: JetState, input: FlightInput, dt: number): FlightResult {
  const spec = JET_FLIGHT[jet.model];
  const g = GRAVITY;
  let q = jet.q;
  const F = rotate(q, [0, 0, 1]);
  const U = rotate(q, [0, 1, 0]);
  const R = rotate(q, [-1, 0, 0]);
  const speed = Math.max(jet.speed, SPEED_FLOOR);

  // Attitude relative to the horizon. Straight up or down there is no horizon
  // to bank against, so fall back to the body's own right axis.
  const flatRight = cross(F, [0, 1, 0]);
  const levelRight = length(flatRight) > 1e-3 ? normalize(flatRight) : R;
  const levelUp = cross(levelRight, F);
  const bank = Math.atan2(dot(U, levelRight), dot(U, levelUp));
  const climb = Math.asin(clamp(F[1], -1, 1));

  let turn = clamp(input.yaw, -1, 1);
  let stick = clamp(input.pitch, -1, 1);
  let manualRoll = clamp(input.roll, -1, 1);
  let approachingBoundary = false;

  // ---- protection: automatic ground-collision avoidance (like Auto-GCAS),
  // a ceiling push-over, and a soft barrier that turns you back in.
  const lookahead = 2.2;
  const ahead: V3 = [jet.x + F[0] * speed * lookahead, jet.y + F[1] * speed * lookahead, jet.z + F[2] * speed * lookahead];
  const floorMargin = 120 * FLIGHT_SCALE;
  jet.gcas = false;
  if (ahead[1] < ARENA.minAltitude + floorMargin && F[1] < .25) {
    jet.gcas = true;
    manualRoll = 0; turn = 0;
    // Roll wings level first, then pull as hard as the airframe allows.
    stick = Math.abs(bank) < 1 ? 1 : 0;
  } else if (jet.y + F[1] * speed * .9 > ARENA.maxAltitude - floorMargin && F[1] > -.25) {
    approachingBoundary = true;
    stick = Math.min(stick, Math.abs(bank) < 1.6 ? -.45 : .45);
  }
  const wall = COMBAT.boundaryWarn;
  const outX = Math.abs(ahead[0]) > ARENA.halfWidth - wall;
  const outZ = Math.abs(ahead[2]) > ARENA.halfDepth - wall;
  if ((outX || outZ) && !jet.gcas) {
    approachingBoundary = true;
    const home = normalize([-jet.x, 0, -jet.z]);
    const side = dot(home, levelRight);
    // Already pointing back in: leave the pilot alone.
    if (dot(home, F) < .5) { turn = side >= 0 ? 1 : -1; manualRoll = 0; }
  }

  // ---- roll: manual roll for aerobatics, else bank-to-turn, else a gentle
  // wings-level assist (skipped near vertical, where bank has no meaning).
  const authority = clamp(speed / spec.cornerSpeed, .35, 1);
  let rollCommand: number;
  if (jet.gcas) rollCommand = clamp(-bank * 4, -spec.rollRate, spec.rollRate);
  else if (Math.abs(manualRoll) > .05) rollCommand = manualRoll * spec.rollRate;
  else if (Math.abs(turn) > .05) {
    // Never bank further than the G actually available can hold level:
    // 1/cos(bank) = G. As a hard turn bleeds speed the bank eases off, which
    // is how a pilot flies a sustained turn without sinking out of it.
    const holdable = Math.min(spec.maxG, (speed / spec.stallSpeed) ** 2) * .92;
    const bankLimit = holdable > 1 ? Math.acos(1 / holdable) : 0;
    rollCommand = clamp((turn * Math.min(spec.maxBank, bankLimit) - bank) * 5, -spec.rollRate, spec.rollRate);
  }
  else if (Math.abs(climb) < 1.25 && Math.abs(stick) < .1) rollCommand = clamp(-bank * 1.8, -spec.rollRate * .55, spec.rollRate * .55);
  else rollCommand = 0;
  // Roll inertia: the rate builds up and dies away instead of switching.
  jet.rollRate += (rollCommand * authority - jet.rollRate) * (1 - Math.exp(-dt * 9));

  // ---- load factor. Neutral stick HOLDS THE FLIGHT PATH — level, climbing,
  // banked or inverted — by commanding exactly the G that cancels gravity
  // across it: cos(climb) / cos(bank). That is why a banked turn holds
  // altitude, and why a climb stays a climb until the energy runs out. Back
  // stick adds G up to the airframe limit; forward stick takes it away into
  // negative G. Near knife-edge no G can hold the path, so it sags.
  const cosBank = Math.cos(bank);
  const hold = clamp(Math.abs(cosBank) > KNIFE_EDGE ? Math.cos(climb) / cosBank : 0, spec.minG, spec.maxG);
  let load = stick >= 0 ? hold + stick * (spec.maxG - hold) : hold + stick * (hold - spec.minG);
  // Lift available falls with the square of speed. Below it you can't pull
  // what you ask for — that is a stall.
  const available = (speed / spec.stallSpeed) ** 2;
  load = clamp(load, Math.max(spec.minG, -available * .6), Math.min(spec.maxG, available));
  jet.stall = available < 1.05;
  jet.gLoad = load;

  // ---- rotate. The flight path turns by the acceleration perpendicular to
  // it (lift along the wing's up axis, plus gravity); roll spins about the
  // nose; a little turn-assist yaw swings it about the vertical.
  const acceleration: V3 = add(scale(U, load * g), [0, -g, 0]);
  const perpendicular = add(acceleration, scale(F, -dot(acceleration, F)));
  const pathRate = scale(cross(F, perpendicular), 1 / speed);
  const rudder: V3 = [0, -turn * spec.rudderRate * authority, 0];
  const spin = scale(F, jet.rollRate);
  // Stall break: once the wing can't carry the jet, the nose falls toward the
  // ground — even from a dead-vertical climb, where gravity alone has no
  // sideways component to tip it over.
  let drop: V3 = [0, 0, 0];
  if (available < 1) {
    const down = add([0, -1, 0], scale(F, F[1]));
    const fall = length(down) > .05 ? normalize(down) : scale(U, -1);
    drop = scale(cross(F, fall), (1 - available) * 1.6);
  }
  const omega = add(add(add(pathRate, rudder), spin), drop);
  const rate = length(omega);
  if (rate > 1e-6) q = normalizeQ(multiply(axisAngle(scale(omega, 1 / rate), rate * dt), q));

  // ---- energy.
  jet.throttle = clamp(jet.throttle + input.throttle * .6 * dt, 0, 1);
  jet.burner = input.boost && !input.airBrake;
  const military = spec.thrust * g;
  const dragCoefficient = military / spec.maxSpeed ** 2;
  const thrust = military * (.15 + .85 * jet.throttle)
    + (jet.burner ? dragCoefficient * (spec.maxSpeed + spec.boostSpeed) ** 2 - military : 0);
  const drag = dragCoefficient * speed * speed * (input.airBrake ? 3.4 : 1);
  // Hard turns bleed energy: induced drag rises with the square of G.
  const induced = .02 * g * Math.max(0, load * load - 1);
  const newForward = rotate(q, [0, 0, 1]);
  const climbing = g * newForward[1];
  jet.speed = clamp(speed + (thrust - drag - induced - climbing) * dt, SPEED_FLOOR, (spec.maxSpeed + spec.boostSpeed) * 1.3);

  // ---- move, then keep inside the volume. At the wall the outward part of
  // the heading is removed (you slide along it) rather than snapping around.
  let forward = newForward;
  const travel = jet.speed * dt;
  jet.x += forward[0] * travel; jet.y += forward[1] * travel; jet.z += forward[2] * travel;
  const limitX = ARENA.halfWidth - COMBAT.boundaryInset;
  const limitZ = ARENA.halfDepth - COMBAT.boundaryInset;
  let hitBoundary = false;
  const slide = (axis: 0 | 1 | 2, outward: number) => {
    if (forward[axis] * outward > 0) {
      const next: V3 = [...forward] as V3;
      next[axis] = 0;
      if (length(next) > 1e-3) {
        const target = normalize(next);
        q = normalizeQ(multiply(between(forward, target), q));
        forward = target;
      }
    }
    hitBoundary = true;
  };
  if (Math.abs(jet.x) > limitX) { const outward = Math.sign(jet.x); jet.x = outward * limitX; slide(0, outward); }
  if (Math.abs(jet.z) > limitZ) { const outward = Math.sign(jet.z); jet.z = outward * limitZ; slide(2, outward); }
  if (jet.y < ARENA.minAltitude) { jet.y = ARENA.minAltitude; slide(1, -1); }
  if (jet.y > ARENA.maxAltitude) { jet.y = ARENA.maxAltitude; slide(1, 1); }

  jet.q = q;
  const euler = toYawPitchRoll(q);
  jet.yaw = euler.yaw; jet.pitch = euler.pitch; jet.roll = euler.roll;
  return { approachingBoundary: approachingBoundary || jet.gcas, hitBoundary };
}

/** Forward vector of a jet, from its orientation. */
export function noseOf(jet: Pick<JetState, 'q'>) {
  return rotate(jet.q, [0, 0, 1]);
}
