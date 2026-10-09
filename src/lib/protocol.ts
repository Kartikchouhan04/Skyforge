export const GAME_NAME = 'Skyforge Stadium';
export const MAX_TEAM_SIZE = 5;
export const MAX_PLAYERS = MAX_TEAM_SIZE * 2;

/**
 * Match format. Rounds 1–5: Blue defends, Red attacks. Rounds 6–10: roles
 * swap. Round 11 is a 5v5 jet tiebreaker, played only at 5–5. First to six
 * round wins takes the match. A drawn round is replayed (overtime) with the
 * same roles and the same round number.
 */
export const MAX_ROUNDS = 11;
export const REGULATION_ROUNDS = 10;
export const ROUNDS_PER_HALF = 5;
export const WINS_NEEDED = 6;
export const ROUND_SECONDS = 5 * 60;
/** Before every round: pick equipment and get into position, then a countdown before weapons go live. */
export const PREP_SECONDS = 15;
export const COMBAT_COUNTDOWN_SECONDS = 5;
/** Once both teams have a player, the lobby waits this long for others before round 1's preparation. */
export const LOBBY_SECONDS = 10;
export const TIEBREAKER_SECONDS = 5 * 60;
/** Defending side in a tower round: two jets, the rest on the ground. */
export const DEFENDER_PILOTS = 2;
export const DEFENDER_GROUND = 3;
/**
 * Two independent dials, both multiplying values authored against the
 * original 480-unit half-width arena:
 *
 * - ARENA_SCALE sizes the place: the flight volume, stadium shell, airfields,
 *   towers, boundaries and spawn spread.
 * - FLIGHT_SCALE sizes the jets' world: speeds, accelerations, weapon ranges
 *   and hit radii.
 *
 * Crossing time is ARENA_SCALE / FLIGHT_SCALE times the original, so it is the
 * RATIO that decides how roomy a 5v5 feels. Angular rates never scale.
 */
export const ARENA_SCALE = 36;
export const FLIGHT_SCALE = 3;
export const ARENA = {
  halfWidth: 480 * ARENA_SCALE,
  halfDepth: 370 * ARENA_SCALE,
  // Kept low rather than scaled, so pilots can still skim the stadium deck.
  minAltitude: 45,
  maxAltitude: 300 * ARENA_SCALE,
} as const;
export const ARENA_CATALOG = [
  { id: 'skyforge', name: 'Skyforge Stadium', sector: 'ENCLOSED COMBAT DOME', description: 'A floodlit steel arena with tiered stands and a reinforced roof.', accent: '#55d9ff', sky: '#91dff4' },
  { id: 'red-mesa', name: 'Red Mesa', sector: 'CANYON FLIGHT RANGE', description: 'A sun-baked canyon ringed by rust-red cliffs and mesa spires.', accent: '#ff875f', sky: '#e8a26f' },
  { id: 'ice-fjord', name: 'Ice Fjord', sector: 'POLAR TEST RANGE', description: 'A frozen basin surrounded by blue ice walls and crystal ridges.', accent: '#8ce8ff', sky: '#acd9ef' },
] as const;
export type ArenaId = typeof ARENA_CATALOG[number]['id'];
export const DEFAULT_ARENA_ID: ArenaId = 'skyforge';

/** Internal team ids. 'azure' is Blue Team (Team A), 'ember' is Red Team (Team B). */
export type Team = 'azure' | 'ember';
export const TEAM_NAMES: Record<Team, string> = { azure: 'BLUE TEAM', ember: 'RED TEAM' };
export const TEAM_SHORT: Record<Team, string> = { azure: 'BLUE', ember: 'RED' };
export function otherTeam(team: Team): Team { return team === 'azure' ? 'ember' : 'azure'; }

export type Role = 'pilot' | 'ground';
export type RolePreference = Role | 'any';
export type JetModel = 'swift' | 'bastion';
export const JET_CATALOG: { id: JetModel; name: string; role: string; description: string }[] = [
  { id: 'swift', name: 'F-27 SWIFT', role: 'LIGHT INTERCEPTOR', description: 'Fast throttle response and tight turns.' },
  { id: 'bastion', name: 'F-41 BASTION', role: 'STRIKE FIGHTER', description: 'Stable handling and a stronger boost.' },
];
const S = FLIGHT_SCALE;
const A = ARENA_SCALE;
/**
 * For instruments only: metres represented by one world unit. Chosen so the
 * stall lands near 125kt, cruise near Mach 0.9 and military power just
 * supersonic, which reads right for a fighter.
 */
export const METERS_PER_UNIT = .42;

/** Gravity in world units/s². Scaled with speed so turn radii keep their proportions. */
export const GRAVITY = 22 * S;

/**
 * Airframe parameters for the flight model in flight.ts.
 * - stallSpeed: the slowest speed that can still hold 1G. Lift available goes
 *   with (speed / stallSpeed)², so it also caps G at low speed.
 * - cornerSpeed: where full roll authority arrives (and roughly where the
 *   tightest turn lives).
 * - maxSpeed: top speed on military thrust; boostSpeed is what the afterburner adds.
 * - thrust: military thrust as a multiple of weight. Above 1, it can climb vertically.
 * - maxG / minG: structural load limits. rollRate in rad/s.
 * - maxBank: the bank angle the turn assist rolls to at full turn input. Must
 *   stay below flight.ts's knife-edge limit (~84°), where no G can hold the path.
 * - minSpeed: kept for visuals that scale effects from slowest to fastest.
 */
export const JET_FLIGHT = {
  swift: {
    stallSpeed: 52 * S, cornerSpeed: 160 * S, maxSpeed: 570 * S, boostSpeed: 300 * S, minSpeed: 52 * S,
    thrust: 2.4, maxG: 9, minG: -3, rollRate: 4.4, maxBank: 1.36, rudderRate: .3,
  },
  bastion: {
    stallSpeed: 56 * S, cornerSpeed: 150 * S, maxSpeed: 496 * S, boostSpeed: 320 * S, minSpeed: 56 * S,
    thrust: 2.1, maxG: 7.5, minG: -3, rollRate: 3.3, maxBank: 1.3, rudderRate: .26,
  },
} as const;

/** Combat distances. Anything about jets uses FLIGHT_SCALE (S); anything about the place uses ARENA_SCALE (A). */
export const COMBAT = {
  jetHitRadius: 15 * S,
  muzzleOffset: 12 * S,
  cannonSpeed: 500 * S,
  /**
   * Missile top speed after the motor burn: about Mach 4.4 (instruments use
   * METERS_PER_UNIT = 0.42), against a jet's Mach 0.9–1.4.
   */
  missileSpeed: 1_200 * S,
  /** Lock range on jets (about 1.8 km). */
  jetLockRange: 1_400 * S,
  /** Missiles can lock a tower or a ground unit from further out: they're big and don't move. */
  groundLockRange: 1_700 * S,
  boundaryWarn: 72 * A,
  boundaryInset: 24 * A,
  projectileMargin: 30 * A,
  overspeedDrag: 38 * S,
  spawnSpeed: 300 * S,
  cannonDamage: 13,
  /** Cannon dispersion (radians either side) and the missile motor's acceleration. */
  cannonSpread: .0035,
  /** Motor thrust: about 45 g, so full speed still comes roughly 2.5 s after ignition. */
  missileAccel: 450 * S,
  /** Guidance: proportional-navigation constant, turn limit in g, seeker field of view (half-angle, radians). */
  missileNavigation: 4,
  missileMaxG: 45,
  missileSeekerCone: .9,
  /** Proximity fuse: detonates this close to a jet. */
  missileFuse: 34 * S,
  /** Seconds before an unexploded missile self-destructs. */
  missileLife: 8,
  /** Missiles fall clear of the pylon this long before the motor lights and guidance starts. */
  missileDrop: .22,
  /** Missile reload, seconds. */
  missileReload: 5,
  missileDamage: 165,
} as const;

/**
 * The three strategic towers the defenders hold. Starting playtest values,
 * not final balance.
 * - Shield: while it stands, Radar and Weapons take reduced damage.
 * - Radar: while it stands, defenders see approaching attackers.
 * - Weapons: automated flak, faster while a ground defender crews it.
 */
export type TowerKind = 'shield' | 'radar' | 'weapons';
export const TOWER_NAMES: Record<TowerKind, string> = { shield: 'SHIELD', radar: 'RADAR', weapons: 'WEAPONS' };
export const TOWER = {
  hp: 1_000,
  radius: 20 * A,
  height: 72 * A,
  /** Damage reduction the Shield Tower gives the other two while it stands. */
  shieldReduction: .5,
  /** Health fraction that triggers the critical alert. */
  critical: .25,
  /** Repairs: a defender at a tower's repair pad holds the repair for its full duration. */
  repairAmount: 100,
  repairDuration: 4,
  repairCooldown: 30,
  repairCharges: 3,
  /** Weapons Tower: automated, leading flak. Crewed, it fires faster. */
  weaponsRange: 65 * A,
  weaponsInterval: .34,
  weaponsCrewedInterval: .18,
  weaponsDamage: 6,
  /** Radar Tower: attackers inside this range are shown to every defender. */
  radarRange: 560 * A,
} as const;

/** Ground defenders: crewed anti-aircraft units that drive between defensive stations. */
export const GROUND = {
  hp: 100,
  hitRadius: 11 * S,
  /** Height of the gun above the deck. */
  gunHeight: 7 * S,
  /** Anti-aircraft cannon: flak with a proximity fuse. */
  flakSpeed: 430 * S,
  flakLife: 2.6,
  flakInterval: .1,
  flakDamage: 7,
  flakFuse: 2.2,
  flakSpread: .01,
  /** Interceptor missile (SAM): radar-guided, limited per round. */
  samSpeed: 1_320 * S,
  samDamage: 60,
  samCooldown: 6,
  samLockRange: 1_500 * S,
  /** cos of the half-angle a SAM can lock inside. */
  samLockCone: .88,
  /** Shield activation: cuts damage to the tower beside you for a few seconds. */
  barrierReduction: .5,
  barrierDuration: 6,
  barrierCooldown: 40,
  /** Driving speed between stations, units/s, plus a fixed time to pack up and redeploy. */
  driveSpeed: 50 * A,
  redeploy: 1.2,
  minAimPitch: .02,
  maxAimPitch: 1.48,
} as const;

/** Ground equipment, chosen during the preparation phase. Ammunition is per round. */
export type GroundLoadout = 'balanced' | 'flak' | 'interceptor';
export const GROUND_LOADOUTS: Record<GroundLoadout, { name: string; description: string; flak: number; sams: number }> = {
  balanced: { name: 'BALANCED', description: '450 flak rounds · 4 interceptors', flak: 450, sams: 4 },
  flak: { name: 'FLAK', description: '700 flak rounds · 2 interceptors', flak: 700, sams: 2 },
  interceptor: { name: 'INTERCEPTOR', description: '250 flak rounds · 7 interceptors', flak: 250, sams: 7 },
};

/** Tower and station layout for a defending team, on that team's home end of the stadium. */
export function towerLayout(defender: Team) {
  // Blue's home is the west (-X) end, Red's the east. The Weapons Tower
  // stands forward in the centre; Shield and Radar hold the flanks.
  const side = defender === 'azure' ? -1 : 1;
  const spots: { kind: TowerKind; x: number; z: number }[] = [
    { kind: 'shield', x: 250, z: -185 },
    { kind: 'weapons', x: 185, z: 0 },
    { kind: 'radar', x: 250, z: 185 },
  ];
  const towers = spots.map(({ kind, x, z }) => ({ id: `tower-${kind}`, kind, label: TOWER_NAMES[kind], team: defender, x: side * x * A, z: z * A }));
  // Two gun stations per tower on its centre-facing side (1–6), and one
  // repair pad behind each tower (7–9).
  const guns = spots.flatMap(({ kind, x, z }, towerIndex) => [-1, 1].map((offset, sideIndex) => ({
    id: `station-${towerIndex * 2 + sideIndex + 1}`,
    index: towerIndex * 2 + sideIndex,
    kind: 'gun' as const,
    team: defender,
    towerId: `tower-${kind}`,
    x: side * (x - 40) * A,
    z: (z + offset * 30) * A,
  })));
  const pads = spots.map(({ kind, x, z }, towerIndex) => ({
    id: `repair-${kind}`,
    index: 6 + towerIndex,
    kind: 'repair' as const,
    team: defender,
    towerId: `tower-${kind}`,
    x: side * (x + 50) * A,
    z: z * A,
  }));
  return { towers, stations: [...guns, ...pads] };
}

/** lobby → prep (equipment, positions) → countdown (weapons safe) → active → intermission → prep… → complete. */
export type MatchPhase = 'lobby' | 'prep' | 'countdown' | 'active' | 'intermission' | 'complete';
export type RoundKind = 'towers' | 'tiebreaker' | 'practice';
export type ProjectileKind = 'cannon' | 'missile' | 'flak' | 'sam';
export const PROJECTILE_SPEED: Record<ProjectileKind, number> = {
  cannon: COMBAT.cannonSpeed, missile: COMBAT.missileSpeed, flak: GROUND.flakSpeed, sam: GROUND.samSpeed,
};

/** One player. Pilots fly a jet; ground defenders crew an anti-aircraft unit. */
export type JetState = {
  id: string;
  name: string;
  team: Team;
  model: JetModel;
  role: Role;
  /** Position. For a ground unit, x/z on the deck and y at the gun. */
  x: number;
  y: number;
  z: number;
  /** For a pilot, the jet's heading; for a ground unit, where the gun points. */
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  /** Seconds until the missile (pilot) or SAM (ground) is ready again. */
  missileCooldown: number;
  targetId: string | null;
  /** Orientation quaternion [x, y, z, w]. yaw/pitch/roll are derived from it. */
  q: [number, number, number, number];
  /** Throttle lever, 0..1. */
  throttle: number;
  /** Current load factor in G. */
  gLoad: number;
  /** Roll rate in rad/s (carried between ticks for roll inertia). */
  rollRate: number;
  /** Below the speed that can hold 1G. */
  stall: boolean;
  /** Automatic ground-collision avoidance is flying the jet. */
  gcas: boolean;
  /** Afterburner lit. */
  burner: boolean;
  /** Ground: the station manned or being driven to; -1 for pilots. */
  station: number;
  /** Ground: seconds of driving left before the unit is set up at its station. */
  transit: number;
  /** Ground: tower repairs left this round, and seconds until the next is allowed. */
  repairCharges: number;
  repairCooldown: number;
  /** Ground: seconds of the current repair completed (0 when not repairing). */
  repairProgress: number;
  /** Ground: equipment and ammunition left this round. */
  loadout: GroundLoadout;
  flakAmmo: number;
  samAmmo: number;
  /** Ground: seconds until shield activation is ready again. */
  barrierCooldown: number;
  /** Seen by the enemy's radar or sensors. */
  spotted: boolean;
  /** Match statistics. */
  damage: number;
  towerDamage: number;
  repaired: number;
};

export type TowerState = {
  id: string;
  kind: TowerKind;
  label: string;
  team: Team;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  /** A ground defender is set up at one of this tower's gun stations. */
  crewed: boolean;
  /** Protected by the standing Shield Tower. */
  shielded: boolean;
  /** Seconds left on a defender's shield activation. */
  barrier: number;
};

export type StationState = {
  id: string;
  index: number;
  /** Gun stations hold the line; repair pads are where towers get patched. */
  kind: 'gun' | 'repair';
  team: Team;
  towerId: string;
  x: number;
  z: number;
  occupantId: string | null;
};

export type ProjectileState = {
  id: string;
  ownerId: string;
  team: Team;
  kind: ProjectileKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Current speed: missiles accelerate off the rail, so it isn't constant. */
  speed: number;
  targetId: string | null;
};

export type CombatEvent = {
  id: string;
  type: 'jet-hit' | 'jet-down' | 'tower-hit' | 'tower-critical' | 'tower-down' | 'repair' | 'repair-interrupted' | 'barrier' | 'prep' | 'round-start' | 'round-end' | 'match-end' | 'boundary' | 'sides';
  text: string;
  team?: Team;
  ownerId?: string;
  targetId?: string;
  x?: number;
  y?: number;
  z?: number;
  round?: number;
};

export type RoundRecord = {
  round: number;
  /** 0 for the first attempt; 1, 2… for overtime replays of a drawn round. */
  overtime: number;
  kind: RoundKind;
  defender: Team | null;
  winner: Team | null;
  reason: string;
};

export type RoomState = {
  type: 'state';
  room: string;
  arenaId: ArenaId;
  phase: MatchPhase;
  round: number;
  rounds: typeof MAX_ROUNDS;
  winsNeeded: typeof WINS_NEEDED;
  roundKind: RoundKind;
  /** Which team holds the towers this round; null in the tiebreaker. */
  defender: Team | null;
  /** Replays of the current round after draws. */
  overtime: number;
  secondsLeft: number;
  phaseSecondsLeft: number;
  roundWins: Record<Team, number>;
  matchWinner: Team | null;
  roundWinner: Team | null;
  players: JetState[];
  towers: TowerState[];
  stations: StationState[];
  projectiles: ProjectileState[];
  history: RoundRecord[];
  events: CombatEvent[];
};

export type PlayerInput = {
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
  boost: boolean;
  airBrake: boolean;
  primary: boolean;
  secondary: boolean;
  /** Ground: absolute gun aim, radians. */
  aimYaw?: number;
  aimPitch?: number;
  /** Ground: station to drive to (0-based), or -1/undefined for none. */
  station?: number;
  /** Ground: held to repair at a repair pad (at a gun station it drives to that tower's pad). */
  repair?: boolean;
  /** Ground: activate the shield on the tower beside you. */
  barrier?: boolean;
};

export type ClientMessage =
  | { type: 'join'; room: string; name: string; arenaId?: ArenaId; jetModel?: JetModel; role?: RolePreference }
  | ({ type: 'input' } & PlayerInput)
  | { type: 'preference'; role: RolePreference }
  /** Equipment for the coming round: airframe for pilots, loadout for ground crews. */
  | { type: 'equip'; model?: JetModel; loadout?: GroundLoadout };

export type ServerMessage =
  | { type: 'joined'; id: string; room: string; team: Team; arenaId: ArenaId }
  | RoomState
  | { type: 'error'; message: string };
