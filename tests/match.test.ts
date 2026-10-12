/**
 * Headless rule tests for match.ts: Round 11 Sudden Death, the safe zone,
 * draws and replays. Run with `npm test` (npx tsx tests/match.test.ts).
 */
import assert from 'node:assert/strict';
import { COMBAT, GROUND, GROUND_LOADOUTS, MAX_PLAYERS, SUDDEN_DEATH, TIEBREAKER_SECONDS, TOWER, matchPointTeams, type Team } from '../src/lib/protocol';
import {
  addBot, addPlayer, botCount, COUNTDOWN_MS, createMatchRoom, decideAfterRound, drainAudit, hasSeatForHuman, isFull, LOBBY_MS, makeRoomForHuman, manageBots, pickOpenRoom, PREP_MS,
  removeBot, removePlayer, resetToLobby, snapshotRoom, stepMatch, stepTowers, teamCount, zoneAt, type MatchPlayer, type MatchRoom,
} from '../src/lib/match';
import { createBotMatchSession, stepTraining, TRAINING_PLAYER_ID } from '../src/lib/training';

const TICK_MS = 1_000 / 30;
let passed = 0;
const failures: string[] = [];
function test(name: string, body: () => void) {
  try { body(); passed += 1; console.log(`  ok   ${name}`); } catch (error) { failures.push(name); console.log(`  FAIL ${name}\n       ${(error as Error).message}`); }
}

type Clock = { now: number };
function step(room: MatchRoom, clock: Clock, ms = TICK_MS) {
  const end = clock.now + ms;
  while (clock.now < end) { clock.now += TICK_MS; stepMatch(room, clock.now, TICK_MS / 1_000); }
}
/** Steps until a predicate holds (or fails after `limitMs`). */
function until(room: MatchRoom, clock: Clock, done: () => boolean, limitMs = 60_000) {
  const end = clock.now + limitMs;
  while (!done()) {
    assert.ok(clock.now < end, `timed out waiting (phase ${room.phase}, round ${room.round})`);
    step(room, clock);
  }
}
/** A full room, five a side. */
function fullRoom() {
  const clock = { now: 1_000_000 };
  const room = createMatchRoom('TEST', 'skyforge');
  for (let index = 0; index < 10; index += 1) addPlayer(room, { id: `p${index}`, name: `P${index}`, model: 'swift', preference: index % 2 ? 'pilot' : 'any' }, clock.now);
  return { room, clock };
}
function squad(room: MatchRoom, team: Team) { return [...room.players.values()].filter((player) => player.team === team); }
/** Keeps every jet parked in the middle so flight and the zone don't decide a test by accident. */
function park(room: MatchRoom) {
  for (const player of room.players.values()) if (player.alive && player.role === 'pilot') { player.x = 0; player.z = 0; player.y = 3_000; }
}
function kill(player: MatchPlayer) { player.alive = false; player.hp = 0; }

/** Jumps straight to the interval before a given round, at a given score. */
function jumpTo(room: MatchRoom, clock: Clock, round: number, wins: Record<Team, number>, overtime = 0) {
  room.roundWins = { ...wins };
  room.nextRound = round;
  room.nextOvertime = overtime;
  room.phase = 'intermission';
  room.intermissionAt = clock.now;
  step(room, clock);
  assert.equal(room.phase, 'prep');
}
function toCombat(room: MatchRoom, clock: Clock) {
  until(room, clock, () => room.phase === 'active', PREP_MS + COUNTDOWN_MS + 2_000);
  park(room);
}

console.log('Round 11 — Sudden Death');

test('Round 11 is reached only at 5–5 and is all jets, no towers, three minutes', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  assert.equal(room.roundKind, 'tiebreaker');
  assert.equal(room.defender, null);
  assert.equal(room.towers.length, 0);
  assert.equal(room.stations.length, 0);
  assert.ok([...room.players.values()].every((player) => player.role === 'pilot' && player.alive));
  toCombat(room, clock);
  assert.equal(Math.round((room.roundEndsAt - clock.now) / 1_000), TIEBREAKER_SECONDS);
  assert.equal(TIEBREAKER_SECONDS, 180);
});

test('a team reaching six before round 11 ends the match (no tiebreaker)', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 10, { azure: 5, ember: 4 });
  toCombat(room, clock);
  for (const player of squad(room, 'ember')) kill(player); // Red defends round 10.
  step(room, clock);
  assert.equal(room.phase, 'complete');
  assert.equal(room.matchWinner, 'azure');
});

test('last squadron flying wins Sudden Death and the match', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  toCombat(room, clock);
  for (const player of squad(room, 'azure')) kill(player);
  step(room, clock);
  assert.equal(room.phase, 'complete');
  assert.equal(room.matchWinner, 'ember');
  assert.equal(room.roundWins.ember, 6);
});

test('the zone holds for 60 s, then shrinks, and damage grows as it closes', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  const prepZone = zoneAt(room, clock.now)!;
  assert.equal(prepZone.radius, SUDDEN_DEATH.startRadius);
  toCombat(room, clock);
  const start = room.combatStartedAt;
  const at = (seconds: number) => zoneAt(room, start + seconds * 1_000)!;
  assert.equal(at(30).radius, SUDDEN_DEATH.startRadius);
  assert.equal(at(30).shrinking, false);
  assert.equal(at(59.9).damage, SUDDEN_DEATH.minDamage);
  const mid = at(SUDDEN_DEATH.holdSeconds + SUDDEN_DEATH.shrinkSeconds / 2);
  assert.ok(mid.shrinking);
  assert.ok(Math.abs(mid.radius - (SUDDEN_DEATH.startRadius + SUDDEN_DEATH.endRadius) / 2) < 1);
  assert.ok(mid.damage > SUDDEN_DEATH.minDamage && mid.damage < SUDDEN_DEATH.maxDamage);
  const end = at(TIEBREAKER_SECONDS - 1);
  assert.equal(end.radius, SUDDEN_DEATH.endRadius);
  assert.equal(end.damage, SUDDEN_DEATH.maxDamage);
  assert.ok(SUDDEN_DEATH.holdSeconds + SUDDEN_DEATH.shrinkSeconds < TIEBREAKER_SECONDS, 'zone finishes closing before time runs out');
  // Snapshot carries it.
  assert.ok(snapshotRoom(room, clock.now).zone);
});

test('jets outside the zone take damage; inside they do not; zone kills count', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  toCombat(room, clock);
  clock.now = room.combatStartedAt + (SUDDEN_DEATH.holdSeconds + SUDDEN_DEATH.shrinkSeconds) * 1_000;
  const outside = squad(room, 'azure')[0];
  const inside = squad(room, 'ember')[0];
  park(room);
  outside.x = SUDDEN_DEATH.endRadius * 1.5;
  step(room, clock, 1_000);
  outside.x = SUDDEN_DEATH.endRadius * 1.5; // flight moves it; keep it out
  assert.ok(outside.hp < 100 - SUDDEN_DEATH.maxDamage * .8, `outside hp ${outside.hp}`);
  assert.equal(inside.hp, 100);
  outside.hp = .5; // one tick at full zone damage is ~0.67 HP
  step(room, clock);
  assert.equal(outside.alive, false);
});

test('time expiry: more surviving jets wins', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  toCombat(room, clock);
  kill(squad(room, 'azure')[0]);
  clock.now = room.roundEndsAt;
  park(room);
  step(room, clock);
  assert.equal(room.matchWinner, 'ember');
});

test('time expiry, equal survivors: more combined health wins', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  toCombat(room, clock);
  squad(room, 'ember')[0].hp = 40;
  clock.now = room.roundEndsAt;
  park(room);
  step(room, clock);
  assert.equal(room.matchWinner, 'azure');
  assert.match(room.history.at(-1)!.reason, /HEALTH/);
});

test('time expiry, equal survivors and health: draw, replayed as Sudden Death overtime', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  toCombat(room, clock);
  clock.now = room.roundEndsAt;
  park(room);
  step(room, clock);
  assert.equal(room.phase, 'intermission');
  assert.equal(room.history.at(-1)!.winner, null);
  assert.deepEqual(room.roundWins, { azure: 5, ember: 5 });
  until(room, clock, () => room.phase === 'prep');
  assert.equal(room.round, 11);
  assert.equal(room.overtime, 1);
  assert.equal(room.roundKind, 'tiebreaker');
});

test('both squadrons eliminated on the same tick: draw, then repeated draws keep going into overtime', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    toCombat(room, clock);
    for (const player of room.players.values()) kill(player);
    step(room, clock);
    assert.equal(room.phase, 'intermission', `attempt ${attempt}`);
    assert.equal(room.history.at(-1)!.winner, null);
    assert.match(room.history.at(-1)!.reason, /SAME TICK/);
    until(room, clock, () => room.phase === 'prep');
    assert.equal(room.round, 11);
    assert.equal(room.overtime, attempt);
    assert.ok([...room.players.values()].every((player) => player.alive && player.hp === 100), 'everyone redeployed at full health');
  }
  assert.equal(room.matchWinner, null);
});

console.log('Draws and replays');

test('drawn tower round: no point, same round and roles, everything reset', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 3, { azure: 1, ember: 1 });
  toCombat(room, clock);
  assert.equal(room.defender, 'azure');
  const crew = squad(room, 'azure').find((player) => player.role === 'ground')!;
  crew.flakAmmo = 3; crew.samAmmo = 0; crew.repairCharges = 0;
  room.towers[0].hp = 120;
  for (const player of room.players.values()) kill(player);
  step(room, clock);
  assert.equal(room.history.at(-1)!.winner, null);
  assert.deepEqual(room.roundWins, { azure: 1, ember: 1 });
  until(room, clock, () => room.phase === 'prep');
  assert.equal(room.round, 3);
  assert.equal(room.overtime, 1);
  assert.equal(room.defender, 'azure');
  assert.ok(room.towers.every((tower) => tower.hp === TOWER.hp), 'tower damage reset');
  const again = room.players.get(crew.id)!;
  assert.equal(again.role, 'ground');
  assert.equal(again.flakAmmo, GROUND_LOADOUTS[again.loadout].flak);
  assert.equal(again.samAmmo, GROUND_LOADOUTS[again.loadout].sams);
  assert.equal(again.repairCharges, TOWER.repairCharges);
});

test('towers all down on the same tick as both sides: attackers still win (objective first)', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 2, { azure: 1, ember: 0 });
  toCombat(room, clock);
  for (const tower of room.towers) tower.hp = 0;
  for (const player of room.players.values()) kill(player);
  step(room, clock);
  assert.equal(room.history.at(-1)!.winner, 'ember');
});

test('every result is recorded with its simulation tick for the server log', () => {
  const { room, clock } = fullRoom();
  drainAudit(room);
  jumpTo(room, clock, 11, { azure: 5, ember: 5 });
  toCombat(room, clock);
  for (const player of room.players.values()) kill(player);
  step(room, clock);
  const audit = drainAudit(room);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].winner, null);
  assert.equal(audit[0].tick, room.tick);
  assert.deepEqual(audit[0].alive, { azure: 0, ember: 0 });
  assert.equal(room.history.at(-1)!.tick, room.tick);
  assert.equal(drainAudit(room).length, 0);
});

console.log('Match flow (section 14) and HUD data (section 12)');

test('after a round: six wins ends it, a draw replays, 5–5 after round 10 goes to Sudden Death, else next round', () => {
  assert.equal(decideAfterRound(4, { azure: 1, ember: 3 }, 'ember'), 'next-round');
  assert.equal(decideAfterRound(5, { azure: 3, ember: 2 }, null), 'replay');
  assert.equal(decideAfterRound(11, { azure: 5, ember: 5 }, null), 'replay');
  assert.equal(decideAfterRound(8, { azure: 6, ember: 2 }, 'azure'), 'match-end');
  assert.equal(decideAfterRound(10, { azure: 6, ember: 4 }, 'azure'), 'match-end');
  assert.equal(decideAfterRound(10, { azure: 5, ember: 5 }, 'ember'), 'sudden-death');
  assert.equal(decideAfterRound(11, { azure: 6, ember: 5 }, 'azure'), 'match-end');
});

test('round 10 won to 5–5 leads to round 11 Sudden Death', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 10, { azure: 5, ember: 4 });
  toCombat(room, clock);
  for (const player of squad(room, 'azure')) kill(player); // Red defends round 10 and holds.
  step(room, clock);
  assert.equal(room.phase, 'intermission');
  assert.deepEqual(room.roundWins, { azure: 5, ember: 5 });
  until(room, clock, () => room.phase === 'prep');
  assert.equal(room.round, 11);
  assert.equal(room.roundKind, 'tiebreaker');
});

test('match point is announced when a round starts with a team one win away, never in Sudden Death', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 7, { azure: 5, ember: 1 });
  const points = snapshotRoom(room, clock.now).events.filter((event) => event.type === 'match-point');
  assert.equal(points.length, 1);
  assert.equal(points[0].team, 'azure');
  assert.deepEqual(matchPointTeams({ azure: 5, ember: 1 }), ['azure']);
  const tie = fullRoom();
  jumpTo(tie.room, tie.clock, 11, { azure: 5, ember: 5 });
  assert.equal(snapshotRoom(tie.room, tie.clock.now).events.filter((event) => event.type === 'match-point').length, 0);
  const early = fullRoom();
  jumpTo(early.room, early.clock, 3, { azure: 2, ember: 0 });
  assert.equal(snapshotRoom(early.room, early.clock.now).events.filter((event) => event.type === 'match-point').length, 0);
});

test('jets carry a limited number of missiles per round, refilled next round', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 1, { azure: 0, ember: 0 });
  toCombat(room, clock);
  const shooter = squad(room, 'ember')[0];
  assert.equal(shooter.missileAmmo, COMBAT.missileCapacity);
  const fired = new Set<string>();
  for (let tick = 0; tick < COMBAT.missileCapacity + 4; tick += 1) {
    shooter.x = 9_000; shooter.z = 9_000; shooter.hp = 100;
    shooter.missileReadyAt = 0;
    shooter.input = { ...shooter.input, secondary: true };
    step(room, clock);
    for (const shot of room.projectiles) if (shot.ownerId === shooter.id && shot.kind === 'missile') fired.add(shot.id);
  }
  assert.equal(shooter.missileAmmo, 0);
  assert.equal(fired.size, COMBAT.missileCapacity);
  assert.equal(snapshotRoom(room, clock.now).players.find((player) => player.id === shooter.id)!.missileAmmo, 0);
  jumpTo(room, clock, 2, { azure: 0, ember: 1 });
  assert.equal(room.players.get(shooter.id)!.missileAmmo, COMBAT.missileCapacity);
});

test('players who leave mid-match stay on the final scoreboard', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 2, { azure: 1, ember: 0 });
  toCombat(room, clock);
  const leaver = squad(room, 'ember')[0];
  leaver.kills = 3;
  removePlayer(room, leaver.id);
  assert.deepEqual(snapshotRoom(room, clock.now).departed, [], 'only sent once the match is over');
  room.roundWins = { azure: 5, ember: 0 };
  for (const player of squad(room, 'ember')) kill(player);
  step(room, clock);
  assert.equal(room.phase, 'complete');
  const departed = snapshotRoom(room, clock.now).departed;
  assert.equal(departed.length, 1);
  assert.equal(departed[0].id, leaver.id);
  assert.equal(departed[0].kills, 3);
  resetToLobby(room);
  assert.equal(room.departed.length, 0);
});

test('matchmaking picks the fullest open room still forming, and skips full or running ones', () => {
  const clock = { now: 1_000_000 };
  const make = (code: string, size: number) => {
    const room = createMatchRoom(code, 'skyforge');
    for (let index = 0; index < size; index += 1) addPlayer(room, { id: `${code}${index}`, name: `${code}${index}`, model: 'swift' }, clock.now);
    return room;
  };
  const small = make('A', 2);
  const bigger = make('B', 6);
  const full = make('C', 10);
  const running = make('D', 8);
  running.phase = 'active';
  assert.equal(pickOpenRoom([small, bigger, full, running]), bigger);
  assert.equal(pickOpenRoom([full, running]), undefined);
  assert.equal(pickOpenRoom([]), undefined);
});

console.log('Tower-mounted defence');

test('gun stations are on the towers at two heights; crews stand up there', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 1, { azure: 0, ember: 0 });
  const guns = room.stations.filter((station) => station.kind === 'gun');
  assert.equal(guns.length, 6);
  assert.deepEqual([...new Set(guns.map((station) => station.y))].sort((a, b) => a - b), [TOWER.balconyHeight, TOWER.deckHeight]);
  for (const station of guns) {
    const tower = room.towers.find((item) => item.id === station.towerId)!;
    const radius = Math.hypot(station.x - tower.x, station.z - tower.z);
    assert.ok(Math.abs(radius - (station.mount === 'deck' ? TOWER.deckRadius : TOWER.balconyRadius)) < 1);
  }
  assert.ok(room.stations.filter((station) => station.kind === 'repair').every((station) => station.y === 0));
  const crew = squad(room, 'azure').filter((player) => player.role === 'ground');
  assert.equal(crew.length, 3);
  for (const unit of crew) assert.equal(unit.y, room.stations[unit.station].y + GROUND.gunHeight);
});

test('moving between towers: lift down, drive along the ground, lift up', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 1, { azure: 0, ember: 0 });
  toCombat(room, clock);
  const unit = squad(room, 'azure').find((player) => player.role === 'ground' && room.stations[player.station].mount === 'deck')!;
  const from = room.stations[unit.station];
  const target = room.stations.find((station) => station.mount === 'balcony' && station.towerId !== from.towerId && !station.occupantId)!;
  unit.input = { ...unit.input, station: target.index };
  let lowest = unit.y;
  until(room, clock, () => {
    park(room);
    unit.input = { ...unit.input, station: target.index };
    lowest = Math.min(lowest, unit.y);
    return unit.transit <= 0 && unit.station === target.index;
  }, 30_000);
  assert.equal(lowest, GROUND.gunHeight, 'it came down to the ground on the way');
  assert.equal(unit.y, target.y + GROUND.gunHeight);
  assert.equal(unit.x, target.x);
  assert.equal(unit.z, target.z);
});

test('a destroyed tower drops its platforms; the crew up there is thrown down and hurt', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 1, { azure: 0, ember: 0 });
  toCombat(room, clock);
  const unit = squad(room, 'azure').find((player) => player.role === 'ground')!;
  const station = room.stations[unit.station];
  const tower = room.towers.find((item) => item.id === station.towerId)!;
  const attacker = squad(room, 'ember')[0];
  tower.hp = 1;
  room.projectiles.push({
    id: 'shot', ownerId: attacker.id, team: 'ember', kind: 'cannon', x: tower.x + TOWER.radius * 3, y: TOWER.height * .3, z: tower.z, yaw: -Math.PI / 2, pitch: 0, speed: 3_000,
    targetId: null, vx: -30_000, vy: 0, vz: 0, life: 1, damage: 50, turn: 0, age: 0,
  } as never);
  step(room, clock, 300);
  assert.equal(tower.hp, 0);
  for (const gun of room.stations.filter((item) => item.towerId === tower.id && item.kind === 'gun')) {
    assert.equal(gun.mount, 'ground');
    assert.equal(gun.y, 0);
  }
  assert.equal(unit.y, GROUND.gunHeight);
  assert.equal(unit.hp, 100 - TOWER.collapseDamage);
  assert.ok(attacker.damage >= TOWER.collapseDamage, 'credited to whoever felled the tower');
  const thrown = snapshotRoom(room, clock.now).events.find((event) => event.type === 'collapse');
  assert.equal(thrown?.ownerId, unit.id, 'a collapse event tells the crew (for the sound and banner)');
});

test('the Weapons Tower fires from the mount nearest the target\'s height', () => {
  const { room, clock } = fullRoom();
  jumpTo(room, clock, 1, { azure: 0, ember: 0 });
  toCombat(room, clock);
  const weapons = room.towers.find((tower) => tower.kind === 'weapons')!;
  const jet = squad(room, 'ember')[0];
  for (const [height, mount] of [[TOWER.weaponsMounts[0] - 100, TOWER.weaponsMounts[0]], [TOWER.weaponsMounts[2] + 400, TOWER.weaponsMounts[2]]]) {
    room.projectiles = [];
    for (const player of room.players.values()) if (player.role === 'pilot') { player.x = 0; player.z = 0; player.y = 9_000; }
    jet.x = weapons.x + Math.sign(-weapons.x) * TOWER.weaponsRange * .5; jet.z = weapons.z; jet.y = height;
    weapons.defenceReadyAt = 0;
    stepTowers(room, clock.now);
    const shell = room.projectiles.find((shot) => shot.ownerId === `tower:${weapons.id}`);
    assert.ok(shell, 'it fired');
    assert.equal(shell.y, mount);
  }
});

console.log('Bots');

function soloRoom() {
  const clock = { now: 1_000_000 };
  const room = createMatchRoom('BOTS', 'skyforge');
  const human = addPlayer(room, { id: 'human', name: 'HUMAN', model: 'swift' }, clock.now);
  return { room, clock, human };
}

test('a room takes at most nine bots (ten players, at least one person), only in the lobby', () => {
  const empty = createMatchRoom('NOBODY', 'skyforge');
  assert.equal(addBot(empty, 0), null, 'no bots without a person');
  const { room, clock } = soloRoom();
  manageBots(room, 'fill', clock.now);
  assert.equal(room.players.size, MAX_PLAYERS);
  assert.equal(botCount(room), 9);
  assert.equal(teamCount(room, 'azure'), 5);
  assert.equal(teamCount(room, 'ember'), 5);
  assert.equal(addBot(room, clock.now), null);
  assert.equal(new Set([...room.players.values()].map((player) => player.name)).size, 10, 'bot names are unique');
  manageBots(room, 'remove', clock.now, 'azure');
  assert.equal(teamCount(room, 'azure'), 4);
  assert.equal(addBot(room, clock.now, 'ember'), null, 'a full team takes no more');
  manageBots(room, 'clear', clock.now);
  assert.equal(botCount(room), 0);
  assert.equal(room.players.size, 1);
  manageBots(room, 'add', clock.now);
  room.phase = 'active';
  assert.equal(addBot(room, clock.now), null, 'not once the match is running');
  assert.equal(removeBot(room), false);
});

test('a person joining a lobby full of bots takes a bot\'s seat', () => {
  const { room, clock } = soloRoom();
  manageBots(room, 'fill', clock.now);
  assert.equal(isFull(room), true);
  assert.equal(hasSeatForHuman(room), true);
  makeRoomForHuman(room);
  const guest = addPlayer(room, { id: 'guest', name: 'GUEST', model: 'swift' }, clock.now);
  assert.equal(room.players.size, MAX_PLAYERS);
  assert.equal(botCount(room), 8);
  assert.equal(teamCount(room, guest.team), 5);
  room.phase = 'active';
  assert.equal(hasSeatForHuman(room), false, 'bots keep their seats mid-match');
});

test('bots play a whole match: they fight, attack and repair towers, and finish it', () => {
  const { room, clock, human } = soloRoom();
  manageBots(room, 'fill', clock.now);
  // Every round must end on its own (time at the latest); allow for a few overtimes.
  until(room, clock, () => {
    human.input = { pitch: 0, yaw: 0, roll: 0, throttle: 0, boost: false, airBrake: false, primary: false, secondary: false };
    return room.phase === 'complete';
  }, 14 * 7 * 60_000);
  const bots = [...room.players.values()].filter((player) => player.bot);
  assert.ok(room.matchWinner, 'someone won');
  assert.ok(bots.reduce((sum, bot) => sum + bot.kills, 0) > 0, 'bots shot each other down');
  assert.ok(bots.reduce((sum, bot) => sum + bot.towerDamage, 0) > 0, 'bots damaged towers');
  assert.ok(bots.reduce((sum, bot) => sum + bot.repaired, 0) > 0, 'bot ground crews repaired');
  assert.ok([...room.players.values()].every((player) => Number.isFinite(player.x + player.y + player.z + player.hp)));
});

test('offline bot match: chosen teammates and opponents, full match rules', () => {
  const session = createBotMatchSession('ME', 'skyforge', 'swift', 2, 5);
  assert.equal(session.kind, 'bots');
  assert.equal(teamCount(session.room, 'azure'), 3);
  assert.equal(teamCount(session.room, 'ember'), 5);
  const capped = createBotMatchSession('ME', 'skyforge', 'swift', 99, 99);
  assert.equal(botCount(capped.room), 9);
  let now = Date.now();
  const end = now + LOBBY_MS + PREP_MS + COUNTDOWN_MS + 5_000;
  while (session.room.phase !== 'active' && now < end) { now += TICK_MS; stepTraining(session, session.room.players.get(TRAINING_PLAYER_ID)!.input, TICK_MS / 1_000, now); }
  assert.equal(session.room.phase, 'active');
  assert.equal(session.state.roundKind, 'towers');
  assert.equal(session.room.round, 1);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
