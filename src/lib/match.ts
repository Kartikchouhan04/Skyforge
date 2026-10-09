import {
  ARENA, ARENA_SCALE, COMBAT, FLIGHT_SCALE, GRAVITY, COMBAT_COUNTDOWN_SECONDS, DEFENDER_PILOTS, GROUND, GROUND_LOADOUTS, LOBBY_SECONDS, MAX_ROUNDS, MAX_TEAM_SIZE, PREP_SECONDS,
  PROJECTILE_SPEED, REGULATION_ROUNDS, ROUNDS_PER_HALF, ROUND_SECONDS, TEAM_NAMES, TIEBREAKER_SECONDS, TOWER, WINS_NEEDED, otherTeam, towerLayout,
  type ArenaId, type CombatEvent, type GroundLoadout, type JetModel, type JetState, type MatchPhase, type PlayerInput, type ProjectileKind, type ProjectileState,
  type Role, type RolePreference, type RoomState, type RoundKind, type RoundRecord, type StationState, type Team, type TowerState,
} from './protocol';
import { initFlight, noseOf, stepFlight } from './flight';

/**
 * The authoritative Skyforge Stadium match: roles, the three strategic
 * towers, ground stations and repair pads, weapons and the 11-round format.
 * Pure logic with time passed in, so the multiplayer server and offline
 * training run exactly the same rules, and every hit, repair and tower
 * destruction is decided here.
 */

export const LOBBY_MS = LOBBY_SECONDS * 1_000;
export const PREP_MS = PREP_SECONDS * 1_000;
export const COUNTDOWN_MS = COMBAT_COUNTDOWN_SECONDS * 1_000;
export const INTERMISSION_MS = 9_000;
/** Longer break when the teams swap sides or head into the tiebreaker. */
export const SWITCH_INTERMISSION_MS = 14_000;
/** How long the results screen holds before the room resets for a rematch. */
export const RESULTS_HOLD_MS = 90_000;

export type MatchPlayer = JetState & {
  input: PlayerInput;
  preference: RolePreference;
  joinOrder: number;
  cannonReadyAt: number;
  missileReadyAt: number;
  repairReadyAt: number;
  barrierReadyAt: number;
  /** After an interrupted repair, R must be released before a new one can start. */
  repairLatch: boolean;
  boundaryAlertAt: number;
  /** Which wing pylon the next missile comes off. */
  pylon: number;
  transitFrom: { x: number; z: number };
  transitTo: { x: number; z: number };
  transitTotal: number;
};

type MatchProjectile = ProjectileState & { vx: number; vy: number; vz: number; life: number; damage: number; turn: number; age: number };
type MatchTower = TowerState & { defenceReadyAt: number; barrierUntil: number };

export type MatchRoom = {
  code: string;
  arenaId: ArenaId;
  practice: boolean;
  phase: MatchPhase;
  round: number;
  overtime: number;
  nextRound: number;
  nextOvertime: number;
  roundKind: RoundKind;
  defender: Team | null;
  players: Map<string, MatchPlayer>;
  towers: MatchTower[];
  stations: StationState[];
  projectiles: MatchProjectile[];
  roundWins: Record<Team, number>;
  roundWinner: Team | null;
  matchWinner: Team | null;
  history: RoundRecord[];
  lobbyStartsAt: number;
  prepEndsAt: number;
  countdownAt: number;
  intermissionAt: number;
  roundEndsAt: number;
  resultsUntil: number;
  events: CombatEvent[];
  sequence: number;
  joins: number;
};

const NEUTRAL_INPUT: PlayerInput = { pitch: 0, yaw: 0, roll: 0, throttle: 0, boost: false, airBrake: false, primary: false, secondary: false };
/** Ground units take gun stations one per tower first, then the second gun at each. */
const STATION_ORDER = [0, 2, 4, 1, 3, 5];

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function angleDelta(from: number, to: number) { return Math.atan2(Math.sin(to - from), Math.cos(to - from)); }
function direction(yaw: number, pitch: number) {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}
type Point = { x: number; y: number; z: number };
function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x; const dy = end.y - start.y; const dz = end.z - start.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const amount = lengthSquared === 0 ? 0 : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy + (point.z - start.z) * dz) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount), point.z - (start.z + dz * amount));
}

export function createMatchRoom(code: string, arenaId: ArenaId, practice = false): MatchRoom {
  return {
    code, arenaId, practice, phase: practice ? 'active' : 'lobby', round: 0, overtime: 0, nextRound: 1, nextOvertime: 0,
    roundKind: practice ? 'practice' : 'towers', defender: null,
    players: new Map(), towers: [], stations: [], projectiles: [],
    roundWins: { azure: 0, ember: 0 }, roundWinner: null, matchWinner: null, history: [],
    lobbyStartsAt: 0, prepEndsAt: 0, countdownAt: 0, intermissionAt: 0, roundEndsAt: 0, resultsUntil: 0, events: [], sequence: 0, joins: 0,
  };
}

export function emit(room: MatchRoom, type: CombatEvent['type'], text: string, details: Partial<CombatEvent> = {}) {
  room.events.push({ id: `${room.code}-${++room.sequence}`, type, text, ...details });
  if (room.events.length > 40) room.events.splice(0, room.events.length - 40);
}

export function teamCount(room: MatchRoom, team: Team) {
  let count = 0;
  for (const player of room.players.values()) if (player.team === team) count += 1;
  return count;
}

/** Defender pilots for a squad of n: two at full strength, scaled down for small rooms. */
export function defenderPilotCount(players: number) {
  return players >= 4 ? DEFENDER_PILOTS : players >= 2 ? 1 : 0;
}

export function defenderFor(round: number): Team | null {
  if (round > REGULATION_ROUNDS) return null;
  return round <= ROUNDS_PER_HALF ? 'azure' : 'ember';
}

/** Jets launch over their own team's airbase, alternating between its two airfields, facing down the stadium. */
export function spawnPoint(team: Team, slot: number) {
  const side = team === 'azure' ? -1 : 1;
  const yaw = team === 'azure' ? Math.PI / 2 : -Math.PI / 2;
  const field = slot % 2 ? 1 : -1;
  const lane = Math.floor(slot / 2) % 3 - 1;
  return { x: side * (345 + Math.floor(slot / 6) * 25) * ARENA_SCALE, y: (100 + (slot % 3) * 32) * ARENA_SCALE, z: (field * 145 + lane * 34) * ARENA_SCALE, yaw, pitch: 0, roll: 0, speed: COMBAT.spawnSpeed };
}

export function addPlayer(room: MatchRoom, options: { id: string; name: string; model: JetModel; preference?: RolePreference; team?: Team; loadout?: GroundLoadout }, now: number) {
  const team: Team = options.team ?? (teamCount(room, 'azure') <= teamCount(room, 'ember') ? 'azure' : 'ember');
  const point = spawnPoint(team, teamCount(room, team));
  const player: MatchPlayer = {
    id: options.id, name: options.name, team, model: options.model, role: 'pilot', ...point,
    hp: 100, alive: true, kills: 0, deaths: 0, missileCooldown: 0, targetId: null,
    q: [0, 0, 0, 1], throttle: .75, gLoad: 1, rollRate: 0, stall: false, gcas: false, burner: false,
    station: -1, transit: 0, repairCharges: 0, repairCooldown: 0, repairProgress: 0,
    loadout: options.loadout ?? 'balanced', flakAmmo: 0, samAmmo: 0, barrierCooldown: 0,
    spotted: false, damage: 0, towerDamage: 0, repaired: 0,
    input: { ...NEUTRAL_INPUT }, preference: options.preference ?? 'any', joinOrder: room.joins++,
    cannonReadyAt: 0, missileReadyAt: 0, repairReadyAt: 0, barrierReadyAt: 0, repairLatch: false, boundaryAlertAt: 0, pylon: 1,
    transitFrom: { x: 0, z: 0 }, transitTo: { x: 0, z: 0 }, transitTotal: 0,
  };
  initFlight(player, point.yaw);
  room.players.set(player.id, player);
  if (!room.practice) {
    // Joining during preparation still makes the round; once it's live there
    // are no respawns, so later joiners watch until the next one.
    if (room.phase === 'prep' || room.phase === 'countdown') lateDeploy(room, player);
    else if (room.phase === 'active' || room.phase === 'intermission') player.alive = false;
  }
  void now;
  return player;
}

export function removePlayer(room: MatchRoom, id: string) {
  const player = room.players.get(id);
  if (!player) return;
  releaseStation(room, player);
  room.players.delete(id);
}

export function setInput(room: MatchRoom, id: string, input: PlayerInput) {
  const player = room.players.get(id);
  if (player) player.input = input;
}

export function setPreference(room: MatchRoom, id: string, preference: RolePreference) {
  const player = room.players.get(id);
  if (player) player.preference = preference;
}

/** Equipment: airframe and ground loadout. Changes take effect during preparation (or any time in practice). */
export function equip(room: MatchRoom, id: string, choice: { model?: JetModel; loadout?: GroundLoadout }) {
  const player = room.players.get(id);
  if (!player) return;
  const between = room.practice || room.phase === 'lobby' || room.phase === 'prep' || room.phase === 'intermission' || room.phase === 'complete';
  if (!between) return;
  if (choice.model) player.model = choice.model;
  if (choice.loadout && GROUND_LOADOUTS[choice.loadout]) {
    player.loadout = choice.loadout;
    if (player.role === 'ground' && (room.practice || room.phase === 'prep')) {
      player.flakAmmo = GROUND_LOADOUTS[choice.loadout].flak;
      player.samAmmo = GROUND_LOADOUTS[choice.loadout].sams;
    }
  }
}

function releaseStation(room: MatchRoom, player: MatchPlayer) {
  for (const station of room.stations) if (station.occupantId === player.id) station.occupantId = null;
}

function occupantOf(room: MatchRoom, station: StationState) {
  const occupant = station.occupantId ? room.players.get(station.occupantId) : undefined;
  return occupant?.alive ? occupant : undefined;
}

/** Puts a player into the round in a role: a jet over its airbase, or a ground unit at a station. */
export function deployPlayer(room: MatchRoom, player: MatchPlayer, role: Role, slot: number, stationIndex = -1) {
  releaseStation(room, player);
  const loadout = GROUND_LOADOUTS[player.loadout] ?? GROUND_LOADOUTS.balanced;
  Object.assign(player, {
    role, hp: 100, alive: true, missileCooldown: 0, targetId: null, input: { ...NEUTRAL_INPUT },
    cannonReadyAt: 0, missileReadyAt: 0, repairReadyAt: 0, barrierReadyAt: 0, repairLatch: false, repairProgress: 0,
    transit: 0, transitTotal: 0, station: -1, spotted: false,
    repairCharges: role === 'ground' ? TOWER.repairCharges : 0, repairCooldown: 0, barrierCooldown: 0,
    flakAmmo: role === 'ground' ? loadout.flak : 0, samAmmo: role === 'ground' ? loadout.sams : 0,
  });
  if (role === 'pilot') {
    const point = spawnPoint(player.team, slot);
    Object.assign(player, point);
    initFlight(player, point.yaw);
    return;
  }
  const station = room.stations[stationIndex] ?? room.stations.find((candidate) => candidate.kind === 'gun' && !occupantOf(room, candidate));
  if (!station) { player.alive = false; return; }
  placeAtStation(player, station);
  Object.assign(player, {
    // Guns start pointed down the stadium, raised toward the attackers' approach.
    yaw: Math.atan2(-Math.sign(station.x), 0), pitch: .32, roll: 0, speed: 0,
    q: [0, 0, 0, 1], throttle: 0, gLoad: 1, rollRate: 0, stall: false, gcas: false, burner: false,
  });
}

function placeAtStation(player: MatchPlayer, station: StationState) {
  station.occupantId = player.id;
  Object.assign(player, { station: station.index, x: station.x, y: GROUND.gunHeight, z: station.z, transit: 0, transitTotal: 0, repairProgress: 0 });
}

/** Someone joining during preparation: fill whatever the squad is short of. */
function lateDeploy(room: MatchRoom, player: MatchPlayer) {
  const squad = [...room.players.values()].filter((other) => other.team === player.team && other !== player && other.alive);
  const pilots = squad.filter((other) => other.role === 'pilot').length;
  if (room.defender !== player.team || pilots < defenderPilotCount(squad.length + 1)) { deployPlayer(room, player, 'pilot', squad.length); return; }
  const free = STATION_ORDER.find((index) => !occupantOf(room, room.stations[index]));
  if (free === undefined) deployPlayer(room, player, 'pilot', squad.length);
  else deployPlayer(room, player, 'ground', 0, free);
}

/** Lays out towers, gun stations and repair pads for the team holding them. */
export function layOutTowers(room: MatchRoom, defender: Team | null) {
  room.defender = defender;
  if (!defender) { room.towers = []; room.stations = []; return; }
  const layout = towerLayout(defender);
  room.towers = layout.towers.map((tower) => ({ ...tower, hp: TOWER.hp, maxHp: TOWER.hp, crewed: false, shielded: tower.kind !== 'shield', barrier: 0, defenceReadyAt: 0, barrierUntil: 0 }));
  room.stations = layout.stations.map((station) => ({ ...station, occupantId: null }));
}

/** Sets up a round: towers, roles and positions. Combat waits for preparation and the countdown. */
function setUpRound(room: MatchRoom, now: number) {
  room.round = room.nextRound;
  room.overtime = room.nextOvertime;
  room.phase = 'prep';
  room.prepEndsAt = now + PREP_MS;
  room.roundWinner = null;
  room.projectiles = [];
  const defender = defenderFor(room.round);
  room.roundKind = defender ? 'towers' : 'tiebreaker';
  layOutTowers(room, defender);

  const slots: Record<Team, number> = { azure: 0, ember: 0 };
  const byJoin = (a: MatchPlayer, b: MatchPlayer) => a.joinOrder - b.joinOrder;
  for (const team of ['azure', 'ember'] as const) {
    const squad = [...room.players.values()].filter((player) => player.team === team).sort(byJoin);
    if (team !== defender) {
      for (const player of squad) deployPlayer(room, player, 'pilot', slots[team]++);
      continue;
    }
    // Defenders: those who asked to fly get the jets first, those who asked
    // for the ground last; join order breaks ties.
    const rank = (player: MatchPlayer) => player.preference === 'pilot' ? 0 : player.preference === 'any' ? 1 : 2;
    const ordered = [...squad].sort((a, b) => rank(a) - rank(b) || byJoin(a, b));
    const pilots = defenderPilotCount(squad.length);
    let groundIndex = 0;
    ordered.forEach((player, index) => {
      if (index < pilots) deployPlayer(room, player, 'pilot', slots[team]++);
      else deployPlayer(room, player, 'ground', 0, STATION_ORDER[groundIndex++ % STATION_ORDER.length]);
    });
  }
  const label = `ROUND ${room.round}${room.overtime ? ` · OVERTIME ${room.overtime}` : ''}`;
  emit(room, 'prep', defender
    ? `${label} — PREPARE · ${TEAM_NAMES[otherTeam(defender)]} ATTACKS · ${TEAM_NAMES[defender]} DEFENDS`
    : `${label} — PREPARE · TIEBREAKER 5V5 DOGFIGHT`, { round: room.round });
}

function beginCombat(room: MatchRoom, now: number) {
  room.phase = 'active';
  room.roundEndsAt = now + (room.defender ? ROUND_SECONDS : TIEBREAKER_SECONDS) * 1_000;
  for (const player of room.players.values()) { player.cannonReadyAt = now; player.missileReadyAt = now; }
  emit(room, 'round-start', `ROUND ${room.round}${room.overtime ? ` OT${room.overtime}` : ''} — WEAPONS FREE`, { round: room.round });
}

function endRound(room: MatchRoom, winner: Team | null, reason: string, now: number) {
  if (room.phase !== 'active' || room.practice) return;
  room.roundWinner = winner;
  room.history.push({ round: room.round, overtime: room.overtime, kind: room.roundKind, defender: room.defender, winner, reason });
  room.projectiles = [];
  if (winner) {
    room.roundWins[winner] += 1;
    emit(room, 'round-end', `${TEAM_NAMES[winner]} WINS ROUND ${room.round} — ${reason}`, { team: winner, round: room.round });
  } else {
    emit(room, 'round-end', `ROUND ${room.round} DRAWN — ${reason} · REPLAYING`, { round: room.round });
  }
  const leader = room.roundWins.azure > room.roundWins.ember ? 'azure' : room.roundWins.ember > room.roundWins.azure ? 'ember' : null;
  if ((winner && room.roundWins[winner] >= WINS_NEEDED) || (winner && room.round >= MAX_ROUNDS)) {
    room.phase = 'complete';
    room.matchWinner = winner && room.roundWins[winner] >= WINS_NEEDED ? winner : leader;
    room.resultsUntil = now + RESULTS_HOLD_MS;
    emit(room, 'match-end', room.matchWinner ? `${TEAM_NAMES[room.matchWinner]} WINS THE MATCH ${room.roundWins[room.matchWinner]}–${room.roundWins[otherTeam(room.matchWinner)]}` : 'MATCH DRAWN');
    return;
  }
  room.nextRound = winner ? room.round + 1 : room.round;
  room.nextOvertime = winner ? 0 : room.overtime + 1;
  room.phase = 'intermission';
  let pause = INTERMISSION_MS;
  if (room.nextRound !== room.round && room.nextRound === ROUNDS_PER_HALF + 1) {
    pause = SWITCH_INTERMISSION_MS;
    emit(room, 'sides', `SIDES SWITCH — ${TEAM_NAMES.ember} NOW DEFENDS THE TOWERS`);
  } else if (room.nextRound !== room.round && room.nextRound === MAX_ROUNDS) {
    pause = SWITCH_INTERMISSION_MS;
    emit(room, 'sides', `${room.roundWins.azure}–${room.roundWins.ember} — ROUND 11 TIEBREAKER · 5V5 DOGFIGHT`);
  }
  room.intermissionAt = now + pause;
}

export function resetToLobby(room: MatchRoom) {
  Object.assign(room, {
    phase: 'lobby', round: 0, overtime: 0, nextRound: 1, nextOvertime: 0, roundKind: 'towers', defender: null,
    towers: [], stations: [], projectiles: [], roundWins: { azure: 0, ember: 0 }, roundWinner: null, matchWinner: null, history: [],
    lobbyStartsAt: 0, prepEndsAt: 0, countdownAt: 0, intermissionAt: 0, roundEndsAt: 0, resultsUntil: 0,
  });
  const slots: Record<Team, number> = { azure: 0, ember: 0 };
  for (const player of room.players.values()) {
    Object.assign(player, { kills: 0, deaths: 0, damage: 0, towerDamage: 0, repaired: 0 });
    deployPlayer(room, player, 'pilot', slots[player.team]++);
  }
}

/* ---------------------------------------------------------------- towers -- */

function towerAimPoint(tower: TowerState) {
  return { x: tower.x, y: towerHeight(tower) * .62, z: tower.z };
}
function towerHeight(tower: TowerState) { return tower.hp > 0 ? TOWER.height : TOWER.height * .22; }
function standing(room: MatchRoom, kind: TowerState['kind']) {
  return room.towers.some((tower) => tower.kind === kind && tower.hp > 0);
}

/** What actually reaches a tower: the Shield Tower halves it for the other two, a defender's shield activation halves it again. */
export function towerDamageFactor(room: MatchRoom, tower: MatchTower, now: number) {
  let factor = 1;
  if (tower.kind !== 'shield' && standing(room, 'shield')) factor *= 1 - TOWER.shieldReduction;
  if (tower.barrierUntil > now) factor *= 1 - GROUND.barrierReduction;
  return factor;
}

const DESTROYED_TEXT: Record<TowerState['kind'], string> = {
  shield: 'SHIELD TOWER DESTROYED — RADAR & WEAPONS TOWERS NOW TAKE FULL DAMAGE',
  radar: 'RADAR TOWER DESTROYED — DEFENDER RADAR OFFLINE',
  weapons: 'WEAPONS TOWER DESTROYED — AUTOMATED DEFENCES OFFLINE',
};

function damageTower(room: MatchRoom, tower: MatchTower, amount: number, ownerId: string, team: Team, at: Point, now: number) {
  if (tower.hp <= 0) return;
  const before = tower.hp;
  tower.hp = Math.max(0, tower.hp - amount * towerDamageFactor(room, tower, now));
  const attacker = credit(room, ownerId);
  if (attacker) attacker.towerDamage += before - tower.hp;
  if (tower.hp === 0) {
    tower.barrierUntil = 0;
    emit(room, 'tower-down', `${DESTROYED_TEXT[tower.kind]} · ${ownerName(room, ownerId)}`, { team, ownerId, targetId: tower.id, x: tower.x, y: TOWER.height * .7, z: tower.z });
    return;
  }
  const critical = tower.maxHp * TOWER.critical;
  if (before >= critical && tower.hp < critical) {
    emit(room, 'tower-critical', `${tower.label} TOWER CRITICAL — ${Math.ceil(tower.hp / tower.maxHp * 100)}%`, { team, ownerId, targetId: tower.id, x: tower.x, y: TOWER.height * .6, z: tower.z });
    return;
  }
  // One alert per 10% lost, not per bullet.
  const step = tower.maxHp / 10;
  if (Math.floor(before / step) !== Math.floor(tower.hp / step)) {
    emit(room, 'tower-hit', `${tower.label} TOWER UNDER ATTACK — ${Math.ceil(tower.hp / tower.maxHp * 100)}%`, { team, ownerId, targetId: tower.id, x: at.x, y: at.y, z: at.z });
  }
}

/* ---------------------------------------------------------------- combat -- */

/** Pilots lock enemy jets in front first, then ground units and towers. */
function pilotTarget(room: MatchRoom, jet: MatchPlayer) {
  const nose = noseOf(jet);
  const facingOf = (dx: number, dy: number, dz: number, distance: number) => (dx * nose[0] + dy * nose[1] + dz * nose[2]) / Math.max(distance, 1);
  let best: string | null = null;
  let bestDistance: number = COMBAT.jetLockRange;
  for (const other of room.players.values()) {
    if (!other.alive || other.team === jet.team || other.role !== 'pilot') continue;
    const dx = other.x - jet.x; const dy = other.y - jet.y; const dz = other.z - jet.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < bestDistance && facingOf(dx, dy, dz, distance) > .18) { bestDistance = distance; best = other.id; }
  }
  if (best) return best;
  bestDistance = COMBAT.groundLockRange;
  for (const other of room.players.values()) {
    if (!other.alive || other.team === jet.team || other.role !== 'ground') continue;
    const dx = other.x - jet.x; const dy = other.y - jet.y; const dz = other.z - jet.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < bestDistance && facingOf(dx, dy, dz, distance) > .45) { bestDistance = distance; best = other.id; }
  }
  for (const tower of room.towers) {
    if (tower.hp <= 0 || tower.team === jet.team) continue;
    const aim = towerAimPoint(tower);
    const dx = aim.x - jet.x; const dy = aim.y - jet.y; const dz = aim.z - jet.z;
    const distance = Math.hypot(dx, dy, dz) - TOWER.radius;
    if (distance < bestDistance && facingOf(dx, dy, dz, distance + TOWER.radius) > .45) { bestDistance = distance; best = `tower:${tower.id}`; }
  }
  return best;
}

/** SAMs lock the enemy jet closest to where the gun points. */
function samTarget(room: MatchRoom, unit: MatchPlayer) {
  const aim = direction(unit.yaw, unit.pitch);
  let best: string | null = null;
  let bestFacing: number = GROUND.samLockCone;
  for (const other of room.players.values()) {
    if (!other.alive || other.team === unit.team || other.role !== 'pilot') continue;
    const dx = other.x - unit.x; const dy = other.y - unit.y; const dz = other.z - unit.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > GROUND.samLockRange) continue;
    const facing = (dx * aim.x + dy * aim.y + dz * aim.z) / Math.max(distance, 1);
    if (facing > bestFacing) { bestFacing = facing; best = other.id; }
  }
  return best;
}

function fire(room: MatchRoom, owner: { id: string; team: Team }, kind: ProjectileKind, origin: Point, yaw: number, pitch: number, damage: number, life: number, targetId: string | null, turn = 0, launchSpeed: number = PROJECTILE_SPEED[kind]) {
  const heading = direction(yaw, pitch);
  const speed = launchSpeed;
  room.projectiles.push({
    id: `${room.code}-p${++room.sequence}`, ownerId: owner.id, team: owner.team, kind,
    x: origin.x, y: origin.y, z: origin.z, yaw, pitch, speed, targetId,
    vx: heading.x * speed, vy: heading.y * speed, vz: heading.z * speed, life, damage, turn, age: 0,
  });
}

/** Rounds leave the barrel with a little dispersion, like a real gun. */
function spread(amount: number) { return (Math.random() - .5) * 2 * amount; }

function credit(room: MatchRoom, ownerId: string) {
  return room.players.get(ownerId);
}

function ownerName(room: MatchRoom, ownerId: string) {
  if (ownerId.startsWith('tower:')) {
    const tower = room.towers.find((item) => `tower:${item.id}` === ownerId);
    return `${tower?.label ?? 'TOWER'} TOWER`;
  }
  return credit(room, ownerId)?.name ?? 'UNKNOWN';
}

function interruptRepair(room: MatchRoom, unit: MatchPlayer, why: string) {
  if (unit.repairProgress <= 0) return;
  unit.repairProgress = 0;
  unit.repairLatch = true;
  emit(room, 'repair-interrupted', `REPAIR INTERRUPTED — ${unit.name} ${why}`, { team: unit.team, ownerId: unit.id, x: unit.x, y: unit.y, z: unit.z });
}

function damagePlayer(room: MatchRoom, target: MatchPlayer, amount: number, ownerId: string, team: Team) {
  const dealt = Math.min(amount, target.hp);
  target.hp = Math.max(0, target.hp - amount);
  const attacker = credit(room, ownerId);
  if (attacker) attacker.damage += dealt;
  if (target.role === 'ground') interruptRepair(room, target, 'UNDER FIRE');
  if (target.hp > 0) {
    emit(room, 'jet-hit', `HIT — ${target.name}`, { team, ownerId, targetId: target.id, x: target.x, y: target.y, z: target.z });
    return;
  }
  target.alive = false;
  target.deaths += 1;
  target.targetId = null;
  target.transit = 0;
  target.repairProgress = 0;
  releaseStation(room, target);
  if (attacker) attacker.kills += 1;
  const verb = target.role === 'ground' ? 'DESTROYED' : 'SHOT DOWN';
  emit(room, 'jet-down', `${ownerName(room, ownerId)} ${verb} ${target.name}${target.role === 'ground' ? ' (GROUND)' : ''}`, { team, ownerId, targetId: target.id, x: target.x, y: target.y, z: target.z });
}

function crash(room: MatchRoom, jet: MatchPlayer, what: string) {
  jet.hp = 0;
  jet.alive = false;
  jet.deaths += 1;
  jet.targetId = null;
  emit(room, 'jet-down', `${jet.name} CRASHED INTO ${what}`, { team: otherTeam(jet.team), targetId: jet.id, x: jet.x, y: jet.y, z: jet.z });
}

function stepPilot(room: MatchRoom, jet: MatchPlayer, now: number, dt: number) {
  const { approachingBoundary, hitBoundary } = stepFlight(jet, jet.input, dt);
  // Towers are solid.
  for (const tower of room.towers) {
    if (Math.hypot(jet.x - tower.x, jet.z - tower.z) < TOWER.radius + COMBAT.jetHitRadius * .4 && jet.y < towerHeight(tower)) {
      crash(room, jet, `THE ${tower.label} TOWER`);
      return;
    }
  }
  jet.targetId = pilotTarget(room, jet);
  if ((approachingBoundary || hitBoundary) && jet.boundaryAlertAt < now) {
    jet.boundaryAlertAt = now + 1_200;
    emit(room, 'boundary', hitBoundary ? `${jet.name} — STADIUM FLIGHT LIMIT` : jet.gcas ? `${jet.name} — PULL UP` : `${jet.name} — ENERGY BARRIER — TURNING BACK`, { team: jet.team, ownerId: jet.id, x: jet.x, y: jet.y, z: jet.z });
  }
  const nose = noseOf(jet);
  const muzzle = { x: jet.x + nose[0] * COMBAT.muzzleOffset, y: jet.y + nose[1] * COMBAT.muzzleOffset, z: jet.z + nose[2] * COMBAT.muzzleOffset };
  if (jet.input.primary && now >= jet.cannonReadyAt) {
    fire(room, jet, 'cannon', muzzle, jet.yaw + spread(COMBAT.cannonSpread), jet.pitch + spread(COMBAT.cannonSpread), COMBAT.cannonDamage, 1.7, null, 0, COMBAT.cannonSpeed + jet.speed);
    jet.cannonReadyAt = now + 115;
  }
  // RMB always launches, alternating wing pylons. With a lock the missile
  // guides onto it; without one it flies dead straight. Then a reload.
  if (jet.input.secondary && now >= jet.missileReadyAt) {
    const side = jet.pylon; jet.pylon = -jet.pylon;
    // Right vector in this world is (-cos yaw, 0, sin yaw).
    const pylon = { x: jet.x - Math.cos(jet.yaw) * side * 5 * FLIGHT_SCALE + nose[0] * 2 * FLIGHT_SCALE, y: jet.y - 1.6 * FLIGHT_SCALE, z: jet.z + Math.sin(jet.yaw) * side * 5 * FLIGHT_SCALE + nose[2] * 2 * FLIGHT_SCALE };
    fire(room, jet, 'missile', pylon, jet.yaw, jet.pitch, COMBAT.missileDamage, 5.5, jet.targetId, jet.targetId ? 1.8 : 0, Math.max(jet.speed, 60 * FLIGHT_SCALE));
    jet.missileReadyAt = now + COMBAT.missileReload * 1_000;
  }
  jet.missileCooldown = Math.max(0, (jet.missileReadyAt - now) / 1_000);
}

/** Drives a ground unit toward a station; the station is reserved the moment it sets off. */
function startDrive(room: MatchRoom, unit: MatchPlayer, station: StationState, instant: boolean) {
  releaseStation(room, unit);
  unit.repairProgress = 0;
  unit.targetId = null;
  if (instant) { placeAtStation(unit, station); return; }
  station.occupantId = unit.id;
  unit.transitFrom = { x: unit.x, z: unit.z };
  unit.transitTo = { x: station.x, z: station.z };
  unit.transitTotal = GROUND.redeploy * 2 + Math.hypot(station.x - unit.x, station.z - unit.z) / GROUND.driveSpeed;
  unit.transit = unit.transitTotal;
  unit.station = station.index;
}

function canTake(room: MatchRoom, unit: MatchPlayer, station: StationState | undefined): station is StationState {
  if (!station || station.index === unit.station) return false;
  const occupant = occupantOf(room, station);
  return !occupant || occupant.id === unit.id;
}

function updateCooldowns(unit: MatchPlayer, now: number) {
  unit.missileCooldown = Math.max(0, (unit.missileReadyAt - now) / 1_000);
  unit.repairCooldown = Math.max(0, (unit.repairReadyAt - now) / 1_000);
  unit.barrierCooldown = Math.max(0, (unit.barrierReadyAt - now) / 1_000);
}

/** Before combat: guns can aim, and in preparation units move between stations instantly. */
function stepPositioning(room: MatchRoom, now: number) {
  for (const unit of room.players.values()) {
    if (!unit.alive || unit.role !== 'ground') continue;
    const input = unit.input;
    if (Number.isFinite(input.aimYaw)) unit.yaw = input.aimYaw as number;
    if (Number.isFinite(input.aimPitch)) unit.pitch = clamp(input.aimPitch as number, GROUND.minAimPitch, GROUND.maxAimPitch);
    const requested = typeof input.station === 'number' ? room.stations[input.station] : undefined;
    if (room.phase === 'prep' && canTake(room, unit, requested)) startDrive(room, unit, requested, true);
    updateCooldowns(unit, now);
  }
}

function stepGround(room: MatchRoom, unit: MatchPlayer, now: number, dt: number) {
  const input = unit.input;
  if (Number.isFinite(input.aimYaw)) unit.yaw = input.aimYaw as number;
  if (Number.isFinite(input.aimPitch)) unit.pitch = clamp(input.aimPitch as number, GROUND.minAimPitch, GROUND.maxAimPitch);
  if (!input.repair) unit.repairLatch = false;

  // Station rotation: drive to a gun station or repair pad.
  const requested = typeof input.station === 'number' ? room.stations[input.station] : undefined;
  if (unit.transit <= 0 && canTake(room, unit, requested)) {
    if (unit.repairProgress > 0) interruptRepair(room, unit, 'LEFT THE REPAIR PAD');
    startDrive(room, unit, requested, false);
  }
  if (unit.transit > 0) {
    unit.transit = Math.max(0, unit.transit - dt);
    // Pack up, drive, then set up again.
    const driving = Math.max(.0001, unit.transitTotal - GROUND.redeploy * 2);
    const progress = clamp((unit.transitTotal - unit.transit - GROUND.redeploy) / driving, 0, 1);
    const eased = progress * progress * (3 - 2 * progress);
    unit.x = unit.transitFrom.x + (unit.transitTo.x - unit.transitFrom.x) * eased;
    unit.z = unit.transitFrom.z + (unit.transitTo.z - unit.transitFrom.z) * eased;
    unit.speed = progress > 0 && progress < 1 ? GROUND.driveSpeed : 0;
    updateCooldowns(unit, now);
    return;
  }
  unit.speed = 0;

  const station = room.stations[unit.station];
  const tower = station ? room.towers.find((item) => item.id === station.towerId) : undefined;

  // Shield activation on the tower beside this station.
  if (input.barrier && tower && tower.hp > 0 && now >= unit.barrierReadyAt) {
    tower.barrierUntil = now + GROUND.barrierDuration * 1_000;
    unit.barrierReadyAt = now + GROUND.barrierCooldown * 1_000;
    emit(room, 'barrier', `${unit.name} RAISED A SHIELD ON THE ${tower.label} TOWER`, { team: unit.team, ownerId: unit.id, targetId: tower.id, x: tower.x, y: TOWER.height * .5, z: tower.z });
  }

  // Repairs happen at a repair pad. R at a gun station heads for this tower's pad.
  if (input.repair && station?.kind === 'gun' && tower && tower.hp > 0 && tower.hp < tower.maxHp) {
    const pad = room.stations.find((candidate) => candidate.kind === 'repair' && candidate.towerId === tower.id);
    if (canTake(room, unit, pad)) { startDrive(room, unit, pad, false); updateCooldowns(unit, now); return; }
  }
  if (station?.kind === 'repair') {
    const canRepair = tower && tower.hp > 0 && tower.hp < tower.maxHp && unit.repairCharges > 0 && now >= unit.repairReadyAt;
    if (input.repair && !unit.repairLatch && canRepair) {
      unit.repairProgress += dt;
      if (unit.repairProgress >= TOWER.repairDuration) {
        const before = tower.hp;
        tower.hp = Math.min(tower.maxHp, tower.hp + TOWER.repairAmount);
        unit.repaired += tower.hp - before;
        unit.repairCharges -= 1;
        unit.repairReadyAt = now + TOWER.repairCooldown * 1_000;
        unit.repairProgress = 0;
        unit.repairLatch = true;
        emit(room, 'repair', `${unit.name} REPAIRED THE ${tower.label} TOWER — ${Math.ceil(tower.hp / tower.maxHp * 100)}%`, { team: unit.team, ownerId: unit.id, targetId: tower.id, x: tower.x, y: TOWER.height * .5, z: tower.z });
      }
    } else if (unit.repairProgress > 0) {
      // Let go of R, or the tower was destroyed mid-repair: nothing is spent.
      interruptRepair(room, unit, tower && tower.hp <= 0 ? '— TOWER LOST' : 'STOPPED');
    }
  }

  if (room.practice) {
    // Practice never runs dry.
    const loadout = GROUND_LOADOUTS[unit.loadout] ?? GROUND_LOADOUTS.balanced;
    if (unit.flakAmmo <= 0) unit.flakAmmo = loadout.flak;
    if (unit.samAmmo <= 0) unit.samAmmo = loadout.sams;
    if (unit.repairCharges <= 0) unit.repairCharges = TOWER.repairCharges;
  }

  // Weapons are stowed while repairing.
  unit.targetId = unit.repairProgress > 0 ? null : samTarget(room, unit);
  if (unit.repairProgress <= 0) {
    const aim = direction(unit.yaw, unit.pitch);
    const muzzle = { x: unit.x + aim.x * 4 * ARENA_SCALE, y: unit.y + aim.y * 4 * ARENA_SCALE, z: unit.z + aim.z * 4 * ARENA_SCALE };
    if (input.primary && now >= unit.cannonReadyAt && unit.flakAmmo > 0) {
      fire(room, unit, 'flak', muzzle, unit.yaw + spread(GROUND.flakSpread), unit.pitch + spread(GROUND.flakSpread), GROUND.flakDamage, GROUND.flakLife, null);
      unit.flakAmmo -= 1;
      unit.cannonReadyAt = now + GROUND.flakInterval * 1_000;
    }
    if (input.secondary && now >= unit.missileReadyAt && unit.samAmmo > 0) {
      fire(room, unit, 'sam', muzzle, unit.yaw, Math.max(unit.pitch, .25), GROUND.samDamage, 6, unit.targetId, unit.targetId ? GROUND.samTurn : 0, 60 * FLIGHT_SCALE);
      unit.samAmmo -= 1;
      unit.missileReadyAt = now + GROUND.samCooldown * 1_000;
    }
  }
  updateCooldowns(unit, now);
}

/** Tower state flags, and the Weapons Tower's automated, leading flak. */
function stepTowers(room: MatchRoom, now: number) {
  const shieldUp = standing(room, 'shield');
  for (const tower of room.towers) {
    tower.crewed = tower.hp > 0 && room.stations.some((station) => {
      if (station.kind !== 'gun' || station.towerId !== tower.id) return false;
      const crew = occupantOf(room, station);
      return Boolean(crew && crew.transit <= 0);
    });
    tower.shielded = tower.hp > 0 && tower.kind !== 'shield' && shieldUp;
    tower.barrier = tower.hp > 0 ? Math.max(0, (tower.barrierUntil - now) / 1_000) : 0;
    if (tower.kind !== 'weapons' || tower.hp <= 0 || now < tower.defenceReadyAt) continue;
    const top = { x: tower.x, y: TOWER.height * .95, z: tower.z };
    let target: MatchPlayer | undefined;
    let best: number = TOWER.weaponsRange;
    for (const jet of room.players.values()) {
      if (!jet.alive || jet.team === tower.team || jet.role !== 'pilot') continue;
      const distance = Math.hypot(jet.x - top.x, jet.y - top.y, jet.z - top.z);
      if (distance < best) { best = distance; target = jet; }
    }
    if (!target) continue;
    const nose = noseOf(target);
    const lead = best / GROUND.flakSpeed;
    const aimX = target.x + nose[0] * target.speed * lead - top.x;
    const aimY = target.y + nose[1] * target.speed * lead - top.y;
    const aimZ = target.z + nose[2] * target.speed * lead - top.z;
    fire(room, { id: `tower:${tower.id}`, team: tower.team }, 'flak', top, Math.atan2(aimX, aimZ), Math.atan2(aimY, Math.hypot(aimX, aimZ)), TOWER.weaponsDamage, GROUND.flakLife, null);
    tower.defenceReadyAt = now + (tower.crewed ? TOWER.weaponsCrewedInterval : TOWER.weaponsInterval) * 1_000;
  }
}

function homingPoint(room: MatchRoom, targetId: string): Point | null {
  if (targetId.startsWith('tower:')) {
    const tower = room.towers.find((item) => `tower:${item.id}` === targetId && item.hp > 0);
    return tower ? towerAimPoint(tower) : null;
  }
  const target = room.players.get(targetId);
  return target?.alive ? target : null;
}

function stepProjectiles(room: MatchRoom, now: number, dt: number) {
  for (let index = room.projectiles.length - 1; index >= 0; index -= 1) {
    const shot = room.projectiles[index];
    shot.life -= dt;
    shot.age += dt;
    const previous = { x: shot.x, y: shot.y, z: shot.z };
    const rocket = shot.kind === 'missile' || shot.kind === 'sam';
    const motor = rocket && shot.age > COMBAT.missileDrop;
    if (rocket) {
      // Off the rail it falls briefly, then the motor lights and accelerates it to full speed.
      if (motor) shot.speed = Math.min(PROJECTILE_SPEED[shot.kind], shot.speed + COMBAT.missileAccel * dt);
      const heading = direction(shot.yaw, shot.pitch);
      shot.vx = heading.x * shot.speed; shot.vy = heading.y * shot.speed - (motor ? 0 : GRAVITY * shot.age); shot.vz = heading.z * shot.speed;
    } else {
      // Shells drop under gravity.
      shot.vy -= GRAVITY * dt;
      shot.pitch = Math.atan2(shot.vy, Math.hypot(shot.vx, shot.vz));
    }
    if (motor && shot.turn && shot.targetId) {
      const goal = homingPoint(room, shot.targetId);
      if (goal) {
        const dx = goal.x - shot.x; const dy = goal.y - shot.y; const dz = goal.z - shot.z;
        shot.yaw += clamp(angleDelta(shot.yaw, Math.atan2(dx, dz)), -shot.turn * dt, shot.turn * dt);
        shot.pitch += clamp(angleDelta(shot.pitch, Math.atan2(dy, Math.hypot(dx, dz))), -shot.turn * .75 * dt, shot.turn * .75 * dt);
        const heading = direction(shot.yaw, shot.pitch);
        shot.vx = heading.x * shot.speed; shot.vy = heading.y * shot.speed; shot.vz = heading.z * shot.speed;
      }
    }
    shot.x += shot.vx * dt; shot.y += shot.vy * dt; shot.z += shot.vz * dt;
    const gone = shot.life <= 0 || Math.abs(shot.x) > ARENA.halfWidth + COMBAT.projectileMargin || Math.abs(shot.z) > ARENA.halfDepth + COMBAT.projectileMargin
      || shot.y < 0 || shot.y > ARENA.maxAltitude + COMBAT.projectileMargin;
    if (gone || hitSomething(room, shot, previous, now)) room.projectiles.splice(index, 1);
  }
}

function hitSomething(room: MatchRoom, shot: MatchProjectile, previous: Point, now: number) {
  for (const target of room.players.values()) {
    if (!target.alive || target.team === shot.team) continue;
    const ground = target.role === 'ground';
    // Flak is anti-aircraft only; its proximity fuse widens the hit.
    if (shot.kind === 'flak' && ground) continue;
    const radius = ground ? GROUND.hitRadius : shot.kind === 'flak' ? COMBAT.jetHitRadius * GROUND.flakFuse : COMBAT.jetHitRadius;
    if (distanceToSegment(target, previous, shot) > radius) continue;
    damagePlayer(room, target, shot.damage, shot.ownerId, shot.team);
    return true;
  }
  for (const tower of room.towers) {
    if (tower.team === shot.team) continue;
    const height = towerHeight(tower);
    if (shot.y > height || Math.hypot(shot.x - tower.x, shot.z - tower.z) > TOWER.radius) continue;
    damageTower(room, tower, shot.damage, shot.ownerId, shot.team, shot, now);
    return true;
  }
  return false;
}

/**
 * Who sees whom. While the Radar Tower stands, every attacker inside its
 * range is shown to all defenders. Jets also see enemies close to them, and
 * ground units at their known stations are always visible.
 */
function updateSensors(room: MatchRoom) {
  const sensorRange = COMBAT.jetLockRange * 1.6;
  const radar = room.towers.find((tower) => tower.kind === 'radar' && tower.hp > 0);
  const players = [...room.players.values()];
  for (const player of players) {
    if (player.role === 'ground') { player.spotted = true; continue; }
    if (radar && player.team !== radar.team && Math.hypot(player.x - radar.x, player.z - radar.z) < TOWER.radarRange) { player.spotted = true; continue; }
    player.spotted = players.some((other) => other.alive && other.team !== player.team && other.role === 'pilot'
      && Math.hypot(other.x - player.x, other.y - player.y, other.z - player.z) < sensorRange);
  }
}

function checkRoundEnd(room: MatchRoom, now: number) {
  if (room.practice || room.phase !== 'active') return;
  const alive = (team: Team) => { let count = 0; for (const player of room.players.values()) if (player.team === team && player.alive) count += 1; return count; };
  const timeUp = now >= room.roundEndsAt;
  if (room.roundKind === 'tiebreaker') {
    const blue = alive('azure');
    const red = alive('ember');
    if (!blue && !red) endRound(room, null, 'BOTH SQUADRONS ELIMINATED', now);
    else if (!red) endRound(room, 'azure', 'RED SQUADRON ELIMINATED', now);
    else if (!blue) endRound(room, 'ember', 'BLUE SQUADRON ELIMINATED', now);
    else if (timeUp) endRound(room, null, 'TIME — BOTH SQUADRONS STILL FLYING', now);
    return;
  }
  const defender = room.defender!;
  const attacker = otherTeam(defender);
  const towersStanding = room.towers.filter((tower) => tower.hp > 0).length;
  const defendersAlive = alive(defender);
  const attackersAlive = alive(attacker);
  // The objective decides first: all three towers down is an attacker win,
  // even on the same tick the last defender (or attacker) goes down.
  if (towersStanding === 0) endRound(room, attacker, 'ALL THREE TOWERS DESTROYED', now);
  else if (!defendersAlive && !attackersAlive) endRound(room, null, 'BOTH SIDES ELIMINATED', now);
  else if (!defendersAlive) endRound(room, attacker, teamCount(room, defender) ? 'ALL DEFENDERS ELIMINATED' : 'DEFENDERS LEFT THE MATCH', now);
  else if (!attackersAlive) endRound(room, defender, teamCount(room, attacker) ? 'ALL ATTACKERS ELIMINATED' : 'ATTACKERS LEFT THE MATCH', now);
  else if (timeUp) endRound(room, defender, `TIME — ${towersStanding} TOWER${towersStanding === 1 ? '' : 'S'} STILL STANDING`, now);
}

/** Simulates only the combat (flight, weapons, towers), with no round rules. */
export function stepCombat(room: MatchRoom, now: number, dt: number) {
  for (const player of room.players.values()) {
    if (!player.alive) continue;
    if (player.role === 'ground') stepGround(room, player, now, dt);
    else stepPilot(room, player, now, dt);
  }
  stepTowers(room, now);
  stepProjectiles(room, now, dt);
  updateSensors(room);
}

export function stepMatch(room: MatchRoom, now: number, dt: number) {
  if (room.practice) { stepCombat(room, now, dt); return; }
  const bothTeams = teamCount(room, 'azure') > 0 && teamCount(room, 'ember') > 0;
  switch (room.phase) {
    case 'lobby':
      if (!bothTeams) room.lobbyStartsAt = 0;
      else if (!room.lobbyStartsAt) room.lobbyStartsAt = now + LOBBY_MS;
      else if (now >= room.lobbyStartsAt) setUpRound(room, now);
      break;
    case 'prep':
      if (!bothTeams) { resetToLobby(room); break; }
      stepPositioning(room, now);
      stepTowers(room, now);
      if (now >= room.prepEndsAt) { room.phase = 'countdown'; room.countdownAt = now + COUNTDOWN_MS; }
      break;
    case 'countdown':
      if (!bothTeams) { resetToLobby(room); break; }
      stepPositioning(room, now);
      stepTowers(room, now);
      if (now >= room.countdownAt) beginCombat(room, now);
      break;
    case 'active':
      stepCombat(room, now, dt);
      checkRoundEnd(room, now);
      break;
    case 'intermission':
      if (now < room.intermissionAt) break;
      if (!bothTeams) resetToLobby(room);
      else setUpRound(room, now);
      break;
    case 'complete':
      if (now >= room.resultsUntil) resetToLobby(room);
      break;
  }
}

/** Called when a player leaves mid-round: the round may now be decided. */
export function afterDeparture(room: MatchRoom, now: number) {
  checkRoundEnd(room, now);
}

export function isFull(room: MatchRoom) {
  return teamCount(room, 'azure') >= MAX_TEAM_SIZE && teamCount(room, 'ember') >= MAX_TEAM_SIZE;
}

/** Whole seconds left, rounded up, without float dust turning 300.0000001 into 301. */
function secondsUntil(at: number, now: number) { return Math.max(0, Math.ceil((at - now) / 1_000 - 1e-6)); }

export function snapshotRoom(room: MatchRoom, now: number): RoomState {
  const phaseSecondsLeft = room.phase === 'lobby' ? (room.lobbyStartsAt ? secondsUntil(room.lobbyStartsAt, now) : 0)
    : room.phase === 'prep' ? secondsUntil(room.prepEndsAt, now)
      : room.phase === 'countdown' ? secondsUntil(room.countdownAt, now)
        : room.phase === 'intermission' ? secondsUntil(room.intermissionAt, now)
          : room.phase === 'complete' ? secondsUntil(room.resultsUntil, now) : 0;
  const secondsLeft = room.phase === 'active' && !room.practice ? secondsUntil(room.roundEndsAt, now)
    : (room.phase === 'prep' || room.phase === 'countdown') ? (room.defender ? ROUND_SECONDS : TIEBREAKER_SECONDS) : 0;
  return {
    type: 'state', room: room.code, arenaId: room.arenaId, phase: room.phase, round: room.round, rounds: MAX_ROUNDS, winsNeeded: WINS_NEEDED,
    roundKind: room.roundKind, defender: room.defender, overtime: room.overtime,
    secondsLeft, phaseSecondsLeft, roundWins: { ...room.roundWins }, roundWinner: room.roundWinner, matchWinner: room.matchWinner,
    players: [...room.players.values()].map(publicPlayer),
    towers: room.towers.map(({ id, kind, label, team, x, z, hp, maxHp, crewed, shielded, barrier }) => ({ id, kind, label, team, x, z, hp, maxHp, crewed, shielded, barrier })),
    stations: room.stations.map((station) => ({ ...station })),
    projectiles: room.projectiles.map(({ id, ownerId, team, kind, x, y, z, yaw, pitch, speed, targetId }) => ({ id, ownerId, team, kind, x, y, z, yaw, pitch, speed, targetId })),
    history: room.history.map((record) => ({ ...record })),
    events: room.events.splice(0),
  };
}

function publicPlayer(player: MatchPlayer): JetState {
  const {
    id, name, team, model, role, x, y, z, yaw, pitch, roll, speed, hp, alive, kills, deaths, missileCooldown, targetId, q, throttle, gLoad, rollRate,
    stall, gcas, burner, station, transit, repairCharges, repairCooldown, repairProgress, loadout, flakAmmo, samAmmo, barrierCooldown, spotted, damage, towerDamage, repaired,
  } = player;
  return {
    id, name, team, model, role, x, y, z, yaw, pitch, roll, speed, hp, alive, kills, deaths, missileCooldown, targetId, q: [...q] as JetState['q'], throttle, gLoad, rollRate,
    stall, gcas, burner, station, transit, repairCharges, repairCooldown, repairProgress, loadout, flakAmmo, samAmmo, barrierCooldown, spotted, damage, towerDamage, repaired,
  };
}
