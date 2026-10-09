import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import next from 'next';
import { WebSocket, WebSocketServer } from 'ws';
import { ARENA_CATALOG, DEFAULT_ARENA_ID, GAME_NAME, GROUND_LOADOUTS, JET_CATALOG, MAX_TEAM_SIZE, type ArenaId, type ClientMessage, type GroundLoadout, type JetModel, type PlayerInput, type RolePreference } from './src/lib/protocol';
import { addPlayer, afterDeparture, createMatchRoom, drainAudit, equip, removePlayer, setInput, setPreference, snapshotRoom, stepMatch, teamCount, type MatchRoom } from './src/lib/match';

const PORT = Number(process.env.PORT) || 3000;
const TICK = 1 / 30;
const app = next({ dev: process.argv.includes('--dev') });
const handle = app.getRequestHandler();

type ServerRoom = { match: MatchRoom; sockets: Map<string, WebSocket> };
const rooms = new Map<string, ServerRoom>();

function id() { return randomBytes(8).toString('hex'); }
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
  const code = String(message.room ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!code) return send(socket, { type: 'error', message: 'Enter a room code to deploy.' });
  let room = rooms.get(code);
  if (!room) { room = { match: createMatchRoom(code, normalizeArenaId(message.arenaId)), sockets: new Map() }; rooms.set(code, room); }
  const { match } = room;
  if (teamCount(match, 'azure') >= MAX_TEAM_SIZE && teamCount(match, 'ember') >= MAX_TEAM_SIZE) return send(socket, { type: 'error', message: 'That stadium is full — both teams have five players.' });
  if (match.phase === 'complete') return send(socket, { type: 'error', message: 'That match has just finished. Try again in a minute, or start a new room.' });
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
    response.end(JSON.stringify({ status: 'online', game: GAME_NAME, activeRooms: rooms.size, connectedPlayers, arenas: ARENA_CATALOG.map(({ id: arenaId, name }) => ({ id: arenaId, name })) }));
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
  socket.on('message', (raw) => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); } catch { return; }
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return;
    const message = parsed as ClientMessage;
    if (message.type === 'join') { joinGame(socket, message, membership); return; }
    if (!membership.room || !membership.playerId) return;
    if (message.type === 'input') setInput(membership.room.match, membership.playerId, readInput(message));
    else if (message.type === 'preference') setPreference(membership.room.match, membership.playerId, normalizePreference(message.role));
    else if (message.type === 'equip') equip(membership.room.match, membership.playerId, { model: message.model === undefined ? undefined : normalizeJetModel(message.model), loadout: normalizeLoadout(message.loadout) });
  });
  socket.on('close', () => {
    if (!membership.room || !membership.playerId) return;
    const room = membership.room;
    removePlayer(room.match, membership.playerId);
    room.sockets.delete(membership.playerId);
    afterDeparture(room.match, Date.now());
    logResults(room.match);
    if (room.match.players.size === 0) rooms.delete(room.match.code);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    stepMatch(room.match, now, TICK);
    logResults(room.match);
    if (!room.sockets.size) continue;
    const packet = JSON.stringify(snapshotRoom(room.match, now));
    for (const socket of room.sockets.values()) if (socket.readyState === WebSocket.OPEN) socket.send(packet);
  }
}, 1_000 / 30).unref();

server.listen(PORT, () => console.log(`${GAME_NAME} is online at http://localhost:${PORT}`));
