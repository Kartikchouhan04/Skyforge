import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import next from 'next';
import { WebSocket, WebSocketServer } from 'ws';
import { ARENA_CATALOG, DEFAULT_ARENA_ID, GAME_NAME, GROUND_LOADOUTS, JET_CATALOG, type ArenaId, type BotAction, type ClientMessage, type GroundLoadout, type JetModel, type PlayerInput, type RolePreference, type ServerPerf } from './src/lib/protocol';
import { addPlayer, afterDeparture, createMatchRoom, drainAudit, equip, hasSeatForHuman, makeRoomForHuman, manageBots, pickOpenRoom, removePlayer, setInput, setPreference, snapshotRoom, stepMatch, type MatchRoom } from './src/lib/match';

const PORT = Number(process.env.PORT) || 3000;
const TICK = 1 / 30;
const app = next({ dev: process.argv.includes('--dev') });
const handle = app.getRequestHandler();

/** `open` rooms were made by matchmaking and take strangers; rooms joined by code stay private. */
type ServerRoom = { match: MatchRoom; sockets: Map<string, WebSocket>; open: boolean };
const rooms = new Map<string, ServerRoom>();

/**
 * Monitoring: how long each 30Hz tick takes (all rooms stepped and sent),
 * over the last ~5 s, and rooms whose simulation threw. A crashed room is
 * logged and closed so it can't take the other matches down with it.
 */
const TICK_WINDOW = 150;
const tickTimes: number[] = [];
let crashes = 0;
let slowLoggedAt = 0;
function serverPerf(): ServerPerf {
  const total = tickTimes.reduce((sum, ms) => sum + ms, 0);
  return { tickMs: tickTimes.length ? total / tickTimes.length : 0, tickMaxMs: tickTimes.length ? Math.max(...tickTimes) : 0, rooms: rooms.size, crashes };
}

function id() { return randomBytes(8).toString('hex'); }
function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do code = Array.from(randomBytes(5), (byte) => alphabet[byte % alphabet.length]).join(''); while (rooms.has(code));
  return code;
}
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

function normalizeArenaId(value: unknown): ArenaId {
  return ARENA_CATALOG.find((arena) => arena.id === value)?.id ?? DEFAULT_ARENA_ID;
}
function normalizeJetModel(value: unknown): JetModel {
  return JET_CATALOG.find((model) => model.id === value)?.id ?? 'swift';
}
function normalizeLoadout(value: unknown): GroundLoadout | undefined {
  return typeof value === 'string' && value in GROUND_LOADOUTS ? value as GroundLoadout : undefined;
}
function normalizePreference(value: unknown): RolePreference {
  return value === 'pilot' || value === 'ground' ? value : 'any';
}

/**
 * Every round result is decided by the simulation on this server and logged
 * here with its tick, survivors and health, so a draw or a Sudden Death
 * decision can be checked afterwards. Clients never report results.
 */
function logResults(match: MatchRoom) {
  for (const entry of drainAudit(match)) {
    const label = `R${entry.round}${entry.overtime ? ` OT${entry.overtime}` : ''}`;
    const outcome = entry.winner ? `${entry.winner === 'azure' ? 'BLUE' : 'RED'} WINS` : 'DRAW — REPLAY';
    console.log(`[result] room=${match.code} ${label} ${entry.kind} tick=${entry.tick} ${outcome} · ${entry.reason} · alive B${entry.alive.azure}/R${entry.alive.ember} hp B${Math.ceil(entry.health.azure)}/R${Math.ceil(entry.health.ember)} · score ${match.roundWins.azure}-${match.roundWins.ember} · ${new Date(entry.at).toISOString()}`);
  }
}

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function inputAxis(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}
function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readInput(message: Extract<ClientMessage, { type: 'input' }>): PlayerInput {
  const station = finite(message.station);
  return {
    pitch: inputAxis(message.pitch), yaw: inputAxis(message.yaw),
    roll: inputAxis(message.roll), throttle: inputAxis(message.throttle),
    boost: message.boost === true, airBrake: message.airBrake === true,
    primary: message.primary === true, secondary: message.secondary === true,
    aimYaw: finite(message.aimYaw), aimPitch: finite(message.aimPitch),
    station: station === undefined ? undefined : Math.round(clamp(station, -1, 8)),
    repair: message.repair === true,
    barrier: message.barrier === true,
  };
}

function joinGame(socket: WebSocket, message: Extract<ClientMessage, { type: 'join' }>, membership: { room: ServerRoom | null; playerId: string | null }) {
  if (membership.room) return;
  let room: ServerRoom | undefined;
  if (message.quick === true) {
    // Matchmaking: the fullest public room still forming, or a fresh one.
    const match = pickOpenRoom([...rooms.values()].filter((candidate) => candidate.open).map((candidate) => candidate.match));
    room = match ? rooms.get(match.code) : undefined;
    if (!room) { const code = roomCode(); room = { match: createMatchRoom(code, normalizeArenaId(message.arenaId)), sockets: new Map(), open: true }; rooms.set(code, room); }
  } else {
    const code = String(message.room ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) return send(socket, { type: 'error', message: 'Enter a room code to deploy.' });
    room = rooms.get(code);
    if (!room) { room = { match: createMatchRoom(code, normalizeArenaId(message.arenaId)), sockets: new Map(), open: false }; rooms.set(code, room); }
  }
  const { match } = room;
  const code = match.code;
  if (!hasSeatForHuman(match)) return send(socket, { type: 'error', message: 'That stadium is full — both teams have five players.' });
  if (match.phase === 'complete') return send(socket, { type: 'error', message: 'That match has just finished. Try again in a minute, or start a new room.' });
  makeRoomForHuman(match);
  const playerId = id();
  const name = String(message.name ?? 'Pilot').trim().replace(/[<>]/g, '').slice(0, 16) || 'Pilot';
  const player = addPlayer(match, { id: playerId, name, model: normalizeJetModel(message.jetModel), preference: normalizePreference(message.role) }, Date.now());
  room.sockets.set(playerId, socket);
  membership.room = room;
  membership.playerId = playerId;
  send(socket, { type: 'joined', id: playerId, room: code, team: player.team, arenaId: match.arenaId });
}

await app.prepare();
// Next owns its own upgrades (the dev HMR socket). Destroying them breaks
// hydration under `next dev`, which leaves client effects — and so the 3D
// stadium — permanently unmounted. Only valid after prepare().
const handleUpgrade = app.getUpgradeHandler();
const server = createServer((request, response) => {
  if (request.method === 'GET' && new URL(request.url ?? '/', 'http://localhost').pathname === '/api/health') {
    const connectedPlayers = [...rooms.values()].reduce((count, room) => count + room.match.players.size, 0);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    const perf = serverPerf();
    const memory = process.memoryUsage();
    response.end(JSON.stringify({
      status: 'online', game: GAME_NAME, activeRooms: rooms.size, connectedPlayers, arenas: ARENA_CATALOG.map(({ id: arenaId, name }) => ({ id: arenaId, name })),
      uptimeSeconds: Math.round(process.uptime()),
      tick: { avgMs: +perf.tickMs.toFixed(2), maxMs: +perf.tickMaxMs.toFixed(2), budgetMs: +(1_000 / 30).toFixed(2) },
      memoryMB: { rss: Math.round(memory.rss / 1_048_576), heapUsed: Math.round(memory.heapUsed / 1_048_576) },
      crashes,
    }));
    return;
  }
  void handle(request, response);
});
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1_024, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url ?? '/', 'http://localhost').pathname === '/api/game') {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit('connection', webSocket));
    return;
  }
  void handleUpgrade(request, socket, head);
});

webSockets.on('connection', (socket) => {
  const membership: { room: ServerRoom | null; playerId: string | null } = { room: null, playerId: null };
  let reports = 0;
  socket.on('message', (raw) => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); } catch { return; }
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return;
    const message = parsed as ClientMessage;
    if (message.type === 'join') { joinGame(socket, message, membership); return; }
    if (message.type === 'ping') { send(socket, { type: 'pong', t: finite(message.t) ?? 0, perf: serverPerf() }); return; }
    if (message.type === 'report') {
      // A few per connection is enough to spot a crash; more is noise.
      if (reports++ < 5) console.warn(`[client-error] room=${membership.room?.match.code ?? '-'} player=${membership.playerId ?? '-'} ${String(message.message ?? '').slice(0, 500)}`);
      return;
    }
    if (!membership.room || !membership.playerId) return;
    if (message.type === 'input') setInput(membership.room.match, membership.playerId, readInput(message));
    else if (message.type === 'preference') setPreference(membership.room.match, membership.playerId, normalizePreference(message.role));
    else if (message.type === 'bots') {
      const action = (['add', 'remove', 'fill', 'clear'] as const).find((option) => option === message.action);
      const team = message.team === 'azure' || message.team === 'ember' ? message.team : undefined;
      if (action) manageBots(membership.room.match, action satisfies BotAction, Date.now(), team);
    }
    else if (message.type === 'equip') equip(membership.room.match, membership.playerId, { model: message.model === undefined ? undefined : normalizeJetModel(message.model), loadout: normalizeLoadout(message.loadout) });
  });
  socket.on('close', () => {
    if (!membership.room || !membership.playerId) return;
    const room = membership.room;
    removePlayer(room.match, membership.playerId);
    room.sockets.delete(membership.playerId);
    afterDeparture(room.match, Date.now());
    logResults(room.match);
    // Bots don't keep a room alive.
    if (room.sockets.size === 0) rooms.delete(room.match.code);
  });
});

setInterval(() => {
  const started = performance.now();
  const now = Date.now();
  for (const room of rooms.values()) {
    try {
      stepMatch(room.match, now, TICK);
      logResults(room.match);
      if (!room.sockets.size) continue;
      const packet = JSON.stringify(snapshotRoom(room.match, now));
      for (const socket of room.sockets.values()) if (socket.readyState === WebSocket.OPEN) socket.send(packet);
    } catch (error) {
      crashes += 1;
      console.error(`[crash] room=${room.match.code} phase=${room.match.phase} round=${room.match.round} tick=${room.match.tick}`, error);
      for (const socket of room.sockets.values()) { send(socket, { type: 'error', message: 'The match hit a server error and was closed. Please start a new room.' }); socket.close(); }
      rooms.delete(room.match.code);
    }
  }
  const elapsed = performance.now() - started;
  tickTimes.push(elapsed);
  if (tickTimes.length > TICK_WINDOW) tickTimes.shift();
  if (elapsed > 1_000 / 30 && now - slowLoggedAt > 60_000) {
    slowLoggedAt = now;
    console.warn(`[perf] slow tick ${elapsed.toFixed(1)}ms (budget 33.3ms) · rooms=${rooms.size}`);
  }
}, 1_000 / 30).unref();

server.listen(PORT, () => console.log(`${GAME_NAME} is online at http://localhost:${PORT}`));
