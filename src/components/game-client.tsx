'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArenaView } from '@/components/arena-view';
import { AttitudeIndicator } from '@/components/attitude-indicator';
import { RadarScope } from '@/components/radar-scope';
import {
  ARENA_CATALOG, DEFAULT_ARENA_ID, GROUND, GROUND_LOADOUTS, JET_CATALOG, TOWER, JET_FLIGHT, MAX_PLAYERS, MAX_ROUNDS, METERS_PER_UNIT, REGULATION_ROUNDS, ROUNDS_PER_HALF, TEAM_NAMES, TEAM_SHORT, WINS_NEEDED,
  type ArenaId, type CombatEvent, type GroundLoadout, type JetModel, type JetState, type PlayerInput, type Role, type RolePreference, type RoomState, type RoundRecord, type ServerMessage, type Team,
} from '@/lib/protocol';
import { createTrainingSession, equipTraining, stepTraining, TRAINING_PLAYER_ID, type TrainingSession } from '@/lib/training';
import { isMuted, setMuted, sfx, unlockAudio } from '@/lib/sfx';

const TEAM_CLASS: Record<Team, string> = { azure: 'azure', ember: 'ember' };
const ROLE_ICON: Record<Role, string> = { pilot: '✈', ground: '⌖' };
const ROLE_LABEL: Record<Role, string> = { pilot: 'PILOT', ground: 'GROUND' };
const PREFERENCES: { id: RolePreference; label: string; hint: string }[] = [
  { id: 'pilot', label: 'PILOT', hint: 'Fly a jet when defending' },
  { id: 'ground', label: 'GROUND', hint: 'Crew a gun station when defending' },
  { id: 'any', label: 'ANY', hint: 'Fill whatever the squad needs' },
];
const LOADOUTS = Object.entries(GROUND_LOADOUTS) as [GroundLoadout, (typeof GROUND_LOADOUTS)[GroundLoadout]][];
const TOWER_ROLE: Record<string, string> = {
  shield: 'Halves damage to the other two towers while it stands. Can’t be rebuilt.',
  radar: 'Shows approaching attackers to every defender while it stands.',
  weapons: 'Automated flak at attackers in range; fires faster when crewed.',
};
const NEUTRAL: PlayerInput = { pitch: 0, yaw: 0, roll: 0, throttle: 0, boost: false, airBrake: false, primary: false, secondary: false };

type InitialTraining = { arenaId?: string; model?: string; callsign?: string; role?: string } | null;

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function clock(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainder = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function healthClass(value: number) {
  return value > .6 ? 'healthy' : value > .28 ? 'damaged' : 'critical';
}

function readPreference(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function savePreference(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* Training remains playable when storage is blocked. */ }
}

function degrees(radians: number) { return Math.round(radians * 180 / Math.PI); }
function heading(yaw: number) { return String(((-degrees(yaw) % 360) + 360) % 360).padStart(3, '0'); }

/** Who defends a given round: Blue 1–5, Red 6–10, nobody in the tiebreaker. */
function defenderOf(round: number): Team | null {
  return round > REGULATION_ROUNDS ? null : round <= ROUNDS_PER_HALF ? 'azure' : 'ember';
}

/** A simple match score for the results table. */
function playerScore(player: JetState) {
  return Math.round(player.kills * 100 + player.damage + player.towerDamage * .5 + player.repaired * .5);
}

function roundLabel(record: Pick<RoundRecord, 'round' | 'overtime'>) {
  return `R${record.round}${record.overtime ? ` OT${record.overtime}` : ''}`;
}

export function GameClient({ initialTraining = null }: { initialTraining?: InitialTraining }) {
  const initialArena = ARENA_CATALOG.find((arena) => arena.id === initialTraining?.arenaId)?.id ?? DEFAULT_ARENA_ID;
  const initialModel = JET_CATALOG.find((model) => model.id === initialTraining?.model)?.id ?? 'swift';
  const initialDrill: Role = initialTraining?.role === 'ground' ? 'ground' : 'pilot';
  const initialCallsign = initialTraining?.callsign?.trim().slice(0, 16) || 'PILOT';
  const [initialSession] = useState<TrainingSession | null>(() => initialTraining ? createTrainingSession(initialCallsign, initialArena, initialModel, initialDrill) : null);
  const [name, setName] = useState(initialTraining ? initialCallsign : '');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('SERVER READY');
  const [connected, setConnected] = useState(Boolean(initialSession));
  const [offlineTraining, setOfflineTraining] = useState(Boolean(initialSession));
  const [showArenaPicker, setShowArenaPicker] = useState(false);
  const [selectedArena, setSelectedArena] = useState<ArenaId>(initialArena);
  const [selectedModel, setSelectedModel] = useState<JetModel>(initialModel);
  const [rolePreference, setRolePreference] = useState<RolePreference>('any');
  const [loadout, setLoadout] = useState<GroundLoadout>('balanced');
  const [muted, setMutedState] = useState(false);
  const [trainingRole, setTrainingRole] = useState<Role>(initialDrill);
  const [hitMarker, setHitMarker] = useState(false);
  const [snapshot, setSnapshot] = useState<RoomState | null>(initialSession?.state ?? null);
  const [copied, setCopied] = useState(false);
  const [feed, setFeed] = useState<CombatEvent[]>([]);
  const [banner, setBanner] = useState('');
  const socketRef = useRef<WebSocket | null>(null);
  const trainingRef = useRef<TrainingSession | null>(initialSession);
  const trainingModeRef = useRef(Boolean(initialSession));
  const trainingInputRef = useRef<PlayerInput>({ ...NEUTRAL });
  const snapshotRef = useRef<RoomState | null>(initialSession?.state ?? null);
  // The 3D view reads snapshotRef every frame; React only needs the HUD, and
  // re-rendering this whole tree 30x a second steals main-thread time from it.
  const hudAtRef = useRef(0);
  const selfIdRef = useRef(initialSession ? TRAINING_PLAYER_ID : '');
  const keysRef = useRef(new Set<string>());
  const primaryRef = useRef(false);
  const secondaryRef = useRef(false);
  const primaryPulseUntilRef = useRef(0);
  const secondaryPulseUntilRef = useRef(0);
  const mouseAimRef = useRef({ yaw: 0, pitch: 0, lastAt: 0 });
  // Ground gunners aim absolutely: the gun points where the mouse put it.
  const gunAimRef = useRef({ yaw: 0, pitch: .3, key: '' });
  const stationPulseRef = useRef({ station: -1, until: 0 });
  const repairPulseUntilRef = useRef(0);
  const barrierPulseUntilRef = useRef(0);
  // Taps on touch screens also send emulated mouse events; ignore those.
  const lastTouchAtRef = useRef(0);
  // While spectating: which surviving teammate the camera follows.
  const spectateIdRef = useRef<string | null>(null);
  const lastCountdownRef = useRef(-1);
  const lastControlsAtRef = useRef(0);
  const seenEventsRef = useRef(new Set<string>());
  const bannerTimerRef = useRef<number | undefined>(undefined);
  const hitTimerRef = useRef<number | undefined>(undefined);
  const requestedTrainingRef = useRef(false);

  useEffect(() => {
    if (!initialTraining) setName(readPreference('jet-arena-callsign') ?? '');
    const savedArena = ARENA_CATALOG.find((arena) => arena.id === readPreference('jet-arena-selected-arena'))?.id;
    if (savedArena && !initialTraining) setSelectedArena(savedArena);
    const savedModel = JET_CATALOG.find((model) => model.id === readPreference('jet-arena-selected-model'))?.id;
    if (savedModel && !initialTraining) setSelectedModel(savedModel);
    const savedPreference = PREFERENCES.find((preference) => preference.id === readPreference('skyforge-role-preference'))?.id;
    if (savedPreference) setRolePreference(savedPreference);
    const savedLoadout = readPreference('skyforge-loadout');
    if (savedLoadout && savedLoadout in GROUND_LOADOUTS) setLoadout(savedLoadout as GroundLoadout);
    const savedDrill = readPreference('skyforge-training-drill');
    if (!initialTraining && (savedDrill === 'pilot' || savedDrill === 'ground')) setTrainingRole(savedDrill);
    if (initialTraining) {
      savePreference('jet-arena-callsign', initialCallsign);
      savePreference('jet-arena-selected-arena', initialArena);
      savePreference('jet-arena-selected-model', initialModel);
      setConnection('OFFLINE TRAINING');
      try { window.history.replaceState(null, '', window.location.pathname); } catch { /* URL cleanup is optional for training. */ }
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) setRoomCode(room.toUpperCase());
    const requestedArena = ARENA_CATALOG.find((arena) => arena.id === params.get('arena'))?.id;
    const requestedModel = JET_CATALOG.find((model) => model.id === params.get('model'))?.id;
    if (params.get('mode') === 'training' && !requestedTrainingRef.current) {
      requestedTrainingRef.current = true;
      startTraining(requestedArena ?? savedArena ?? DEFAULT_ARENA_ID, params.get('pilot')?.trim() || readPreference('jet-arena-callsign')?.trim() || 'PILOT', requestedModel ?? savedModel ?? 'swift', params.get('role') === 'ground' ? 'ground' : 'pilot');
      return;
    }
    const secure = window.location.protocol === 'https:';
    fetch('/api/health', { cache: 'no-store' })
      .then((response) => { if (!response.ok) throw new Error('Flight server unavailable'); return response.json(); })
      .then(() => setConnection(secure ? 'SECURE LINK' : 'SERVER READY'))
      .catch(() => setConnection('FLIGHT SERVER OFFLINE'));
  }, []);

  const readState = useCallback(() => snapshotRef.current, []);
  const readSelfId = useCallback(() => selfIdRef.current, []);
  const selfPlayer = useCallback(() => snapshotRef.current?.players.find((player) => player.id === selfIdRef.current), []);

  /** Re-centres the gun aim on the server's whenever the gunner is (re)deployed. */
  const syncGunAim = useCallback((self: JetState) => {
    const state = snapshotRef.current;
    const key = `${state?.round}:${state?.overtime}:${self.role}:${self.alive}`;
    if (gunAimRef.current.key !== key) gunAimRef.current = { yaw: self.yaw, pitch: self.pitch, key };
  }, []);

  /** While you're down, the camera follows the teammate you picked (cycled with Q / E or a click). */
  const readViewId = useCallback(() => spectateIdRef.current, []);
  const cycleSpectate = useCallback((step: number) => {
    const state = snapshotRef.current;
    const self = state?.players.find((player) => player.id === selfIdRef.current);
    if (!state || !self || self.alive) return;
    const mates = state.players.filter((player) => player.team === self.team && player.alive);
    if (!mates.length) return;
    const index = mates.findIndex((player) => player.id === spectateIdRef.current);
    spectateIdRef.current = mates[((index < 0 ? 0 : index + step) % mates.length + mates.length) % mates.length].id;
  }, []);

  const readAim = useCallback(() => {
    const self = selfPlayer();
    if (!self || self.role !== 'ground' || !self.alive) return null;
    syncGunAim(self);
    return gunAimRef.current;
  }, [selfPlayer, syncGunAim]);

  function chooseArena(arenaId: ArenaId) {
    setSelectedArena(arenaId);
    savePreference('jet-arena-selected-arena', arenaId);
  }

  function chooseJetModel(model: JetModel) {
    setSelectedModel(model);
    savePreference('jet-arena-selected-model', model);
  }

  function chooseRolePreference(preference: RolePreference) {
    setRolePreference(preference);
    savePreference('skyforge-role-preference', preference);
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'preference', role: preference }));
  }

  /** Airframe and ground loadout for the coming round: changeable in the lobby, between rounds and during preparation. */
  function chooseEquipment(choice: { model?: JetModel; loadout?: GroundLoadout }) {
    if (choice.model) chooseJetModel(choice.model);
    if (choice.loadout) { setLoadout(choice.loadout); savePreference('skyforge-loadout', choice.loadout); }
    if (trainingModeRef.current && trainingRef.current) { equipTraining(trainingRef.current, choice); return; }
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'equip', ...choice }));
  }

  function chooseTrainingRole(role: Role) {
    setTrainingRole(role);
    savePreference('skyforge-training-drill', role);
  }

  /** Mouse stick deflection now, decaying back to centre with a ~0.18s time constant. */
  const mouseStick = useCallback((now: number) => {
    const aim = mouseAimRef.current;
    const decay = aim.lastAt ? Math.exp(-(now - aim.lastAt) / 180) : 0;
    return { yaw: aim.yaw * decay, pitch: aim.pitch * decay };
  }, []);

  const sendControls = useCallback(() => {
    const keys = keysRef.current;
    const down = (...names: string[]) => names.some((key) => keys.has(key));
    const now = performance.now();
    const dt = Math.min(.1, Math.max(0, (now - (lastControlsAtRef.current || now)) / 1_000));
    lastControlsAtRef.current = now;
    const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
    const self = selfPlayer();
    let controls: PlayerInput;
    if (self?.role === 'ground' && self.alive) {
      // Gunner: keys traverse and elevate the gun; the mouse does it directly.
      syncGunAim(self);
      const aim = gunAimRef.current;
      aim.yaw -= (Number(down('d', 'arrowright')) - Number(down('a', 'arrowleft'))) * 1.1 * dt;
      aim.pitch = Math.max(GROUND.minAimPitch, Math.min(GROUND.maxAimPitch, aim.pitch + (Number(down('w', 'arrowup')) - Number(down('s', 'arrowdown'))) * .8 * dt));
      controls = {
        ...NEUTRAL,
        primary: primaryRef.current || now < primaryPulseUntilRef.current,
        secondary: secondaryRef.current || now < secondaryPulseUntilRef.current,
        aimYaw: aim.yaw, aimPitch: aim.pitch,
        station: now < stationPulseRef.current.until ? stationPulseRef.current.station : undefined,
        repair: down('r') || now < repairPulseUntilRef.current,
        barrier: now < barrierPulseUntilRef.current,
      };
    } else {
      const stick = mouseStick(now);
      controls = {
        // Up arrow / mouse up raises the nose; A·D, ←→ and mouse sideways turn.
        pitch: clampUnit(Number(down('arrowup')) - Number(down('arrowdown')) + stick.pitch),
        yaw: clampUnit(Number(down('d', 'arrowright')) - Number(down('a', 'arrowleft')) + stick.yaw),
        roll: Number(down('e')) - Number(down('q')),
        throttle: Number(down('w')) - Number(down('s')),
        boost: down(' '),
        airBrake: down('shift'),
        // Keyboard fire as well as the mouse: laptop touchpads ignore clicks
        // while keys are held, so turning with A·D·Q·E would block the trigger.
        primary: primaryRef.current || now < primaryPulseUntilRef.current || down('f'),
        secondary: secondaryRef.current || now < secondaryPulseUntilRef.current || down('r'),
      };
    }
    if (trainingModeRef.current) {
      trainingInputRef.current = controls;
      return;
    }
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'input', ...controls }));
  }, [mouseStick, selfPlayer, syncGunAim]);

  const requestStation = useCallback((station: number) => {
    stationPulseRef.current = { station, until: performance.now() + 300 };
    sendControls();
  }, [sendControls]);

  const requestRepair = useCallback(() => {
    repairPulseUntilRef.current = performance.now() + 200;
    sendControls();
  }, [sendControls]);

  const requestBarrier = useCallback(() => {
    barrierPulseUntilRef.current = performance.now() + 250;
    sendControls();
  }, [sendControls]);

  const announce = useCallback((text: string) => {
    setBanner(text);
    if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => setBanner(''), 3_800);
  }, []);

  const handleEvents = useCallback((events: CombatEvent[]) => {
    const fresh: CombatEvent[] = [];
    for (const event of events) {
      if (seenEventsRef.current.has(event.id)) continue;
      seenEventsRef.current.add(event.id);
      fresh.push(event);
      if (['round-start', 'round-end', 'match-end', 'tower-down', 'tower-critical', 'sides'].includes(event.type)) announce(event.text);
      const mine = event.ownerId === selfIdRef.current;
      if (event.type === 'tower-down') { sfx.explosion(true); sfx.alarm(); }
      else if (event.type === 'tower-critical') sfx.alarm();
      else if (event.type === 'jet-down') sfx.explosion(false);
      else if (event.type === 'repair') sfx.repairDone();
      else if (event.type === 'repair-interrupted' && mine) sfx.repairInterrupted();
      else if (event.type === 'barrier') sfx.shield();
      else if (event.type === 'round-start') sfx.horn();
    }
    if (fresh.some((event) => event.ownerId === selfIdRef.current && event.type === 'jet-hit')) sfx.hit();
    if (fresh.some((event) => event.ownerId === selfIdRef.current && (event.type === 'jet-hit' || event.type === 'jet-down' || event.type === 'tower-hit' || event.type === 'tower-down'))) {
      setHitMarker(true);
      if (hitTimerRef.current) window.clearTimeout(hitTimerRef.current);
      hitTimerRef.current = window.setTimeout(() => setHitMarker(false), 220);
    }
    const feedEvents = fresh.filter((event) => event.type !== 'jet-hit' && !((event.type === 'boundary' || event.type === 'repair-interrupted') && event.ownerId !== selfIdRef.current));
    if (feedEvents.length) setFeed((previous) => [...feedEvents, ...previous].slice(0, 6));
  }, [announce]);

  function resetInputs() {
    trainingInputRef.current = { ...NEUTRAL };
    keysRef.current.clear();
    primaryRef.current = false;
    secondaryRef.current = false;
    primaryPulseUntilRef.current = 0;
    secondaryPulseUntilRef.current = 0;
    mouseAimRef.current = { yaw: 0, pitch: 0, lastAt: 0 };
    gunAimRef.current = { yaw: 0, pitch: .3, key: '' };
    seenEventsRef.current.clear();
    setFeed([]);
  }

  function startTraining(arenaId: ArenaId = selectedArena, requestedCallsign = name.trim() || 'PILOT', model: JetModel = selectedModel, role: Role = trainingRole) {
    const callsign = requestedCallsign;
    const pendingSocket = socketRef.current;
    socketRef.current = null;
    pendingSocket?.close();
    let session: TrainingSession;
    try {
      session = createTrainingSession(callsign, arenaId, model, role);
    } catch (launchError) {
      console.error('Offline training session creation failed', launchError);
      setError('TRAINING FAILED TO LOAD — PLEASE TRY AGAIN.');
      return;
    }
    savePreference('jet-arena-callsign', callsign);
    setName(callsign);
    chooseArena(arenaId);
    chooseJetModel(model);
    chooseTrainingRole(role);
    setShowArenaPicker(false);
    trainingRef.current = session;
    resetInputs();
    snapshotRef.current = session.state;
    setSnapshot(session.state);
    selfIdRef.current = TRAINING_PLAYER_ID;
    trainingModeRef.current = true;
    setOfflineTraining(true);
    setConnected(true);
    setError('');
    setConnection('OFFLINE TRAINING');
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* URL cleanup is optional for training. */ }
    announce(role === 'ground' ? 'TOWER DEFENCE DRILL — CREW STATION 3' : 'ATTACK DRILL — DESTROY THE RED TOWERS');
  }

  function resetTraining() {
    if (!trainingModeRef.current) return;
    const session = createTrainingSession(name.trim() || 'PILOT', selectedArena, selectedModel, trainingRole);
    trainingRef.current = session;
    resetInputs();
    snapshotRef.current = session.state;
    setSnapshot(session.state);
    announce('TRAINING RANGE RESET');
  }

  function joinArena(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const callsign = name.trim();
    const code = (roomCode.trim() || randomCode()).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!callsign) { setError('Enter a callsign before takeoff.'); return; }
    if (!code) { setError('Enter a room code.'); return; }
    savePreference('jet-arena-callsign', callsign);
    setRoomCode(code);
    setConnection('LINKING…');
    trainingModeRef.current = false;
    trainingRef.current = null;
    setOfflineTraining(false);
    socketRef.current?.close();
    socketRef.current = null;
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${window.location.host}/api/game`);
    socketRef.current = socket;
    socket.addEventListener('open', () => {
      if (socketRef.current === socket) socket.send(JSON.stringify({ type: 'join', room: code, name: callsign, arenaId: selectedArena, jetModel: selectedModel, role: rolePreference }));
    });
    socket.addEventListener('message', (eventMessage) => {
      if (socketRef.current !== socket) return;
      const message = JSON.parse(eventMessage.data as string) as ServerMessage;
      if (message.type === 'error') {
        setError(message.message);
        setConnection('SERVER READY');
        socket.close();
      } else if (message.type === 'joined') {
        selfIdRef.current = message.id;
        socket.send(JSON.stringify({ type: 'equip', loadout }));
        setRoomCode(message.room);
        chooseArena(message.arenaId);
        setConnected(true);
        setConnection('LINK ESTABLISHED');
        window.history.replaceState(null, '', `?room=${message.room}`);
      } else if (message.type === 'state') {
        const previous = snapshotRef.current;
        snapshotRef.current = message;
        const at = performance.now();
        // Phase and round changes reach the HUD immediately.
        if (message.phase !== previous?.phase || message.round !== previous?.round || at - hudAtRef.current > 100) { hudAtRef.current = at; setSnapshot(message); }
        handleEvents(message.events);
      }
    });
    socket.addEventListener('error', () => {
      if (socketRef.current !== socket) return;
      setError('Can’t reach the game server. Start it with “npm run dev” and retry.');
      setConnection('SERVER OFFLINE');
    });
    socket.addEventListener('close', () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      if (selfIdRef.current) {
        setConnected(false);
        setError('Connection lost. Refresh to rejoin the room.');
      }
    });
  }

  async function copyInvite() {
    const url = `${window.location.origin}/?room=${encodeURIComponent(roomCode)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch { window.prompt('Copy the room link:', url); }
  }

  function leaveArena() {
    socketRef.current?.close();
    window.location.href = '/';
  }

  function setKey(key: string, pressed: boolean) {
    if (pressed) keysRef.current.add(key);
    else keysRef.current.delete(key);
    sendControls();
  }

  function capturePress(event: ReactPointerEvent<HTMLButtonElement>, key: string) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setKey(key, true);
  }

  function updateMouseAim(movementX: number, movementY: number) {
    if (!connected || (!movementX && !movementY)) return;
    const self = selfPlayer();
    if (self?.role === 'ground' && self.alive) {
      syncGunAim(self);
      const aim = gunAimRef.current;
      // Mouse right swings the gun right (yaw decreases to the right in this world).
      aim.yaw -= movementX * .0026;
      aim.pitch = Math.max(GROUND.minAimPitch, Math.min(GROUND.maxAimPitch, aim.pitch - movementY * .0026));
      sendControls();
      return;
    }
    const now = performance.now();
    const current = mouseStick(now);
    mouseAimRef.current = {
      yaw: Math.max(-1, Math.min(1, current.yaw + movementX * .02)),
      pitch: Math.max(-1, Math.min(1, current.pitch - movementY * .02)),
      lastAt: now,
    };
    sendControls();
  }

  function handleCombatPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, .team-panel, .results-screen')) return;
    updateMouseAim(event.movementX, event.movementY);
  }

  useEffect(() => {
    if (!connected) return;
    /** Letter keys by physical position (KeyF → 'f'), so Shift, Caps Lock or a held modifier can't change what they do. */
    const keyName = (event: KeyboardEvent) => (event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase());
    // Clicks on real controls (buttons, menus, panels) never fire weapons.
    const UI = 'button, a, input, select, label, .combat-header, .results-screen, .prep-panel, .station-picker, .awaiting-card, .arena-picker-backdrop, .training-loadout';
    let uiPress = false;
    /**
     * Mouse buttons are read from the whole window, not just the 3D view: with
     * the cursor unlocked, turning drifts it over HUD panels and the click was
     * lost. mousedown/mouseup (not pointer events) because a second button
     * pressed while the first is held sends no new pointerdown.
     */
    const mouseDown = (event: MouseEvent) => {
      if (performance.now() - lastTouchAtRef.current < 800) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(UI)) { uiPress = true; return; }
      if (!target?.closest?.('.combat-screen') && document.pointerLockElement === null) return;
      if (event.button === 2) event.preventDefault();
      const canvas = document.querySelector('.combat-screen .arena-canvas') as HTMLCanvasElement | null;
      // Browsers may refuse pointer lock (e.g. just after Esc); the mouse still works unlocked.
      if (canvas && document.pointerLockElement !== canvas) Promise.resolve(canvas.requestPointerLock?.()).catch(() => {});
      unlockAudio();
      const self = selfPlayer();
      if (self && !self.alive) { cycleSpectate(event.button === 2 ? -1 : 1); return; }
      if (event.button === 0) { primaryRef.current = true; primaryPulseUntilRef.current = performance.now() + 80; }
      if (event.button === 2) { secondaryRef.current = true; secondaryPulseUntilRef.current = performance.now() + 80; }
      sendControls();
    };
    /**
     * Every mouse move also reports which buttons are held. If a press was
     * swallowed (touchpads suppress clicks while keys are held), holding the
     * button still fires; releasing it outside the window still stops.
     */
    const buttonsFromMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || uiPress) return;
      const self = selfPlayer();
      if (!self?.alive) return;
      const left = (event.buttons & 1) !== 0;
      const right = (event.buttons & 2) !== 0;
      if (left !== primaryRef.current || right !== secondaryRef.current) {
        primaryRef.current = left;
        secondaryRef.current = right;
        sendControls();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.('input')) return;
      const key = keyName(event);
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
      unlockAudio();
      if (key === 'm' && !event.repeat) { const next = !isMuted(); setMuted(next); setMutedState(next); return; }
      const self = selfPlayer();
      if (self && !self.alive && !event.repeat && (key === 'q' || key === 'e' || key === '[' || key === ']')) { cycleSpectate(key === 'q' || key === '[' ? -1 : 1); return; }
      if (self?.role === 'ground' && self.alive && !event.repeat) {
        const stations = snapshotRef.current?.stations.length ?? 0;
        if (/^[1-9]$/.test(key) && Number(key) <= stations) { requestStation(Number(key) - 1); return; }
        if ((key === 'q' || key === 'e') && stations) { requestStation((self.station + (key === 'e' ? 1 : stations - 1)) % stations); return; }
        if (key === 'f') { requestBarrier(); return; }
      }
      keysRef.current.add(key);
      sendControls();
    };
    const keyup = (event: KeyboardEvent) => { keysRef.current.delete(keyName(event)); keysRef.current.delete(event.key.toLowerCase()); sendControls(); };
    const release = () => {
      keysRef.current.clear(); primaryRef.current = false; secondaryRef.current = false;
      primaryPulseUntilRef.current = 0; secondaryPulseUntilRef.current = 0;
      mouseAimRef.current = { yaw: 0, pitch: 0, lastAt: 0 };
      sendControls();
    };
    const pointerUp = (event: MouseEvent) => {
      uiPress = false;
      if (event.button === 0) primaryRef.current = false;
      if (event.button === 2) secondaryRef.current = false;
      sendControls();
    };
    const pointerLockChange = () => {
      if (!document.pointerLockElement) mouseAimRef.current = { yaw: 0, pitch: 0, lastAt: 0 };
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', release);
    window.addEventListener('mouseup', pointerUp);
    window.addEventListener('mousedown', mouseDown, true);
    window.addEventListener('pointermove', buttonsFromMove);
    document.addEventListener('pointerlockchange', pointerLockChange);
    const interval = window.setInterval(sendControls, 50);
    return () => {
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', release);
      window.removeEventListener('mouseup', pointerUp); document.removeEventListener('pointerlockchange', pointerLockChange); window.clearInterval(interval);
      window.removeEventListener('mousedown', mouseDown, true); window.removeEventListener('pointermove', buttonsFromMove);
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, [connected, sendControls, selfPlayer, requestStation, requestBarrier, cycleSpectate]);

  useEffect(() => {
    if (!offlineTraining) return;
    let lastFrame = performance.now();
    const interval = window.setInterval(() => {
      const session = trainingRef.current;
      if (!session) return;
      const now = performance.now();
      const dt = Math.min((now - lastFrame) / 1_000, 0.06);
      lastFrame = now;
      const next = stepTraining(session, trainingInputRef.current, dt);
      snapshotRef.current = next;
      if (now - hudAtRef.current > 100) { hudAtRef.current = now; setSnapshot(next); }
      handleEvents(next.events);
    }, 33);
    return () => window.clearInterval(interval);
  }, [offlineTraining, handleEvents]);

  useEffect(() => {
    if (!snapshot) return;
    const selfId = selfIdRef.current;
    const me = snapshot.players.find((player) => player.id === selfId);
    if (me?.alive && snapshot.phase === 'active') {
      if (snapshot.projectiles.some((shot) => shot.targetId === selfId && (shot.kind === 'missile' || shot.kind === 'sam'))) sfx.missileWarning();
      else if (snapshot.players.some((player) => player.alive && player.team !== me.team && player.targetId === selfId)) sfx.lockWarning();
    }
    if (snapshot.phase === 'countdown' && snapshot.phaseSecondsLeft !== lastCountdownRef.current) {
      lastCountdownRef.current = snapshot.phaseSecondsLeft;
      if (snapshot.phaseSecondsLeft > 0) sfx.countdown(snapshot.phaseSecondsLeft === 1);
    }
    // Keep the spectate target valid.
    if (me && !me.alive) {
      const target = snapshot.players.find((player) => player.id === spectateIdRef.current);
      if (!target?.alive || target.team !== me.team) spectateIdRef.current = snapshot.players.find((player) => player.team === me.team && player.alive)?.id ?? null;
    } else spectateIdRef.current = null;
  }, [snapshot]);

  /* ------------------------------------------------------------ HUD data -- */
  const players = snapshot?.players ?? [];
  const self = players.find((player) => player.id === selfIdRef.current);
  const isGunner = self?.role === 'ground';
  const phase = snapshot?.phase;
  const defender = snapshot?.defender ?? null;
  const tiebreaker = snapshot?.roundKind === 'tiebreaker';
  const mySide = !self || !snapshot ? '' : offlineTraining ? (snapshot.defender === self.team ? 'DEFENCE DRILL' : 'ATTACK DRILL')
    : tiebreaker ? 'TIEBREAKER' : phase !== 'active' && phase !== 'prep' && phase !== 'countdown' ? '' : defender === self.team ? 'DEFENDING' : 'ATTACKING';
  const rosterCount = players.length;
  const teamPlayers = (team: Team) => players.filter((player) => player.team === team).sort((a, b) => Number(b.alive) - Number(a.alive) || (a.role === b.role ? 0 : a.role === 'pilot' ? -1 : 1) || b.kills - a.kills);
  const towers = snapshot?.towers ?? [];
  const stations = snapshot?.stations ?? [];
  const lockedPlayer = players.find((player) => player.id === self?.targetId);
  const lockedTower = towers.find((tower) => `tower:${tower.id}` === self?.targetId);
  const targetLabel = lockedPlayer ? `${lockedPlayer.name}${lockedPlayer.role === 'ground' ? ' · GROUND' : ''}` : lockedTower ? `${TEAM_SHORT[lockedTower.team]} ${lockedTower.label} TOWER` : 'NO TARGET';
  const incomingMissile = Boolean(self?.alive && snapshot?.projectiles.some((shot) => shot.targetId === self.id && (shot.kind === 'missile' || shot.kind === 'sam')));
  const lockedBy = self?.alive ? players.filter((player) => player.alive && player.team !== self.team && player.targetId === self.id) : [];
  const spectating = self && !self.alive ? players.find((player) => player.id === spectateIdRef.current) : undefined;
  const preparing = phase === 'prep' || phase === 'countdown';
  const activeDrones = players.filter((player) => player.team === 'ember' && player.alive).length;
  const phaseText = offlineTraining ? 'OFFLINE TRAINING' : phase === 'prep' ? `PREPARATION · ${snapshot?.phaseSecondsLeft}S` : phase === 'countdown' ? `WEAPONS FREE IN ${snapshot?.phaseSecondsLeft}` : phase === 'intermission' ? `NEXT ROUND IN ${snapshot?.phaseSecondsLeft}` : phase === 'lobby' ? (snapshot?.phaseSecondsLeft ? `MATCH STARTS IN ${snapshot.phaseSecondsLeft}` : 'WAITING FOR BOTH TEAMS') : phase === 'complete' ? 'MATCH COMPLETE' : tiebreaker ? 'TIEBREAKER' : 'LIVE';
  const phaseClock = offlineTraining ? 'NO TIMER' : phase === 'active' || preparing ? clock(snapshot?.secondsLeft ?? 0) : phase === 'intermission' ? `00:${String(snapshot?.phaseSecondsLeft ?? 0).padStart(2, '0')}` : '--:--';
  const myStation = isGunner ? stations[self!.station] : undefined;
  const myTower = myStation ? towers.find((tower) => tower.id === myStation.towerId) : undefined;
  const radarContacts = self ? players.filter((player) => player.alive && player.team !== self.team && player.spotted && player.role === 'pilot').length : 0;
  const lastRound = snapshot?.history.at(-1);
  const nextRound = lastRound ? (lastRound.winner ? lastRound.round + 1 : lastRound.round) : 1;
  const nextOvertime = lastRound && !lastRound.winner ? lastRound.overtime + 1 : 0;
  const nextDefender = defenderOf(nextRound);
  const objective = offlineTraining
    ? (isGunner ? <>DEFENCE DRILL<br /><span>SHOOT THE DRONES · HOLD R AT A REPAIR PAD · F SHIELD</span></> : <>ATTACK DRILL<br /><span>TAKE OUT THE SHIELD TOWER FIRST</span></>)
    : tiebreaker ? <>TIEBREAKER · 5V5<br /><span>LAST SQUADRON FLYING WINS</span></>
      : !self || !defender ? <>{WINS_NEEDED} ROUND WINS TAKE THE MATCH<br /><span>ROLES SWAP AFTER ROUND {ROUNDS_PER_HALF}</span></>
        : defender === self.team ? <>DEFEND THE TOWERS<br /><span>HOLD ONE UNTIL TIME OR DOWN EVERY ATTACKER</span></>
          : <>DESTROY ALL 3 TOWERS<br /><span>SHIELD FIRST · OR ELIMINATE ALL FIVE DEFENDERS</span></>;
  const brand = <><span>✣</span> SKYFORGE<span>//</span>STADIUM</>;

  return (
    <main className={`command-shell ${connected ? 'is-playing' : 'is-lobby'}`}>
      {!connected ? (
        <section className="launch-screen">
          <ArenaView key={`${snapshot?.arenaId ?? 'preview'}:${offlineTraining ? 'training' : 'arena'}`} readState={readState} readSelfId={readSelfId} mode={offlineTraining ? 'training' : 'arena'} />
          <div className="launch-shade" />
          <header className="launch-header">
            <a className="jet-brand" href="/" aria-label="Skyforge Stadium home"><span className="brand-symbol">✣</span><span>SKYFORGE<span>//</span>STADIUM</span></a>
            <div className="launch-status"><i /> AEROSPACE COMBAT LEAGUE <b>S.01</b></div>
            <a className="guide-link" href="#flight-manual">HOW IT WORKS <span>↘</span></a>
          </header>
          <div className="launch-copy">
            <div className="eyeline"><span>SKYFORGE STADIUM</span><i /> 5 VS 5</div>
            <h1>STORM THE<br /><em>TOWERS.</em></h1>
            <p>Five jets attack. Five defend — three on the guns, two in the air. Swap sides at half time. First to six.</p>
            <div className="match-specs"><span><b>11</b> ROUNDS</span><i /> <span><b>FIRST TO 6</b></span><i /> <span><b>05:00</b> EACH</span><i /> <span><b>10</b> PLAYERS</span></div>
          </div>
          <aside className="hangar-card">
            <div className="card-top"><span>FLIGHT DECK <b>01 / 03</b></span><span className="status-dot" /></div>
            <h2>Ready, pilot?</h2>
            <p>Pick a callsign and enter a room. Teams balance automatically.</p>
            <form onSubmit={joinArena}>
              <label htmlFor="callsign">CALLSIGN</label>
              <input id="callsign" value={name} maxLength={16} onChange={(event) => setName(event.target.value)} placeholder="e.g. Viper-1" required />
              <div className="airframe-select" role="group" aria-label="Choose fighter jet">
                <span>SELECT AIRFRAME</span>
                <div>{JET_CATALOG.map((model) => <button key={model.id} type="button" className={selectedModel === model.id ? 'selected' : ''} aria-label={`${model.name}: ${model.description}`} aria-pressed={selectedModel === model.id} onClick={() => chooseJetModel(model.id)}><b>{model.name}</b><small>{model.role}</small></button>)}</div>
              </div>
              <div className="airframe-select role-select" role="group" aria-label="Preferred role when defending">
                <span>WHEN DEFENDING, I WANT TO…</span>
                <div>{PREFERENCES.map((preference) => <button key={preference.id} type="button" className={rolePreference === preference.id ? 'selected' : ''} aria-pressed={rolePreference === preference.id} title={preference.hint} onClick={() => chooseRolePreference(preference.id)}><b>{preference.label}</b><small>{preference.hint}</small></button>)}</div>
              </div>
              <label htmlFor="room-code">ROOM <span>OPTIONAL · SHARE TO SQUAD UP</span></label>
              <div className="room-entry"><input id="room-code" maxLength={8} value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="GENERATE A ROOM" /><button type="button" onClick={() => setRoomCode(randomCode())} aria-label="Generate room code">⟳</button></div>
              <button className="deploy-button" type="submit"><span>ENTER THE STADIUM</span><b>↗</b></button>
              <button className="training-button" type="button" aria-haspopup="dialog" aria-controls="arena-picker" aria-expanded={showArenaPicker} onClick={() => { setError(''); setShowArenaPicker(true); }}><span>ENTER OFFLINE TRAINING</span><b>↗</b></button>
              <a className="quick-flight-button" href={`/?mode=training&arena=${selectedArena}&model=${selectedModel}&role=${trainingRole}&pilot=${encodeURIComponent(name.trim() || 'PILOT')}`} onClick={(event) => { event.preventDefault(); startTraining(selectedArena, name.trim() || 'PILOT'); }}><span>QUICK {trainingRole === 'ground' ? 'DEFENCE' : 'ATTACK'} DRILL · {ARENA_CATALOG.find((arena) => arena.id === selectedArena)?.name.toUpperCase()}</span><b>↗</b></a>
              <div className="connect-foot"><span>◈ {ARENA_CATALOG.find((arena) => arena.id === selectedArena)?.name.toUpperCase()}</span><span>{connection}</span></div>
              <div className={`lobby-error ${error ? 'visible' : ''}`} role="alert">{error}</div>
            </form>
            <div className="card-corner">✣</div>
          </aside>
          {showArenaPicker && <div id="arena-picker" className="arena-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="arena-picker-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowArenaPicker(false); }}>
            <section className="arena-picker">
              <div className="arena-picker-top"><span>OFFLINE TRAINING <b>02 / 03</b></span><button type="button" aria-label="Close arena selection" onClick={() => setShowArenaPicker(false)}>×</button></div>
              <div className="arena-picker-heading"><span>CHOOSE A DRILL, THEN AN ARENA</span><h2 id="arena-picker-title">TRAINING RANGE</h2><p>Click an arena to launch straight into the drill.</p></div>
              <div className="drill-select" role="group" aria-label="Training drill">
                <button type="button" className={trainingRole === 'pilot' ? 'selected' : ''} aria-pressed={trainingRole === 'pilot'} onClick={() => chooseTrainingRole('pilot')}><b>✈ ATTACK DRILL</b><small>Fly a jet against Red’s three towers while target drones circle.</small></button>
                <button type="button" className={trainingRole === 'ground' ? 'selected' : ''} aria-pressed={trainingRole === 'ground'} onClick={() => chooseTrainingRole('ground')}><b>⌖ DEFENCE DRILL</b><small>Crew a gun station at Blue’s towers and shoot down passing drones.</small></button>
              </div>
              {error && <p className="arena-launch-error" role="alert">{error}</p>}
              <form className="arena-selection-form" onSubmit={(event) => { event.preventDefault(); startTraining(selectedArena, name.trim() || 'PILOT'); }}>
                <input type="hidden" name="mode" value="training" />
                <input type="hidden" name="pilot" value={name.trim()} />
                <input type="hidden" name="model" value={selectedModel} />
                <input type="hidden" name="role" value={trainingRole} />
                <div className="arena-options">{ARENA_CATALOG.map((arena) => <label key={arena.id} className={`arena-option theme-${arena.id} ${selectedArena === arena.id ? 'selected' : ''}`}>
                  <input type="radio" name="arena" value={arena.id} checked={selectedArena === arena.id} onChange={() => chooseArena(arena.id)} onClick={() => startTraining(arena.id, name.trim() || 'PILOT')} />
                  <span className={`arena-preview preview-${arena.id}`}><i className="preview-grid" /><i className="preview-shape preview-shape-one" /><i className="preview-shape preview-shape-two" /><b>{arena.sector}</b></span>
                  <span className="arena-option-copy"><strong>{arena.name}</strong><small>{arena.description}</small></span>
                  <span className="arena-selected-mark"><b className="selected-label">● SELECTED</b><b className="unselected-label">○ CLICK TO FLY</b></span>
                </label>)}</div>
                <div className="arena-picker-footer"><span>LOCAL TRAINING <i>·</i> ARENA CARD LAUNCHES IMMEDIATELY</span><button type="submit" className="arena-launch-button">START {trainingRole === 'ground' ? 'DEFENCE' : 'ATTACK'} DRILL <b>↗</b></button></div>
              </form>
            </section>
          </div>}
          <div className="launch-bottom"><span>SKYFORGE AEROSPACE COMBAT LEAGUE</span><span>ATTACK · DEFEND · SWITCH SIDES</span></div>
        </section>
      ) : (
        <section className={`combat-screen ${isGunner ? 'role-ground' : 'role-pilot'}`} onPointerMove={handleCombatPointerMove} onTouchStart={() => { lastTouchAtRef.current = performance.now(); }} onContextMenu={(event) => event.preventDefault()}>
          <ArenaView key={`${snapshot?.arenaId ?? 'preview'}:${offlineTraining ? 'training' : 'arena'}`} readState={readState} readSelfId={readSelfId} mode={offlineTraining ? 'training' : 'arena'} readAim={readAim} readViewId={readViewId} />
          <div className="combat-vignette" />
          <header className="combat-header">
            <div className="combat-brand">{brand} <i className={`live-pill ${offlineTraining ? 'training-pill' : ''}`}>{offlineTraining ? '● OFFLINE' : '● LIVE'}</i></div>
            <div className={`series-score ${offlineTraining ? 'training-score' : ''}`}>
              {offlineTraining ? <>
                <div className="score-team azure-text"><span>DRONES DOWN</span><b>{self?.kills ?? 0}</b></div>
                <div className="round-readout"><span>DRILL</span><b>{isGunner ? 'DEFENCE' : 'ATTACK'}</b></div>
                <div className="score-team ember-text"><b>{activeDrones}</b><span>ACTIVE</span></div>
              </> : <>
                <div className="score-team azure-text"><span>{TEAM_NAMES.azure}</span><b>{snapshot?.roundWins.azure ?? 0}</b></div>
                <div className="round-readout"><span>ROUND · FIRST TO {WINS_NEEDED}</span><b>{String(snapshot?.round ?? 0).padStart(2, '0')} <i>/ {MAX_ROUNDS}</i>{snapshot?.overtime ? <em className="overtime-tag">OT{snapshot.overtime}</em> : null}</b></div>
                <div className="score-team ember-text"><b>{snapshot?.roundWins.ember ?? 0}</b><span>{TEAM_NAMES.ember}</span></div>
              </>}
            </div>
            <div className={`combat-actions ${offlineTraining ? 'training-actions' : ''}`}>{offlineTraining ? <><span className="training-status">{ARENA_CATALOG.find((arena) => arena.id === selectedArena)?.name.toUpperCase()} · {isGunner ? 'GUN STATION' : JET_CATALOG.find((model) => model.id === selectedModel)?.name}</span><button onClick={resetTraining}>RESET RANGE ↻</button></> : <><span className="room-code">ROOM <b>{roomCode}</b></span><button onClick={copyInvite}>{copied ? 'LINK COPIED ✓' : 'INVITE ↗'}</button></>}<button className="mute-button" onClick={() => { const next = !isMuted(); setMuted(next); setMutedState(next); }} aria-pressed={muted} title="Sound (M)">{muted ? 'SOUND OFF' : 'SOUND ON'}</button><button className="exit-button" onClick={leaveArena}>EXIT</button></div>
          </header>

          <div className="phase-stamp"><span className={phase === 'active' || offlineTraining ? 'phase-live' : ''}>{phaseText}</span><b>{phaseClock}</b></div>
          {self && mySide && <div className={`role-chip ${TEAM_CLASS[self.team]}`}><b>{TEAM_SHORT[self.team]}</b> {mySide} <i>·</i> {ROLE_ICON[self.role]} {ROLE_LABEL[self.role]}{isGunner && myStation ? <> <i>·</i> {myStation.kind === 'repair' ? 'REPAIR PAD' : 'STATION'} {myStation.index + 1} · {myTower?.label}</> : null}</div>}
          {self?.alive && <div className={`self-health ${healthClass(self.hp / 100)}`}><span>{isGunner ? 'UNIT' : 'HULL'}</span><i><em style={{ width: `${self.hp}%` }} /></i><b>{Math.ceil(self.hp)}</b></div>}
          {incomingMissile ? <div className="threat-warning missile">⚠ MISSILE INBOUND — BREAK!</div> : lockedBy.length ? <div className="threat-warning lock">◎ LOCKED BY {lockedBy.map((player) => player.name).join(', ')}</div> : null}

          {(['azure', 'ember'] as const).map((team, index) => <aside key={team} className={`team-panel team-panel-${index ? 'right' : 'left'}`}>
            <div className={`roster-heading ${team}-text`}><span>0{index + 1}</span> {offlineTraining ? (team === 'azure' ? 'YOU' : 'TARGET DRONES') : TEAM_NAMES[team]}{!offlineTraining && snapshot?.roundKind === 'towers' && phase === 'active' ? <em className="side-tag">{defender === team ? 'DEF' : 'ATK'}</em> : null} <b>{teamPlayers(team).length}/05</b></div>
            {teamPlayers(team).map((player) => <div className={`pilot-row ${player.alive ? '' : 'pilot-down'}`} key={player.id}><i className="pilot-signal" /><span className="pilot-name"><span className="role-icon" title={ROLE_LABEL[player.role]}>{ROLE_ICON[player.role]}</span>{player.name}<em>{player.role === 'ground' ? `STN ${player.station + 1}` : player.model.toUpperCase()}{player.id === selfIdRef.current ? ' · YOU' : ''}</em></span><span className="pilot-score">{player.kills}<small>K</small></span><div className="pilot-hp"><i className={healthClass(player.hp / 100)} style={{ width: `${player.alive ? player.hp : 0}%` }} /></div></div>)}
          </aside>)}

          <div className={`target-lock ${self?.targetId ? 'is-locked' : ''}`}><span>{isGunner ? (self?.targetId ? 'SAM LOCK' : 'SAM SEARCH') : self?.targetId ? 'MISSILE LOCK' : 'SCANNING'}</span><b>{targetLabel}</b></div>
          <div className={`target-reticle ${hitMarker ? 'confirmed-hit' : ''}`} aria-hidden="true"><i /><i /><span>{hitMarker ? '×' : '+'}</span></div>
          <div className="event-feed">{feed.map((event) => <div className={`feed-line ${event.team ? TEAM_CLASS[event.team] : ''}`} key={event.id}><i>{event.type === 'jet-down' ? '✕' : event.type === 'tower-down' ? '▰' : event.type === 'repair' ? '✚' : event.type === 'sides' ? '⇄' : event.type === 'boundary' ? '!' : '◆'}</i>{event.text}</div>)}</div>
          {banner && <div className="combat-banner">{banner}</div>}
          <RadarScope readState={readState} readSelfId={readSelfId} />

          <div className="tower-status-row">
            {towers.map((tower) => {
              const health = tower.hp / tower.maxHp;
              const tags = [tower.shielded ? 'SHIELDED' : '', tower.barrier > 0 ? `BARRIER ${Math.ceil(tower.barrier)}S` : '', tower.crewed ? 'CREWED' : ''].filter(Boolean).join(' · ');
              return <div className={`base-chip tower-chip ${TEAM_CLASS[tower.team]}-chip ${tower.hp <= 0 ? 'tower-lost' : ''} ${tower.hp > 0 && health < TOWER.critical ? 'tower-critical' : ''} ${tower.shielded || tower.barrier > 0 ? 'tower-shielded' : ''}`} key={tower.id} title={TOWER_ROLE[tower.kind]}>
                <span>{tower.label}</span><b>{tower.hp > 0 ? `${Math.ceil(tower.hp)} HP` : 'DESTROYED'}</b>
                <i><em className={healthClass(health)} style={{ width: `${health * 100}%` }} /></i>
                <small>{tower.hp > 0 ? (health < TOWER.critical ? `CRITICAL${tags ? ' · ' + tags : ''}` : tags || '—') : tower.kind === 'shield' ? 'SHIELD LOST' : tower.kind === 'radar' ? 'RADAR OFFLINE' : 'GUNS OFFLINE'}</small>
              </div>;
            })}
            <div className="objective-note">{objective}</div>
          </div>

          {isGunner && self ? <div className="flight-instruments gunner-instruments">
            <div className="instrument"><span>STN</span><b>{self.station + 1}</b><small>/ {stations.length} · TWR {myTower?.label ?? '-'}</small></div>
            <div className="instrument"><span>BRG</span><b>{heading(gunAimRef.current.yaw)}</b><small>DEG</small></div>
            <div className="instrument"><span>ELV</span><b>{degrees(gunAimRef.current.pitch)}</b><small>DEG</small></div>
            <div className="instrument"><span>RDR</span><b>{radarContacts}</b><small>{towers.some((tower) => tower.kind === 'radar' && tower.hp > 0) ? 'CONTACTS' : 'TOWER DOWN'}</small></div>
            <div className="instrument ammo"><span>FLAK</span><b className={self.flakAmmo < 50 ? 'instrument-limit' : ''}>{self.flakAmmo}</b><small>RDS</small></div>
            <div className="instrument ammo"><span>SAM</span><b className={self.samAmmo === 0 ? 'instrument-limit' : ''}>{self.samAmmo}</b><small>LEFT</small></div>
            <div className="weapon-readout">
              <span>AA GUN <b>{self.transit > 0 ? 'STOWED' : self.repairProgress > 0 ? 'REPAIRING' : self.flakAmmo ? 'READY' : 'EMPTY'}</b></span>
              <span>SAM <b>{!self.samAmmo ? 'EMPTY' : self.missileCooldown ? `${self.missileCooldown.toFixed(1)}S` : self.targetId ? 'LOCKED — RMB' : 'READY · NO LOCK'}</b></span>
              <span>SHIELD (F) <b>{self.barrierCooldown ? `${Math.ceil(self.barrierCooldown)}S` : 'READY'}</b></span>
              <span>REPAIR (R) <b>{self.repairCharges}× {self.repairCooldown ? `${Math.ceil(self.repairCooldown)}S` : myStation?.kind === 'repair' ? 'HOLD R' : 'R → PAD'}</b></span>
            </div>
            {self.repairProgress > 0 && <div className="repair-progress"><span>REPAIRING {myTower?.label} — HOLD R</span><i><em style={{ width: `${Math.min(100, self.repairProgress / TOWER.repairDuration * 100)}%` }} /></i></div>}
          </div> : <div className="flight-instruments">
            <AttitudeIndicator readState={readState} readSelfId={readSelfId} />
            <div className="instrument"><span>ALT</span><b>{self ? Math.round(self.y * METERS_PER_UNIT * 3.281).toLocaleString('en-US') : '---'}</b><small>FT</small></div>
            <div className="instrument"><span>SPD</span><b>{self ? Math.round(self.speed * METERS_PER_UNIT * 1.944) : '---'}</b><small>KT · M{self ? (self.speed * METERS_PER_UNIT / 340).toFixed(2) : '-.--'}</small></div>
            <div className="instrument"><span>G</span><b className={self && self.gLoad > JET_FLIGHT[self.model].maxG - .5 ? 'instrument-limit' : ''}>{self ? self.gLoad.toFixed(1) : '-.-'}</b><small>LOAD</small></div>
            <div className="instrument"><span>THR</span><b>{self ? Math.round(self.throttle * 100) : '--'}</b><small>{self?.burner ? 'AB' : '%'}</small></div>
            <div className="instrument"><span>HDG</span><b>{self ? heading(self.yaw) : '---'}</b><small>DEG</small></div>
            {self?.gcas ? <div className="flight-warning">PULL UP</div> : self?.stall ? <div className="flight-warning">STALL</div> : null}
            <div className="weapon-readout"><span>GUN <b>READY</b></span><span>MISSILE (RMB) <b>{self?.missileCooldown ? `${self.missileCooldown.toFixed(1)}S` : self?.targetId ? 'LOCKED — FIRE' : 'READY · NO LOCK'}</b></span></div>
          </div>}

          {isGunner && self?.alive && stations.length > 0 && <div className="station-picker" role="group" aria-label="Gun stations">
            <span className={self.transit > 0 ? 'redeploying' : ''}>{self.transit > 0 ? `DRIVING · ${self.transit.toFixed(1)}S` : 'STATIONS'}</span>
            {stations.map((station) => {
              const occupant = players.find((player) => player.id === station.occupantId);
              const mine = station.index === self.station;
              const taken = Boolean(occupant && occupant.id !== self.id && occupant.alive);
              const tower = towers.find((item) => item.id === station.towerId);
              return <button key={station.id} type="button" className={`${station.kind === 'repair' ? 'pad' : ''} ${mine ? 'mine' : ''} ${taken ? 'taken' : ''} ${tower && tower.hp <= 0 ? 'lost' : ''}`} disabled={taken || mine || self.transit > 0} onClick={() => requestStation(station.index)} title={taken ? `Crewed by ${occupant?.name}` : station.kind === 'repair' ? `Repair pad for the ${tower?.label} tower` : `Gun station ${station.index + 1}`}><b>{station.kind === 'repair' ? '✚' : station.index + 1}</b><small>{tower?.label.slice(0, 3)}{taken ? ' ●' : ''}</small></button>;
            })}
            <button type="button" className="repair-button" disabled={!self.repairCharges || self.repairCooldown > 0 || self.transit > 0 || !myTower || myTower.hp <= 0 || myTower.hp >= myTower.maxHp} onPointerDown={(event) => { event.preventDefault(); setKey('r', true); }} onPointerUp={() => setKey('r', false)} onPointerLeave={() => setKey('r', false)} title="Hold to repair (at a repair pad)"><b>✚</b><small>HOLD R</small></button>
            <button type="button" className="shield-button" disabled={self.barrierCooldown > 0 || self.transit > 0 || !myTower || myTower.hp <= 0} onClick={requestBarrier} title="Shield the tower beside you"><b>⛨</b><small>F</small></button>
          </div>}

          {self && !self.alive && phase === 'active' && <div className="spectator-note">{offlineTraining ? 'DOWN — BACK IN A MOMENT' : <>ELIMINATED — NO RESPAWNS UNTIL ROUND {snapshot?.round} ENDS<br />{spectating ? <>SPECTATING <b>{spectating.name}</b> · {ROLE_LABEL[spectating.role]} · Q / E OR CLICK TO SWITCH</> : 'NO TEAMMATES LEFT'}</>}</div>}
          {phase === 'prep' && self && !offlineTraining && <div className="prep-panel">
            <span className="prep-kicker">ROUND {snapshot?.round}{snapshot?.overtime ? ` · OT${snapshot.overtime}` : ''} · PREPARATION · {snapshot?.phaseSecondsLeft}S</span>
            <strong>{tiebreaker ? 'TIEBREAKER — 5V5 DOGFIGHT' : defender === self.team ? 'YOU DEFEND' : 'YOU ATTACK'} <em>· {ROLE_ICON[self.role]} {ROLE_LABEL[self.role]}</em></strong>
            {isGunner ? <>
              <p>Pick your loadout, then a gun station (1–6). Moves are instant until the countdown.</p>
              <div className="equip-row">{LOADOUTS.map(([id, option]) => <button key={id} type="button" className={self.loadout === id ? 'selected' : ''} onClick={() => chooseEquipment({ loadout: id })}><b>{option.name}</b><small>{option.description}</small></button>)}</div>
            </> : <>
              <p>{defender === self.team ? 'Intercept the attackers and cover your ground crews.' : tiebreaker ? 'Last squadron flying wins.' : 'Take out the Shield Tower first: it halves damage to the other two.'}</p>
              <div className="equip-row">{JET_CATALOG.map((model) => <button key={model.id} type="button" className={self.model === model.id ? 'selected' : ''} onClick={() => chooseEquipment({ model: model.id })}><b>{model.name}</b><small>{model.role} · {model.description}</small></button>)}</div>
            </>}
            {!tiebreaker && <div className="tower-brief">{towers.map((tower) => <div key={tower.id}><b>{tower.label}</b><small>{TOWER_ROLE[tower.kind]}</small></div>)}</div>}
          </div>}
          {phase === 'countdown' && !offlineTraining && <div className="combat-countdown"><span>WEAPONS FREE IN</span><b>{snapshot?.phaseSecondsLeft}</b></div>}
          {offlineTraining && isGunner && self && <div className="training-loadout">{LOADOUTS.map(([id, option]) => <button key={id} type="button" className={self.loadout === id ? 'selected' : ''} onClick={() => chooseEquipment({ loadout: id })}>{option.name}</button>)}</div>}
          {phase === 'intermission' && lastRound && <div className="round-card">
            <span>{roundLabel(lastRound)} · {lastRound.kind === 'tiebreaker' ? 'TIEBREAKER' : `${TEAM_SHORT[lastRound.defender!]} DEFENDED`}</span>
            <strong className={lastRound.winner ? `${lastRound.winner}-text` : ''}>{lastRound.winner ? `${TEAM_NAMES[lastRound.winner]} WINS` : 'DRAW — REPLAY'}</strong>
            <p>{lastRound.reason}</p>
            <div className="round-card-next">NEXT · ROUND {nextRound}{nextOvertime ? ` · OVERTIME ${nextOvertime}` : ''} · {nextDefender ? `${TEAM_NAMES[nextDefender]} DEFENDS${self ? ` · YOU ${nextDefender === self.team ? 'DEFEND' : 'ATTACK'}` : ''}` : 'TIEBREAKER — 5V5 DOGFIGHT'}</div>
            {nextRound === ROUNDS_PER_HALF + 1 && !nextOvertime && <div className="round-card-switch">⇄ SIDES SWITCH</div>}
          </div>}
          {phase === 'complete' && snapshot && <ResultsScreen state={snapshot} selfId={selfIdRef.current} onLeave={leaveArena} />}
          {phase === 'lobby' && !offlineTraining && <div className="awaiting-card">
            <i>✣</i>
            <b>{snapshot?.phaseSecondsLeft ? `MATCH STARTS IN ${snapshot.phaseSecondsLeft}` : 'WAITING FOR BOTH TEAMS'}</b>
            <span>SHARE THE ROOM LINK · {rosterCount}/{MAX_PLAYERS} PLAYERS · YOU ARE ON {self ? TEAM_NAMES[self.team] : '—'}</span>
            <span>ROUNDS 1–5: {TEAM_NAMES.azure} DEFENDS · ROUNDS 6–10: {TEAM_NAMES.ember} DEFENDS</span>
            <div className="preference-toggle" role="group" aria-label="Preferred role when defending"><em>WHEN DEFENDING</em>{PREFERENCES.map((preference) => <button key={preference.id} type="button" className={rolePreference === preference.id ? 'selected' : ''} aria-pressed={rolePreference === preference.id} title={preference.hint} onClick={() => chooseRolePreference(preference.id)}>{preference.label}</button>)}</div>
          </div>}
          <div className="control-legend">{isGunner
            ? <><span><kbd>MOUSE</kbd><kbd>WASD</kbd> AIM</span><span><kbd>LMB</kbd> AA CANNON</span><span><kbd>RMB</kbd> SAM (LOCK)</span><span><kbd>1</kbd>–<kbd>9</kbd><kbd>Q</kbd><kbd>E</kbd> MOVE</span><span><kbd>R</kbd> HOLD TO REPAIR (PAD)</span><span><kbd>F</kbd> SHIELD</span><span><kbd>M</kbd> SOUND</span></>
            : <><span><kbd>MOUSE</kbd><kbd>↑</kbd><kbd>↓</kbd> PITCH</span><span><kbd>A</kbd><kbd>D</kbd> TURN</span><span><kbd>Q</kbd><kbd>E</kbd> ROLL</span><span><kbd>W</kbd><kbd>S</kbd> THROTTLE</span><span><kbd>SPACE</kbd> AFTERBURNER</span><span><kbd>SHIFT</kbd> AIR BRAKE</span><span><kbd>LMB</kbd><kbd>F</kbd> CANNON</span><span><kbd>RMB</kbd><kbd>R</kbd> MISSILE</span><span><kbd>M</kbd> SOUND</span></>}</div>

          <div className="touch-flight-controls">
            <div className="touch-stick"><button onPointerDown={(event) => capturePress(event, 'arrowup')} onPointerUp={() => setKey('arrowup', false)} onPointerCancel={() => setKey('arrowup', false)} aria-label={isGunner ? 'Raise gun' : 'Nose up'}>↑</button><button onPointerDown={(event) => capturePress(event, 'a')} onPointerUp={() => setKey('a', false)} onPointerCancel={() => setKey('a', false)}>←</button><button onPointerDown={(event) => capturePress(event, 'arrowdown')} onPointerUp={() => setKey('arrowdown', false)} onPointerCancel={() => setKey('arrowdown', false)} aria-label={isGunner ? 'Lower gun' : 'Nose down'}>↓</button><button onPointerDown={(event) => capturePress(event, 'd')} onPointerUp={() => setKey('d', false)} onPointerCancel={() => setKey('d', false)}>→</button><button onPointerDown={(event) => capturePress(event, 'q')} onPointerUp={() => setKey('q', false)} onPointerCancel={() => setKey('q', false)}>↶</button><button onPointerDown={(event) => capturePress(event, 'e')} onPointerUp={() => setKey('e', false)} onPointerCancel={() => setKey('e', false)}>↷</button></div>
            <div className="touch-triggers"><button onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); primaryRef.current = true; primaryPulseUntilRef.current = performance.now() + 80; sendControls(); }} onPointerUp={() => { primaryRef.current = false; sendControls(); }} onPointerCancel={() => { primaryRef.current = false; sendControls(); }}>{isGunner ? 'FLAK' : 'GUN'}</button><button onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); secondaryRef.current = true; secondaryPulseUntilRef.current = performance.now() + 80; sendControls(); }} onPointerUp={() => { secondaryRef.current = false; sendControls(); }} onPointerCancel={() => { secondaryRef.current = false; sendControls(); }}>{isGunner ? 'SAM' : 'MSL'}</button>{isGunner ? <><button className="afterburn-trigger" onPointerDown={(event) => capturePress(event, 'r')} onPointerUp={() => setKey('r', false)} onPointerCancel={() => setKey('r', false)}>REPAIR</button><button onPointerDown={(event) => { event.preventDefault(); requestBarrier(); }}>SHIELD</button></> : <><button className="afterburn-trigger" onPointerDown={(event) => capturePress(event, ' ')} onPointerUp={() => setKey(' ', false)} onPointerCancel={() => setKey(' ', false)}>BOOST</button><button onPointerDown={(event) => capturePress(event, 'shift')} onPointerUp={() => setKey('shift', false)} onPointerCancel={() => setKey('shift', false)}>BRAKE</button></>}</div>
          </div>
        </section>
      )}

      {!connected && <section className="hangar-manual" id="flight-manual"><div className="manual-title"><span>HOW IT WORKS / 01</span><h2>Attack. Defend.<br />Switch sides.</h2><p>Up to eleven five-minute rounds. Blue defends rounds 1–5, Red defends 6–10. Each round won is a point; the first team to six wins the match. At 5–5, round 11 is a straight 5v5 dogfight. Drawn rounds are replayed. Nobody respawns mid-round.</p></div><article><i>01</i><span>ATTACKERS · 5 JETS</span><h3>Bring down the towers.</h3><p>Destroy all three towers, or eliminate all five defenders, before the clock runs out. Guns, cannons and lock-on missiles work on jets, gun crews and towers alike. Use the tunnels, bridges and gates to flank.</p></article><article><i>02</i><span>DEFENDERS · 3 GROUND + 2 JETS</span><h3>Hold one tower.</h3><p>Ground crews man anti-aircraft cannons and radar-guided SAMs, drive between six stations, and patch towers with limited repairs. A crewed tower’s point defence fires on attackers that get close. Two jets intercept. Keep one tower standing until time, or wipe out the attackers.</p></article><article><i>03</i><span>THE MATCH</span><h3>First to six.</h3><p>Choose PILOT, GROUND or ANY before you join: when your team defends, the two jets go to those who asked to fly. The results screen shows every round and every player’s kills, damage and repairs.</p></article></section>}
      {!connected && <footer className="hangar-footer"><span>SKYFORGE//STADIUM <i>·</i> AEROSPACE COMBAT LEAGUE</span><span>FIVE ATTACK. FIVE DEFEND.</span></footer>}
    </main>
  );
}

function ResultsScreen({ state, selfId, onLeave }: { state: RoomState; selfId: string; onLeave: () => void }) {
  const winner = state.matchWinner;
  const scored = state.players.map((player) => ({ player, score: playerScore(player) }));
  const mvp = scored.reduce<{ player: JetState; score: number } | null>((best, entry) => (!best || entry.score > best.score ? entry : best), null);
  return <div className="results-screen" role="dialog" aria-label="Match results">
    <span className="results-kicker">MATCH COMPLETE · FIRST TO {WINS_NEEDED}</span>
    <strong className={winner ? `${winner}-text` : ''}>{winner ? `${TEAM_NAMES[winner]} WINS` : 'MATCH DRAWN'}</strong>
    <div className="final-score"><b className="azure-text">{state.roundWins.azure}</b><i>—</i><b className="ember-text">{state.roundWins.ember}</b></div>
    <div className="round-strip">{state.history.map((record, index) => <div key={index} className={`round-cell ${record.winner ?? 'draw'}`} title={record.reason}>
      <i>{roundLabel(record)}</i><b>{record.winner ? TEAM_SHORT[record.winner] : 'DRAW'}</b><small>{record.kind === 'tiebreaker' ? 'TIEBREAK' : `${TEAM_SHORT[record.defender!]} DEF`}</small>
    </div>)}</div>
    <div className="results-tables">{(['azure', 'ember'] as const).map((team) => <table key={team} className={`results-table ${team}`}>
      <caption className={`${team}-text`}>{TEAM_NAMES[team]} · {state.roundWins[team]} ROUNDS</caption>
      <thead><tr><th>PLAYER</th><th>K</th><th>D</th><th>DMG</th><th>TOWER</th><th>REPAIR</th><th>SCORE</th></tr></thead>
      <tbody>{scored.filter(({ player }) => player.team === team).sort((a, b) => b.score - a.score).map(({ player, score }) => <tr key={player.id} className={player.id === selfId ? 'is-self' : ''}>
        <td>{mvp && mvp.score > 0 && mvp.player.id === player.id ? <em className="mvp">MVP</em> : null}{player.name}</td><td>{player.kills}</td><td>{player.deaths}</td><td>{Math.round(player.damage)}</td><td>{Math.round(player.towerDamage)}</td><td>{Math.round(player.repaired)}</td><td><b>{score}</b></td>
      </tr>)}</tbody>
    </table>)}</div>
    <p>NEW MATCH IN THIS ROOM IN {state.phaseSecondsLeft}S</p>
    <button onClick={onLeave}>RETURN TO HANGAR</button>
  </div>;
}
