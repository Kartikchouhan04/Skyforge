/**
 * Bot diagnostic: one idle person and nine bots play a whole match headlessly.
 * Prints each round's result and what the bots did. Run: npx tsx tests/bots-sim.ts
 */
import { addPlayer, createMatchRoom, drainAudit, manageBots, stepMatch } from '../src/lib/match';

const TICK_MS = 1_000 / 30;
const room = createMatchRoom('SIM', 'skyforge');
let now = 1_000_000;
const human = addPlayer(room, { id: 'human', name: 'HUMAN', model: 'swift' }, now);
manageBots(room, 'fill', now);
console.log(`players ${room.players.size} · bots ${[...room.players.values()].filter((player) => player.bot).length}`);
const started = performance.now();
let ticks = 0;
let nan = false;
while (room.phase !== 'complete' && now < 1_000_000 + 3 * 3_600_000) {
  now += TICK_MS;
  ticks += 1;
  // The person stays parked and harmless, so the bots decide everything.
  human.input = { pitch: 0, yaw: 0, roll: 0, throttle: 0, boost: false, airBrake: false, primary: false, secondary: false };
  stepMatch(room, now, TICK_MS / 1_000);
  for (const player of room.players.values()) if (!Number.isFinite(player.x + player.y + player.z + player.hp)) nan = true;
  for (const entry of drainAudit(room)) {
    const towers = room.towers.map((tower) => `${tower.kind}:${Math.ceil(tower.hp)}`).join(' ');
    console.log(`R${entry.round}${entry.overtime ? ` OT${entry.overtime}` : ''} ${entry.kind} → ${entry.winner ?? 'DRAW'} · ${entry.reason} · alive B${entry.alive.azure}/R${entry.alive.ember} · ${towers}`);
  }
}
console.log(`\nphase ${room.phase} · winner ${room.matchWinner} · ${room.roundWins.azure}-${room.roundWins.ember} · NaN ${nan}`);
console.log(`${ticks} ticks in ${((performance.now() - started) / 1_000).toFixed(1)} s (${((performance.now() - started) / ticks).toFixed(3)} ms/tick)`);
for (const player of room.players.values()) console.log(`${player.name.padEnd(12)} ${player.team.padEnd(5)} K${player.kills} D${player.deaths} dmg ${Math.round(player.damage)} tower ${Math.round(player.towerDamage)} repaired ${Math.round(player.repaired)}`);
