/**
 * Headless rule tests for match.ts: Round 11 Sudden Death, the safe zone,
 * draws and replays. Run with `npm test` (npx tsx tests/match.test.ts).
 */
import assert from 'node:assert/strict';
import { GROUND_LOADOUTS, SUDDEN_DEATH, TIEBREAKER_SECONDS, TOWER, type Team } from '../src/lib/protocol';
import {
  addPlayer, COUNTDOWN_MS, createMatchRoom, drainAudit, PREP_MS, snapshotRoom, stepMatch, zoneAt, type MatchPlayer, type MatchRoom,
} from '../src/lib/match';

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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
