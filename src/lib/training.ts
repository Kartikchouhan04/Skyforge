import { ARENA_SCALE, COMBAT, DEFAULT_ARENA_ID, TOWER, type ArenaId, type JetModel, type JetState, type PlayerInput, type Role, type RoomState } from '@/lib/protocol';
import { noseOf, type FlightInput } from '@/lib/flight';
import { addPlayer, createMatchRoom, deployPlayer, equip, layOutTowers, snapshotRoom, stepMatch, type MatchPlayer, type MatchRoom } from '@/lib/match';
import type { GroundLoadout } from '@/lib/protocol';

/**
 * Offline training runs the real match rules (match.ts) in a practice room:
 * no rounds, no timer, drones respawn. Two drills:
 * - pilot: attack Red's three towers while target drones circle.
 * - ground: crew a Blue gun station while drones make passes over your towers.
 */
export type TrainingInput = PlayerInput;
export type TrainingRole = Role;
type DroneHome = { x: number; y: number; z: number; phase: number };

export type TrainingSession = {
  room: MatchRoom;
  role: TrainingRole;
  state: RoomState;
  droneHomes: Map<string, DroneHome>;
  respawnAt: Map<string, number>;
  startedAt: number;
};

export const TRAINING_PLAYER_ID = 'training-pilot';
const DRONES = 5;
/** Drones fly on part throttle, so a pilot on full power can run them down. */
const DRONE_THROTTLE = .45;
/** Radius of each drone's racetrack circuit around its home point. */
const CIRCUIT_RADIUS = 85 * ARENA_SCALE;
const RESPAWN_MS = 2_600;

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

function droneHome(index: number, role: TrainingRole): DroneHome {
  // Pilot drill: drones hold the middle of the stadium. Ground drill: they
  // circle low over Blue's towers, just above their tops, and strafe them.
  const x = role === 'pilot' ? (60 + (index % 3) * 60) * ARENA_SCALE : -(140 + (index % 3) * 50) * ARENA_SCALE;
  const y = role === 'pilot' ? 110 + (index % 2) * 40 : 90 + (index % 2) * 18;
  return { x, y: y * ARENA_SCALE, z: (index - 2) * 62 * ARENA_SCALE, phase: index * 1.17 };
}

function placeDrone(session: TrainingSession, drone: MatchPlayer, index: number) {
  const home = session.droneHomes.get(drone.id)!;
  deployPlayer(session.room, drone, 'pilot', index);
  drone.x = home.x; drone.y = home.y; drone.z = home.z;
  drone.throttle = DRONE_THROTTLE;
}

export function createTrainingSession(callsign: string, arenaId: ArenaId = DEFAULT_ARENA_ID, model: JetModel = 'swift', role: TrainingRole = 'pilot'): TrainingSession {
  const now = Date.now();
  const room = createMatchRoom('TRAINING', arenaId, true);
  // Pilot drill attacks Red's towers; ground drill defends Blue's.
  layOutTowers(room, role === 'pilot' ? 'ember' : 'azure');
  const pilot = addPlayer(room, { id: TRAINING_PLAYER_ID, name: callsign.trim().slice(0, 16) || 'PILOT', model, team: 'azure' }, now);
  deployPlayer(room, pilot, role, 2, 2);
  const session: TrainingSession = { room, role, state: snapshotRoom(room, now), droneHomes: new Map(), respawnAt: new Map(), startedAt: now };
  for (let index = 0; index < DRONES; index += 1) {
    const drone = addPlayer(room, { id: `training-drone-${index + 1}`, name: `DRONE-${String(index + 1).padStart(2, '0')}`, model: index % 2 ? 'bastion' : 'swift', team: 'ember' }, now);
    session.droneHomes.set(drone.id, droneHome(index, role));
    placeDrone(session, drone, index);
  }
  session.state = snapshotRoom(room, now);
  return session;
}

/**
 * A simple autopilot that flies the same flight model a pilot does: it steers
 * for a point ahead on a circle around the drone's home, which the turn assist
 * turns into a banked, altitude-holding turn, and gently porpoises in altitude.
 */
function droneAutopilot(drone: JetState, home: DroneHome, index: number, elapsed: number): FlightInput {
  const nose = noseOf(drone);
  const clockwise = index % 2 ? 1 : -1;
  const around = Math.atan2(drone.z - home.z, drone.x - home.x) + clockwise * .55;
  const tx = home.x + Math.cos(around) * CIRCUIT_RADIUS - drone.x;
  const tz = home.z + Math.sin(around) * CIRCUIT_RADIUS - drone.z;
  // Bearing to the target relative to the nose, in the horizontal plane.
  const rightX = -nose[2];
  const rightZ = nose[0];
  const side = tx * rightX + tz * rightZ;
  const front = tx * nose[0] + tz * nose[2];
  const turn = clamp(Math.atan2(side, front) * 1.4, -1, 1);
  const targetAltitude = home.y + Math.sin(elapsed * .35 + home.phase) * 10 * ARENA_SCALE;
  const pitch = clamp((targetAltitude - drone.y) * .0025 - nose[1] * 2.2, -.55, .55);
  return { pitch, yaw: turn, roll: 0, throttle: 0, boost: false, airBrake: false };
}

/** Equipment can be swapped any time on the range. */
export function equipTraining(session: TrainingSession, choice: { model?: JetModel; loadout?: GroundLoadout }) {
  equip(session.room, TRAINING_PLAYER_ID, choice);
}

/**
 * Defence drill: every drone makes a strafing run on one of Blue's towers
 * every 22 s (staggered), firing once it's lined up, then pulls away. It gives
 * the gunner real damage to repair and shield against.
 */
function attackRun(room: MatchRoom, drone: JetState, slot: number, elapsed: number): PlayerInput | null {
  if ((elapsed + slot * 4.4) % 22 > 6) return null;
  const towers = room.towers.filter((tower) => tower.hp > 0 && tower.team !== drone.team);
  const tower = towers[slot % Math.max(1, towers.length)];
  if (!tower) return null;
  const nose = noseOf(drone);
  const dx = tower.x - drone.x; const dz = tower.z - drone.z; const dy = TOWER.height * .8 - drone.y;
  const flat = Math.hypot(dx, dz);
  const distance = Math.hypot(flat, dy);
  // Too close: pull up and away.
  const side = dx * -nose[2] + dz * nose[0];
  if (flat < 80 * ARENA_SCALE) return { pitch: .9, yaw: side > 0 ? -1 : 1, roll: 0, throttle: 1, boost: true, airBrake: false, primary: false, secondary: false };
  const front = dx * nose[0] + dz * nose[2];
  const turn = clamp(Math.atan2(side, front) * 1.8, -1, 1);
  const wantPitch = Math.atan2(dy, flat);
  const pitch = clamp((wantPitch - Math.asin(clamp(nose[1], -1, 1))) * 3, -.8, .8);
  const facing = (dx * nose[0] + dy * nose[1] + dz * nose[2]) / distance;
  const lined = distance < COMBAT.cannonSpeed * 1.6 && facing > Math.cos(Math.atan(TOWER.radius * .9 / distance));
  return { pitch, yaw: turn, roll: 0, throttle: 0, boost: false, airBrake: false, primary: lined, secondary: false };
}

export function stepTraining(session: TrainingSession, controls: TrainingInput, dt: number, now = Date.now()) {
  const { room } = session;
  const elapsed = (now - session.startedAt) / 1_000;
  const pilot = room.players.get(TRAINING_PLAYER_ID);
  if (pilot) pilot.input = controls;
  let index = 0;
  for (const drone of room.players.values()) {
    if (drone.id === TRAINING_PLAYER_ID) continue;
    const slot = index++;
    const home = session.droneHomes.get(drone.id)!;
    if (!drone.alive) {
      const respawn = session.respawnAt.get(drone.id);
      if (respawn === undefined) session.respawnAt.set(drone.id, now + RESPAWN_MS);
      else if (now >= respawn) { placeDrone(session, drone, slot); session.respawnAt.delete(drone.id); }
      continue;
    }
    // In the defence drill drones strafe Blue's towers when one lines up, so
    // there is real damage to repair and shield against.
    const run = session.role === 'ground' ? attackRun(room, drone, slot, elapsed) : null;
    drone.input = run ?? { ...droneAutopilot(drone, home, slot, elapsed), primary: false, secondary: false };
  }
  // You get your jet or gun back a few seconds after going down.
  if (pilot && !pilot.alive) {
    const respawn = session.respawnAt.get(pilot.id);
    if (respawn === undefined) session.respawnAt.set(pilot.id, now + RESPAWN_MS);
    else if (now >= respawn) { deployPlayer(room, pilot, session.role, 2, 2); session.respawnAt.delete(pilot.id); }
  }
  stepMatch(room, now, dt);
  session.state = snapshotRoom(room, now);
  return session.state;
}
