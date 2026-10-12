import { ARENA_SCALE, COMBAT, GRAVITY, GROUND, TOWER, type JetState, type PlayerInput, type TowerState, type ZoneState } from './protocol';
import { noseOf } from './flight';
import type { MatchPlayer, MatchRoom } from './match';

/**
 * Bot players for multiplayer rooms. Each tick a bot only chooses its
 * controls, exactly the PlayerInput a human sends, and the match rules
 * (match.ts) and flight model (flight.ts) do the rest, so bots fly, shoot,
 * repair and die by the same rules as everyone else.
 *
 * - Pilots dogfight the nearest enemy jet they can see. Attackers with no jet
 *   nearby make strafing runs on the towers (Shield first); defenders patrol
 *   over their own towers. In Sudden Death they keep inside the safe zone.
 *   They hold a lock briefly before firing a missile, and break hard when one
 *   is fired at them.
 * - Ground crews lead their flak onto the nearest attacker, fire SAMs on a
 *   lock, raise the shield when their tower is hurt under attack, and drive
 *   to the repair pad when it needs patching.
 *
 * Aim and reactions are deliberately imperfect, so humans can outfly them.
 */

/** Per-bot memory carried between ticks. */
export type BotBrain = {
  lockTarget: string | null;
  lockSince: number;
  evadeUntil: number;
  evadeTurn: number;
  /** After a strafing pass: fly clear until then before turning back in. */
  egressUntil: number;
  /** Slowly wandering aim error, so bots don't shoot perfectly. */
  wobble: number;
  seed: number;
};

/** Bot skill. Raise the hold or the wobble to make them easier. */
const BOT = {
  /** Seconds a lock must be held before a missile goes. */
  missileHold: 1.4,
  /** Radians of aim error, either way. */
  aimError: .028,
  /** Extra cone (as a multiple of the jet's size) a pilot will fire its cannon in. */
  cannonCone: 2.2,
  /** How close an enemy jet must be before an attacker leaves the towers to fight it. */
  engageRange: COMBAT.jetLockRange * 1.15,
  /** Defenders chase attackers this far from their own towers. */
  defendRange: TOWER.radarRange * .8,
  /** Ground crews patch a tower below this share of its health. */
  repairBelow: .75,
  /** Ground crews raise the shield below this share, with an attacker this close. */
  shieldBelow: .6,
  shieldThreat: TOWER.weaponsRange * 2.5,
  patrolAltitude: 120 * ARENA_SCALE,
  patrolRadius: 90 * ARENA_SCALE,
} as const;

type Point = { x: number; y: number; z: number };
const NEUTRAL: PlayerInput = { pitch: 0, yaw: 0, roll: 0, throttle: 1, boost: false, airBrake: false, primary: false, secondary: false };

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

export function newBrain(seed: number): BotBrain {
  return { lockTarget: null, lockSince: 0, evadeUntil: 0, evadeTurn: 1, egressUntil: 0, wobble: 0, seed };
}

/** Velocity of a jet: it always flies along its nose. */
function velocity(jet: JetState): Point {
  const nose = noseOf(jet);
  return { x: nose[0] * jet.speed, y: nose[1] * jet.speed, z: nose[2] * jet.speed };
}

/** Where to point so a shot at `shotSpeed` meets the target, with gravity drop allowed for. */
function leadPoint(from: Point, target: JetState, shotSpeed: number, drop = true): Point {
  const v = velocity(target);
  let time = distance(from, target) / shotSpeed;
  // Two refinements are plenty for these speeds.
  for (let pass = 0; pass < 2; pass += 1) time = distance(from, { x: target.x + v.x * time, y: target.y + v.y * time, z: target.z + v.z * time }) / shotSpeed;
  return { x: target.x + v.x * time, y: target.y + v.y * time + (drop ? .5 * GRAVITY * time * time : 0), z: target.z + v.z * time };
}

/**
 * Stick and turn inputs that point the nose at a point. The turn assist turns
 * "yaw" into a banked turn; pitch corrects the climb angle once roughly lined
 * up, and pulls to tighten the turn when the target is well off the nose.
 */
function steer(jet: JetState, goal: Point) {
  const nose = noseOf(jet);
  const dx = goal.x - jet.x; const dy = goal.y - jet.y; const dz = goal.z - jet.z;
  const flat = Math.hypot(dx, dz);
  const side = dx * -nose[2] + dz * nose[0];
  const front = dx * nose[0] + dz * nose[2];
  const off = Math.atan2(side, front);
  const yaw = clamp(off * 1.8, -1, 1);
  const climbError = Math.atan2(dy, flat) - Math.asin(clamp(nose[1], -1, 1));
  const pitch = Math.abs(off) > .5 ? clamp(.35 + Math.abs(off) * .3, 0, .85) : clamp(climbError * 3, -.8, .8);
  const facing = (dx * nose[0] + dy * nose[1] + dz * nose[2]) / Math.max(1, Math.hypot(dx, dy, dz));
  return { yaw, pitch, facing, off };
}

function enemiesOf(room: MatchRoom, bot: MatchPlayer, role?: JetState['role']) {
  const list: MatchPlayer[] = [];
  for (const other of room.players.values()) if (other.alive && other.team !== bot.team && (!role || other.role === role)) list.push(other);
  return list;
}

function nearest<T extends Point>(from: Point, list: T[], within = Infinity) {
  let best: T | undefined;
  let bestDistance = within;
  for (const item of list) { const d = distance(from, item); if (d < bestDistance) { bestDistance = d; best = item; } }
  return best;
}

/** Shield first (it halves damage to the others), then the guns, then the radar. */
const TOWER_ORDER: TowerState['kind'][] = ['shield', 'weapons', 'radar'];
function towerToAttack(room: MatchRoom, bot: MatchPlayer) {
  const standing = room.towers.filter((tower) => tower.hp > 0 && tower.team !== bot.team);
  return standing.sort((a, b) => TOWER_ORDER.indexOf(a.kind) - TOWER_ORDER.indexOf(b.kind))[0];
}

/** Holds the trigger on a lock only after it has been held a moment. */
function missileReady(bot: MatchPlayer, brain: BotBrain, now: number) {
  if (bot.targetId !== brain.lockTarget) { brain.lockTarget = bot.targetId; brain.lockSince = now; }
  return Boolean(bot.targetId) && now - brain.lockSince >= BOT.missileHold * 1_000;
}

function incomingMissile(room: MatchRoom, bot: MatchPlayer) {
  return room.projectiles.find((shot) => shot.targetId === bot.id && (shot.kind === 'missile' || shot.kind === 'sam') && distance(shot, bot) < COMBAT.jetLockRange * .9);
}

function pilotInput(room: MatchRoom, bot: MatchPlayer, brain: BotBrain, now: number, zone: ZoneState | null): PlayerInput {
  const input: PlayerInput = { ...NEUTRAL };

  // Missile coming: break hard across its path, on afterburner.
  const missile = incomingMissile(room, bot);
  if (missile && brain.evadeUntil < now) {
    const nose = noseOf(bot);
    const side = (missile.x - bot.x) * -nose[2] + (missile.z - bot.z) * nose[0];
    brain.evadeTurn = side > 0 ? -1 : 1;
    brain.evadeUntil = now + 1_600;
  }
  if (brain.evadeUntil > now) return { ...input, yaw: brain.evadeTurn, pitch: .9, boost: true };

  // Sudden Death: get back inside the ring before anything else.
  if (zone) {
    const fromCentre = Math.hypot(bot.x - zone.x, bot.z - zone.z);
    if (fromCentre > zone.radius * .82) {
      const toCentre = steer(bot, { x: zone.x, y: Math.max(bot.y, BOT.patrolAltitude), z: zone.z });
      return { ...input, yaw: toCentre.yaw, pitch: toCentre.pitch, boost: fromCentre > zone.radius };
    }
  }

  const attacking = room.defender !== null && room.defender !== bot.team;
  const ownTowers = room.towers.filter((tower) => tower.team === bot.team && tower.hp > 0);
  const home = ownTowers.length
    ? { x: ownTowers.reduce((sum, tower) => sum + tower.x, 0) / ownTowers.length, y: BOT.patrolAltitude, z: ownTowers.reduce((sum, tower) => sum + tower.z, 0) / ownTowers.length }
    : null;

  // Pick a jet to fight: near enough, and (for defenders) near our towers.
  const jets = enemiesOf(room, bot, 'pilot');
  const fightRange = attacking ? BOT.engageRange : Infinity;
  let foe = nearest(bot, jets, fightRange);
  if (foe && home && !attacking && Math.hypot(foe.x - home.x, foe.z - home.z) > BOT.defendRange && distance(bot, foe) > BOT.engageRange) foe = undefined;
  if (!room.defender) foe = nearest(bot, jets); // Sudden Death: everyone is fair game.

  if (foe) {
    const aim = leadPoint(bot, foe, COMBAT.cannonSpeed + bot.speed);
    aim.y += Math.sin(now / 900 + brain.seed) * brain.wobble * distance(bot, foe);
    const control = steer(bot, aim);
    const range = distance(bot, foe);
    const cone = Math.cos(Math.atan(COMBAT.jetHitRadius * BOT.cannonCone / Math.max(range, 1)) + BOT.aimError);
    input.yaw = control.yaw;
    input.pitch = control.pitch;
    input.primary = range < (COMBAT.cannonSpeed + bot.speed) * 1.1 && control.facing > cone;
    input.secondary = bot.missileAmmo > 0 && bot.missileCooldown <= 0 && bot.targetId === foe.id && missileReady(bot, brain, now);
    // Close the distance on afterburner when it's long and ahead.
    input.boost = range > COMBAT.jetLockRange * .7 && control.facing > .6;
    return input;
  }

  if (attacking) {
    const tower = towerToAttack(room, bot);
    if (tower) return strafe(bot, brain, tower, now);
  }

  // Patrol: a wide orbit over our own towers, or the middle of the stadium.
  const centre = home ?? { x: 0, y: BOT.patrolAltitude, z: 0 };
  const around = Math.atan2(bot.z - centre.z, bot.x - centre.x) + .5;
  const goal = { x: centre.x + Math.cos(around) * BOT.patrolRadius, y: BOT.patrolAltitude + Math.sin(now / 4_000 + brain.seed) * 15 * ARENA_SCALE, z: centre.z + Math.sin(around) * BOT.patrolRadius };
  const control = steer(bot, goal);
  input.yaw = control.yaw;
  input.pitch = control.pitch;
  return input;
}

/** A strafing run on a tower: dive in firing once lined up, pull away when close, then come round again. */
function strafe(bot: MatchPlayer, brain: BotBrain, tower: TowerState, now: number): PlayerInput {
  const input: PlayerInput = { ...NEUTRAL };
  const goal = { x: tower.x, y: TOWER.height * .62, z: tower.z };
  const flat = Math.hypot(goal.x - bot.x, goal.z - bot.z);
  if (flat < 85 * ARENA_SCALE && brain.egressUntil < now) brain.egressUntil = now + 4_500;
  if (brain.egressUntil > now) {
    // Climb out and away from the tower before turning back.
    const away = { x: bot.x + (bot.x - tower.x), y: BOT.patrolAltitude * 1.3, z: bot.z + (bot.z - tower.z) };
    const control = steer(bot, away);
    return { ...input, yaw: control.yaw, pitch: Math.max(control.pitch, .3), boost: true };
  }
  const control = steer(bot, goal);
  const range = distance(bot, goal);
  input.yaw = control.yaw;
  input.pitch = control.pitch;
  input.primary = range < (COMBAT.cannonSpeed + bot.speed) * 1.3 && control.facing > Math.cos(Math.atan(TOWER.radius * .9 / Math.max(range, 1)));
  input.secondary = bot.missileAmmo > 0 && bot.missileCooldown <= 0 && bot.targetId === `tower:${tower.id}` && missileReady(bot, brain, now);
  return input;
}

function groundInput(room: MatchRoom, bot: MatchPlayer, brain: BotBrain, now: number): PlayerInput {
  const input: PlayerInput = { ...NEUTRAL, throttle: 0, aimYaw: bot.yaw, aimPitch: bot.pitch };
  if (bot.transit > 0) return input;
  const station = room.stations[bot.station];
  const tower = station ? room.towers.find((item) => item.id === station.towerId) : undefined;
  const occupied = (index: number) => {
    const occupant = room.stations[index]?.occupantId;
    return Boolean(occupant && occupant !== bot.id && room.players.get(occupant)?.alive);
  };
  const freeGun = (towerId?: string) => room.stations.find((candidate) => candidate.kind === 'gun' && !occupied(candidate.index)
    && room.towers.some((item) => item.id === candidate.towerId && item.hp > 0) && (!towerId || candidate.towerId === towerId));

  // Our tower is gone: move to a gun at one still standing.
  if (!tower || tower.hp <= 0) {
    const next = freeGun();
    if (next) input.station = next.index;
    return input;
  }

  const attackers = enemiesOf(room, bot, 'pilot');
  const threat = nearest({ x: tower.x, y: 0, z: tower.z }, attackers, BOT.shieldThreat);
  const health = tower.hp / tower.maxHp;
  const canRepair = bot.repairCharges > 0 && bot.repairCooldown <= 0 && health < 1;

  if (station.kind === 'repair') {
    // Hold R until the repair lands, then head back to a gun at this tower.
    if (canRepair && health < .97) { input.repair = true; return input; }
    const back = freeGun(tower.id) ?? freeGun();
    if (back) input.station = back.index;
    return input;
  }

  if (health < BOT.shieldBelow && threat && bot.barrierCooldown <= 0) input.barrier = true;
  // Patch the tower when it's hurt and nothing is right on top of it.
  if (canRepair && health < BOT.repairBelow && !nearest({ x: tower.x, y: 0, z: tower.z }, attackers, TOWER.weaponsRange * 1.5)) {
    input.repair = true;
    return input;
  }

  // Shoot: lead the nearest attacker in reach.
  const target = nearest(bot, attackers, GROUND.samLockRange * 1.1);
  if (!target) return input;
  const aim = leadPoint(bot, target, GROUND.flakSpeed);
  brain.wobble = clamp(brain.wobble + (Math.sin(now / 700 + brain.seed * 3) * .004), -BOT.aimError, BOT.aimError);
  input.aimYaw = Math.atan2(aim.x - bot.x, aim.z - bot.z) + brain.wobble;
  input.aimPitch = clamp(Math.atan2(aim.y - bot.y, Math.hypot(aim.x - bot.x, aim.z - bot.z)) + brain.wobble * .5, GROUND.minAimPitch, GROUND.maxAimPitch);
  const range = distance(bot, target);
  input.primary = bot.flakAmmo > 0 && range < GROUND.flakSpeed * GROUND.flakLife * .95;
  input.secondary = bot.samAmmo > 0 && bot.missileCooldown <= 0 && bot.targetId === target.id && missileReady(bot, brain, now);
  return input;
}

/** Sets this tick's controls for every living bot. Called by the match before combat is stepped. */
export function driveBots(room: MatchRoom, now: number, zone: ZoneState | null) {
  for (const bot of room.players.values()) {
    if (!bot.bot || !bot.alive) continue;
    bot.brain ??= newBrain(bot.joinOrder * 1.37);
    // The pilot's aim wanders a little, so their gunnery isn't perfect.
    if (bot.role === 'pilot') bot.brain.wobble = BOT.aimError * Math.sin(now / 1_300 + bot.brain.seed);
    bot.input = bot.role === 'ground' ? groundInput(room, bot, bot.brain, now) : pilotInput(room, bot, bot.brain, now, zone);
  }
}
