import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA, FLIGHT_SCALE } from '@/lib/protocol';
import {
  addBeam, addBox, addLine, addOvalDeck, basic, detailedStandard, ellipsePoints, mergeStaticMeshes, standard,
  type DisplayState, type SkyHandle, type SurfaceMaps,
} from '@/lib/arena-kit';

/**
 * Skyforge Stadium: an enclosed aerospace combat arena.
 *
 * The build is deliberately layered outward so the middle of the bowl stays
 * empty enough for 5v5 dogfights:
 *   - the energy barrier matches the server's play volume exactly,
 *   - combat furniture (gates, bridges, floating pads) hugs the barrier,
 *   - stands, decks and screens sit outside the barrier,
 *   - the industrial yard sits outside the stands.
 */

/** The real, server-authoritative play volume. World space. */
const PLAY = {
  halfWidth: ARENA.halfWidth,
  halfDepth: ARENA.halfDepth,
  floor: ARENA.minAltitude,
  ceiling: ARENA.maxAltitude,
} as const;

/**
 * The stadium shell is modelled against the original 480-unit arena and then
 * scaled up as one group, so every proportion survives a change of ARENA_SCALE
 * without touching a thousand literals. Only the energy barrier, the weather
 * and the spark bursts are built in world space, because they have to line up
 * with server coordinates exactly.
 */
const AUTHORED = { halfWidth: 480, halfDepth: 370 } as const;
const SHELL_SCALE = ARENA.halfWidth / AUTHORED.halfWidth;
/** How far the industrial yard is pushed out from where it was first modelled. */
const YARD_PUSH = 2.05;

/** Wall-clock driven so every pilot in a room sees roughly the same sky. */
const DAY_CYCLE_MS = 6 * 60 * 1_000;

type SkyKey = {
  at: number;
  label: string;
  horizon: string;
  zenith: string;
  sunTint: string;
  sunDir: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  ambient: number;
  ambientIntensity: number;
  fog: string;
  fogDensity: number;
  stars: number;
  nightness: number;
  exposure: number;
};

const SKY_KEYS: SkyKey[] = [
  {
    at: 0, label: 'DAY', horizon: '#cfdde3', zenith: '#5f93bd', sunTint: '#fff1d6',
    sunDir: [-180, 420, 170], sunColor: 0xfff0dc, sunIntensity: 3.4,
    hemiSky: 0xa9c6dc, hemiGround: 0x1b2027, hemiIntensity: .75,
    ambient: 0x6d87a0, ambientIntensity: .1, fog: '#a9c1cf', fogDensity: .00042,
    stars: 0, nightness: 0, exposure: 1,
  },
  {
    at: .3, label: 'GOLDEN', horizon: '#ffcf98', zenith: '#5d86b3', sunTint: '#ffd08a',
    sunDir: [-330, 190, 130], sunColor: 0xffc27e, sunIntensity: 3.1,
    hemiSky: 0xcfb6a0, hemiGround: 0x1d1a1e, hemiIntensity: .62,
    ambient: 0x8a7f96, ambientIntensity: .09, fog: '#c9a88c', fogDensity: .00045,
    stars: 0, nightness: .2, exposure: 1.03,
  },
  {
    at: .46, label: 'SUNSET', horizon: '#ff7f4a', zenith: '#2f3c66', sunTint: '#ffa45e',
    sunDir: [-430, 54, 72], sunColor: 0xff8a4a, sunIntensity: 2.4,
    hemiSky: 0x9a6470, hemiGround: 0x151320, hemiIntensity: .48,
    ambient: 0x5d5480, ambientIntensity: .08, fog: '#8a5a52', fogDensity: .0005,
    stars: .1, nightness: .55, exposure: 1.1,
  },
  {
    at: .62, label: 'NIGHT', horizon: '#0e1a2c', zenith: '#03070f', sunTint: '#2a3550',
    sunDir: [-120, -70, 180], sunColor: 0xe2ecff, sunIntensity: 2.7,
    hemiSky: 0x1a2a40, hemiGround: 0x040609, hemiIntensity: .32,
    ambient: 0x2c4260, ambientIntensity: .07, fog: '#070d17', fogDensity: .00045,
    stars: 1, nightness: 1, exposure: 1.12,
  },
  {
    at: .86, label: 'DAWN', horizon: '#a7b9cf', zenith: '#33507a', sunTint: '#ffd5b8',
    sunDir: [300, 96, -150], sunColor: 0xffcfaa, sunIntensity: 2.4,
    hemiSky: 0x86a4bf, hemiGround: 0x14181f, hemiIntensity: .55,
    ambient: 0x5d7899, ambientIntensity: .09, fog: '#7890a6', fogDensity: .0005,
    stars: .15, nightness: .35, exposure: 1.06,
  },
];

/**
 * After dark the key light stops being the sun and becomes the stadium's
 * floodlighting: near-overhead, cool white, casting hard shadows.
 */
const FLOOD_KEY = new THREE.Vector3(-.18, 1, .24).normalize();

export type ArenaLighting = {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  sky: SkyHandle;
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
};

export type SkyforgeHandle = {
  draw(state?: DisplayState): void;
  update(nowMs: number, dt: number, jets?: { x: number; y: number; z: number }[]): void;
  signalBoundary(x?: number, y?: number, z?: number): void;
  reportImpact(x: number, y: number, z: number, major: boolean): void;
  /** Warning lights and the scoreboard alert for a while (critical or destroyed towers). */
  raiseAlarm(ms: number): void;
  /** 0 by day, 1 at night: lets post-processing lean into the glow after dark. */
  mood?(): number;
  dispose(): void;
};

/* ------------------------------------------------------------------ */
/* Shared canvas textures                                             */
/* ------------------------------------------------------------------ */

function createPuffTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(.45, 'rgba(255,255,255,.52)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ------------------------------------------------------------------ */
/* Particle systems: steam / smoke columns, sparks, weather           */
/* ------------------------------------------------------------------ */

type ParticleField = {
  points: THREE.Points;
  update(dt: number, intensity: number): void;
  dispose(): void;
};

function createColumn(parent: THREE.Object3D, texture: THREE.Texture, options: {
  origin: THREE.Vector3; count: number; rise: number; spread: number; size: number;
  color: THREE.ColorRepresentation; opacity: number; additive?: boolean; lifetime: number;
}): ParticleField {
  const { count, rise, spread, lifetime } = options;
  const positions = new Float32Array(count * 3);
  const ages = new Float32Array(count);
  const drift = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    ages[index] = Math.random() * lifetime;
    drift[index * 2] = (Math.random() - .5) * spread;
    drift[index * 2 + 1] = (Math.random() - .5) * spread;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    map: texture, color: options.color, size: options.size, transparent: true,
    opacity: options.opacity, depthWrite: false, sizeAttenuation: true,
    blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.position.copy(options.origin);
  points.frustumCulled = false;
  parent.add(points);
  const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
  const write = () => {
    for (let index = 0; index < count; index += 1) {
      const progress = ages[index] / lifetime;
      attribute.setXYZ(
        index,
        drift[index * 2] * (.35 + progress * 1.9),
        progress * rise,
        drift[index * 2 + 1] * (.35 + progress * 1.9),
      );
    }
    attribute.needsUpdate = true;
  };
  write();
  return {
    points,
    update(dt, intensity) {
      material.opacity = options.opacity * intensity;
      points.visible = intensity > .02;
      if (!points.visible) return;
      for (let index = 0; index < count; index += 1) {
        ages[index] += dt;
        if (ages[index] > lifetime) ages[index] -= lifetime;
      }
      write();
    },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}

type SparkBurst = {
  points: THREE.Points;
  burst(x: number, y: number, z: number, count: number, power: number): void;
  update(dt: number): void;
  dispose(): void;
};

function createSparks(parent: THREE.Object3D, texture: THREE.Texture, capacity: number): SparkBurst {
  const positions = new Float32Array(capacity * 3).fill(-99_999);
  const velocities = new Float32Array(capacity * 3);
  const life = new Float32Array(capacity);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    map: texture, color: '#ffd59a', size: 4.4 * FLIGHT_SCALE, transparent: true, opacity: .95,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  parent.add(points);
  const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
  let cursor = 0;
  return {
    points,
    burst(x, y, z, count, power) {
      for (let spawned = 0; spawned < count; spawned += 1) {
        const index = cursor;
        cursor = (cursor + 1) % capacity;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(1 - Math.random() * 1.4);
        const speed = power * (.45 + Math.random() * .85);
        velocities[index * 3] = Math.sin(phi) * Math.cos(theta) * speed;
        velocities[index * 3 + 1] = Math.cos(phi) * speed * .9 + power * .2;
        velocities[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
        life[index] = .5 + Math.random() * .75;
        attribute.setXYZ(index, x, y, z);
      }
      attribute.needsUpdate = true;
    },
    update(dt) {
      let touched = false;
      for (let index = 0; index < capacity; index += 1) {
        if (life[index] <= 0) continue;
        life[index] -= dt;
        touched = true;
        if (life[index] <= 0) { attribute.setXYZ(index, -99_999, -99_999, -99_999); continue; }
        velocities[index * 3 + 1] -= 42 * SHELL_SCALE * dt;
        attribute.setXYZ(
          index,
          attribute.getX(index) + velocities[index * 3] * dt,
          attribute.getY(index) + velocities[index * 3 + 1] * dt,
          attribute.getZ(index) + velocities[index * 3 + 2] * dt,
        );
      }
      if (touched) attribute.needsUpdate = true;
    },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}

/** Rain falling outside the dome, plus dust motes drifting inside it. */
function createWeather(parent: THREE.Object3D, texture: THREE.Texture) {
  // The bowl is enclosed, so rain only falls on the annulus outside the dome.
  const rainCount = 700;
  const rainPositions = new Float32Array(rainCount * 3);
  const seedRain = (index: number, y: number) => {
    const angle = Math.random() * Math.PI * 2;
    const spread = 1 + Math.random() * 1.2;
    rainPositions[index * 3] = Math.cos(angle) * 1_250 * SHELL_SCALE * spread;
    rainPositions[index * 3 + 1] = y;
    rainPositions[index * 3 + 2] = Math.sin(angle) * 1_050 * SHELL_SCALE * spread;
  };
  for (let index = 0; index < rainCount; index += 1) seedRain(index, Math.random() * 760 * SHELL_SCALE);
  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  const rainMaterial = new THREE.PointsMaterial({
    color: '#c6e6f5', size: 3.1 * SHELL_SCALE, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true,
  });
  const rain = new THREE.Points(rainGeometry, rainMaterial);
  rain.frustumCulled = false;
  parent.add(rain);

  const moteCount = 170;
  const motePositions = new Float32Array(moteCount * 3);
  const motePhase = new Float32Array(moteCount);
  for (let index = 0; index < moteCount; index += 1) {
    motePositions[index * 3] = (Math.random() - .5) * PLAY.halfWidth * 2;
    motePositions[index * 3 + 1] = PLAY.floor + Math.random() * (PLAY.ceiling - PLAY.floor);
    motePositions[index * 3 + 2] = (Math.random() - .5) * PLAY.halfDepth * 2;
    motePhase[index] = Math.random() * Math.PI * 2;
  }
  const moteGeometry = new THREE.BufferGeometry();
  moteGeometry.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
  const moteMaterial = new THREE.PointsMaterial({
    map: texture, color: '#d8f3ff', size: 2.6 * FLIGHT_SCALE, transparent: true, opacity: .3,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const motes = new THREE.Points(moteGeometry, moteMaterial);
  motes.frustumCulled = false;
  parent.add(motes);

  const rainAttribute = rainGeometry.getAttribute('position') as THREE.BufferAttribute;
  const moteAttribute = moteGeometry.getAttribute('position') as THREE.BufferAttribute;
  return {
    update(dt: number, time: number, storm: number, nightness: number) {
      rainMaterial.opacity = storm * .5;
      rain.visible = storm > .03;
      if (rain.visible) {
        for (let index = 0; index < rainCount; index += 1) {
          const y = rainAttribute.getY(index) - (240 + storm * 220) * SHELL_SCALE * dt;
          if (y < -40 * SHELL_SCALE) {
            seedRain(index, 760 * SHELL_SCALE);
            rainAttribute.setXYZ(index, rainPositions[index * 3], rainPositions[index * 3 + 1], rainPositions[index * 3 + 2]);
            continue;
          }
          rainAttribute.setXYZ(index, rainAttribute.getX(index) - 46 * SHELL_SCALE * storm * dt, y, rainAttribute.getZ(index));
        }
        rainAttribute.needsUpdate = true;
      }
      moteMaterial.opacity = .14 + nightness * .26;
      for (let index = 0; index < moteCount; index += 1) {
        const phase = motePhase[index];
        moteAttribute.setXYZ(
          index,
          moteAttribute.getX(index) + Math.sin(time * .0004 + phase) * 6 * dt,
          moteAttribute.getY(index) + Math.cos(time * .0003 + phase) * 4 * dt,
          moteAttribute.getZ(index) + Math.cos(time * .00035 + phase * 1.3) * 6 * dt,
        );
      }
      moteAttribute.needsUpdate = true;
    },
    dispose() { rainGeometry.dispose(); rainMaterial.dispose(); moteGeometry.dispose(); moteMaterial.dispose(); },
  };
}

/* ------------------------------------------------------------------ */
/* Screens: scoreboards, broadcast panels, rolling adverts            */
/* ------------------------------------------------------------------ */

type ScreenHandle = {
  material: THREE.MeshBasicMaterial;
  draw(state: DisplayState | undefined, time: number, alarm: boolean, phaseLabel: string): void;
  /** Flashes the alert card by swapping textures: no repaint, no upload. */
  setAlert(on: boolean): void;
  dispose(): void;
};

function createScoreboard(): ScreenHandle {
  const canvas = document.createElement('canvas');
  canvas.width = 1_024;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
  const ticker = [
    'SKYFORGE STADIUM  •  SECTOR 7 AEROSPACE COMBAT LEAGUE',
    'ENERGY BARRIER ONLINE  •  FLIGHT ENVELOPE LOCKED',
    'THREE TOWERS ARMED  •  DESTROY ALL THREE TO TAKE THE ROUND',
    'ROUNDS 1–5 BLUE DEFENDS  •  ROUNDS 6–10 RED DEFENDS  •  FIRST TO SIX',
    'CROWD CAPACITY 184,000  •  BROADCAST FEED LIVE',
  ];
  const draw: ScreenHandle['draw'] = (state, time, alarm, phaseLabel) => {
    if (!context) return;
    context.fillStyle = '#071725';
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = '#41c8ee';
    context.fillRect(0, 0, canvas.width / 2, 11);
    context.fillStyle = '#ef334b';
    context.fillRect(canvas.width / 2, 0, canvas.width / 2, 11);

    context.fillStyle = '#eaf8ff';
    context.font = '700 66px Rajdhani, sans-serif';
    context.fillText('SKYFORGE', 40, 104);

    context.font = '600 25px Rajdhani, sans-serif';
    context.fillStyle = '#58cdef';
    context.fillText(state && state.room !== 'TRAINING' ? `BLUE  ${state.roundWins.azure}${state.defender === 'azure' ? '   DEF' : ''}` : '5 VS 5   •   ATTACK & DEFEND', 43, 158);
    context.fillStyle = '#ff6679';
    context.fillText(state && state.room !== 'TRAINING' ? `RED  ${state.roundWins.ember}${state.defender === 'ember' ? '   DEF' : ''}` : '11 ROUNDS   •   FIRST TO 6', 43, 198);

    // Round pips make the series state readable from across the bowl.
    const decided = state?.history?.filter((record) => record.winner) ?? [];
    for (let round = 0; round < 11; round += 1) {
      const winner = decided[round]?.winner;
      context.fillStyle = winner === 'azure' ? '#58cdef' : winner === 'ember' ? '#ff6679' : '#1b3042';
      context.fillRect(430 + round * 24, 140, 18, 10);
    }

    const seconds = Math.max(0, Math.floor(state?.secondsLeft ?? 0));
    const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    context.fillStyle = '#eaf8ff';
    context.font = '700 58px Rajdhani, sans-serif';
    context.fillText(state && state.room !== 'TRAINING' ? clock : '--:--', 430, 112);

    context.fillStyle = '#9ab3c2';
    context.font = '500 18px Rajdhani, sans-serif';
    const status = state?.room === 'TRAINING'
      ? 'TRAINING RANGE   •   PRACTICE DRILL'
      : state
        ? `ROUND ${String(state.round).padStart(2, '0')} / 11${state.overtime ? ` OT${state.overtime}` : ''}   •   ${state.phase === 'active' ? (state.roundKind === 'tiebreaker' ? 'SUDDEN DEATH' : `${state.defender === 'azure' ? 'BLUE' : 'RED'} DEFENDS`) : state.phase.toUpperCase()}`
        : 'AUTONOMOUS COMBAT STADIUM';
    context.fillText(status, 700, 226);
    // The three towers: lit while standing, struck through once destroyed.
    if (state?.towers?.length) {
      state.towers.forEach((tower, index) => {
        const x = 700 + index * 104;
        const health = Math.max(0, tower.hp / tower.maxHp);
        context.fillStyle = '#10283a'; context.fillRect(x, 128, 96, 34);
        context.fillStyle = health <= 0 ? '#3a1a1f' : health < .25 ? '#ff5b4d' : tower.team === 'azure' ? '#58cdef' : '#ff6679';
        context.fillRect(x, 156, 96 * health, 6);
        context.fillStyle = health <= 0 ? '#6b4b52' : '#eaf8ff';
        context.font = '700 16px Rajdhani, sans-serif';
        context.fillText(health <= 0 ? `${tower.label} ✕` : tower.label, x + 6, 149);
      });
    }
    context.fillStyle = '#5f7f93';
    context.fillText(phaseLabel, 700, 202);

    // Ticker line, changing every few seconds.
    context.fillStyle = '#7fd8f0';
    context.font = '600 21px Rajdhani, sans-serif';
    context.fillText(ticker[Math.floor(time / 9_000) % ticker.length], 36, 236);

    texture.needsUpdate = true;
  };
  draw(undefined, 0, false, 'DAY');

  // The alert card is painted once. Flashing it swaps the material's map
  // between two already-uploaded textures, which costs nothing per flash.
  const alertCanvas = document.createElement('canvas');
  alertCanvas.width = canvas.width;
  alertCanvas.height = canvas.height;
  const alertContext = alertCanvas.getContext('2d');
  if (alertContext) {
    alertContext.fillStyle = '#7a0f1f';
    alertContext.fillRect(0, 0, alertCanvas.width, alertCanvas.height);
    alertContext.fillStyle = '#fff3f4';
    alertContext.font = '700 96px Rajdhani, sans-serif';
    alertContext.fillText('⚠ ALERT', 300, 150);
    alertContext.font = '600 28px Rajdhani, sans-serif';
    alertContext.fillText('CORE BREACH DETECTED', 330, 196);
  }
  const alertTexture = new THREE.CanvasTexture(alertCanvas);
  alertTexture.colorSpace = THREE.SRGBColorSpace;
  const setAlert = (on: boolean) => {
    const next = on ? alertTexture : texture;
    if (material.map !== next) material.map = next;
  };
  return { material, draw, setAlert, dispose: () => { texture.dispose(); alertTexture.dispose(); } };
}

type AdvertHandle = { material: THREE.MeshBasicMaterial; draw(time: number): void; dispose(): void };

function createAdvert(accent: string): AdvertHandle {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.DoubleSide });
  const messages = [
    'SKYFORGE SYSTEMS  /  OWN THE AIRSPACE',
    'VECTOR 7  /  FLIGHT SIMULATION SUITE',
    'AEGIS DEFENCE  /  CLEAR SKY. SAFE RETURN.',
    'SKYFORGE STADIUM  /  ELEVEN ROUNDS. FIRST TO SIX.',
    'HALON DYNAMICS  /  THRUST WITHOUT LIMIT',
    'ORBITAL FREIGHT  /  WE MOVE THE HEAVY SKY',
  ];
  let lastSlot = -1;
  const draw = (time: number) => {
    if (!context) return;
    // Every repaint re-uploads the canvas and rebuilds its mipmaps, which is
    // a real GPU hitch at this size, so only repaint when the message changes.
    const slot = Math.floor(time / 7_000) % messages.length;
    if (slot === lastSlot) return;
    lastSlot = slot;
    context.fillStyle = '#06131f';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = accent;
    context.fillRect(0, 0, 9, canvas.height);
    context.fillRect(24, 22, 92, 5);
    context.fillStyle = '#edfaff';
    context.font = '700 34px Rajdhani, sans-serif';
    context.fillText(messages[slot], 28, 78);
    context.fillStyle = '#95adbd';
    context.font = '500 13px Rajdhani, sans-serif';
    context.fillText('SKYFORGE AEROSPACE COMMAND  •  SECURE FLIGHT NETWORK', 29, 105);
    texture.needsUpdate = true;
  };
  draw(0);
  return { material, draw, dispose: () => texture.dispose() };
}

/* ------------------------------------------------------------------ */
/* Energy barrier                                                     */
/* ------------------------------------------------------------------ */

function createBarrier(parent: THREE.Object3D) {
  const uniforms = {
    time: { value: 0 },
    tint: { value: new THREE.Color('#6fe4ff') },
    alertTint: { value: new THREE.Color('#ff4a62') },
    alert: { value: 0 },
    glow: { value: .4 },
    ripples: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 0, -1)) },
    floorY: { value: PLAY.floor },
    ceilingY: { value: PLAY.ceiling },
    cellScale: { value: SHELL_SCALE },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    // Pilots are always inside the flight volume, so only inner faces show.
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `${SAFE_GLSL}
      varying vec3 vWorld;
      varying vec3 vNormalWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalWorld = safeNormalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `uniform float time;
      uniform vec3 tint;
      uniform vec3 alertTint;
      uniform float alert;
      uniform float glow;
      uniform vec4 ripples[4];
      uniform float floorY;
      uniform float ceilingY;
      uniform float cellScale;
      varying vec3 vWorld;
      varying vec3 vNormalWorld;
      ${SAFE_GLSL}
      float lattice(vec3 q) {
        // Three interfering axes read as a hex weave without a texture lookup.
        vec3 p = q / cellScale;
        float a = sin(p.x * 0.09 + p.y * 0.05);
        float b = sin(p.z * 0.09 - p.y * 0.05);
        float c = sin((p.x + p.z) * 0.065 + p.y * 0.04);
        return max(max(abs(a), abs(b)), abs(c));
      }
      void main() {
        vec3 view = safeNormalize(cameraPosition - vWorld);
        float facing = 1.0 - abs(dot(safeNormalize(vNormalWorld), view));
        float fresnel = pow(clamp(facing, 0.0, 1.0), 3.4);

        float cells = smoothstep(0.86, 1.0, lattice(vWorld));
        float scan = 0.5 + 0.5 * sin(vWorld.y * 0.06 - time * 1.4);

        float height = clamp((vWorld.y - floorY) / max(1.0, ceilingY - floorY), 0.0, 1.0);
        // Hide the volume's floor plane and brighten its ceiling.
        float vertical = smoothstep(0.0, 0.08, height) * (0.65 + 0.9 * pow(height, 2.2));

        float ripple = 0.0;
        for (int index = 0; index < 4; index += 1) {
          float age = ripples[index].w;
          if (age < 0.0) continue;
          float distance = length(vWorld - ripples[index].xyz);
          float front = age * 240.0 * cellScale;
          ripple += smoothstep(42.0 * cellScale, 0.0, abs(distance - front)) * max(0.0, 1.0 - age / 1.3);
        }

        vec3 color = mix(tint, alertTint, clamp(alert, 0.0, 1.0));
        float strength = (fresnel * 0.5 + cells * 0.3 * fresnel * (0.55 + 0.45 * scan)) * vertical * glow;
        strength += ripple * 0.9;
        strength += alert * 0.07 * vertical;
        gl_FragColor = vec4(color * (0.6 + strength * 1.6), clamp(strength, 0.0, 0.5));
      }`,
  });
  const geometry = new THREE.BoxGeometry(PLAY.halfWidth * 2, PLAY.ceiling - PLAY.floor, PLAY.halfDepth * 2, 20, 10, 18);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = (PLAY.ceiling + PLAY.floor) / 2;
  mesh.renderOrder = 6;
  parent.add(mesh);

  let cursor = 0;
  const slots = uniforms.ripples.value;
  return {
    mesh,
    ripple(x: number, y: number, z: number) {
      slots[cursor].set(x, y, z, 0);
      cursor = (cursor + 1) % slots.length;
    },
    update(dt: number, time: number, alert: number, nightness: number) {
      uniforms.time.value = time / 1_000;
      uniforms.alert.value = alert;
      uniforms.glow.value = .1 + nightness * .12;
      for (const slot of slots) {
        if (slot.w < 0) continue;
        slot.w += dt;
        if (slot.w > 1.3) slot.w = -1;
      }
    },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}

/* ------------------------------------------------------------------ */
/* Destructible props                                                 */
/* ------------------------------------------------------------------ */

type Prop = {
  group: THREE.Group;
  anchor: THREE.Vector3;
  radius: number;
  hp: number;
  maxHp: number;
  fall: number;
  tilt: number;
  smoke: ParticleField | null;
  scorch: THREE.MeshStandardMaterial[];
};

/* ------------------------------------------------------------------ */
/* Builders                                                           */
/* ------------------------------------------------------------------ */

type Rig = {
  root: THREE.Group;
  surfaces: SurfaceMaps;
  /** Lamps that pulse normally and strobe red on a barrier or core alert. */
  warningLamps: THREE.Mesh[];
  /** Shared by every warning lamp: animating it pulses them all in one go. */
  lampMaterial: THREE.MeshBasicMaterial;
  /** Emissive surfaces that only light up after dusk. */
  nightGlow: { material: THREE.MeshStandardMaterial; day: number; night: number }[];
  screens: { material: THREE.MeshBasicMaterial; day: number; night: number }[];
  floodLamps: THREE.MeshBasicMaterial[];
  rotators: { object: THREE.Object3D; axis: 'x' | 'y' | 'z'; speed: number }[];
  oscillators: { object: THREE.Object3D; axis: 'x' | 'y' | 'z'; home: number; amplitude: number; speed: number; phase: number }[];
  adverts: AdvertHandle[];
  holograms: THREE.Mesh[];
  columns: { field: ParticleField; base: number }[];
  props: Prop[];
  clouds: THREE.Group[];
  crowdUniforms: { crowdTime: { value: number }; crowdWave: { value: number }; crowdIdle: { value: number }; crowdNight: { value: number }; crowdTifo: { value: number } };
  bannerUniforms: { bannerTime: { value: number }; bannerGust: { value: number } };
  /** Meshes that must NOT be merged: their own transform or local vertex
   *  positions are read at runtime (banner sway, spinning parts, props). */
  protect: THREE.Object3D[];
  puffTexture: THREE.Texture;
  reactorRings: THREE.Object3D[];
  /** Shared clock for every energy shader (plasma, light volumes). */
  energy: { time: { value: number } };
  /** Night light shafts from the roof floodlights. */
  shafts: THREE.ShaderMaterial | null;
  reactorCore: THREE.MeshStandardMaterial | null;
  gates: THREE.Object3D[];
  floaters: { object: THREE.Object3D; home: number; phase: number }[];
};

/* ------------------------------------------------------------------ */
/* Bowl: three seating tiers drawn by a procedural crowd shader        */
/* ------------------------------------------------------------------ */

/**
 * One ring of seating: an elliptical band rising from its front edge to its
 * back edge, as [radiusX, radiusZ, height] in shell units.
 */
type Tier = { front: [number, number, number]; back: [number, number, number] };
const TIERS: Tier[] = [
  { front: [505, 395, 14], back: [640, 505, 78] },
  { front: [672, 532, 94], back: [800, 640, 170] },
  { front: [832, 666, 186], back: [978, 784, 292] },
];
/** Outer facade and roof ring, shell units. */
const FACADE: [number, number] = [992, 796];
const ROOF_RING = { y: 330, inner: [760, 610] as [number, number], outer: [1004, 806] as [number, number] };
/**
 * World size of one seat and one row. Human scale and independent of the
 * arena, so a bigger stadium simply holds more people.
 */
const SEAT_WIDTH = 5.2;
const ROW_DEPTH = 7.4;

/**
 * An elliptical band in shell units. `uv` is laid out in WORLD units (u along
 * the ring, v along the slope) so shaders can tile human-scale detail on it.
 */
function bandGeometry(front: [number, number, number], back: [number, number, number], segments = 384) {
  const [fx, fz, fy] = front;
  const [bx, bz, by] = back;
  const slope = Math.hypot((bx - fx + bz - fz) / 2, by - fy) * SHELL_SCALE;
  // One radius for both edges. Using each edge's own radius skews the seat
  // columns by an amount that grows with angle, until by the far side of the
  // ring a single column slants across a thousand seats.
  const meanRadius = (fx + fz + bx + bz) / 4;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    positions.push(Math.cos(angle) * fx, fy, Math.sin(angle) * fz);
    uvs.push(angle * meanRadius * SHELL_SCALE, 0);
    positions.push(Math.cos(angle) * bx, by, Math.sin(angle) * bz);
    uvs.push(angle * meanRadius * SHELL_SCALE, slope);
  }
  // Wound so the front face looks in toward the pitch.
  for (let index = 0; index < segments; index += 1) {
    const k = index * 2;
    indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A vertical elliptical wall, facing inward unless `outward`. `uv.x` repeats every `repeatWorld` units. */
function wallGeometry(radiusX: number, radiusZ: number, bottom: number, top: number, repeatWorld: number, outward = false, segments = 384) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const mean = (radiusX + radiusZ) / 2;
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const u = (angle * mean * SHELL_SCALE) / repeatWorld;
    positions.push(Math.cos(angle) * radiusX, bottom, Math.sin(angle) * radiusZ);
    uvs.push(u, 0);
    positions.push(Math.cos(angle) * radiusX, top, Math.sin(angle) * radiusZ);
    uvs.push(u, 1);
  }
  for (let index = 0; index < segments; index += 1) {
    const k = index * 2;
    if (outward) indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    else indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Seated spectators, painted per pixel onto the tier surface: seat backs,
 * torsos, heads and raised arms, team-coloured home ends, aisles, tunnel
 * mouths, a travelling Mexican wave, card-stunt tifos and phone lights at
 * night. Costs nothing per spectator, so the bowl can hold a city.
 */
/** Slogans on the fans' banners: four Blue designs, then four Red. */
const CROWD_BANNERS: { text: string; ground: string; ink: string; trim: string }[] = [
  { text: 'BLUE ARMY', ground: '#0d4f9e', ink: '#ffffff', trim: '#7fd3ff' },
  { text: 'HOLD THE LINE', ground: '#f2f6fa', ink: '#0d4f9e', trim: '#1b8be0' },
  { text: 'SKYFORGE BLUE', ground: '#06315a', ink: '#8fe3ff', trim: '#ffffff' },
  { text: 'DEFEND THE TOWERS', ground: '#1b8be0', ink: '#ffffff', trim: '#06315a' },
  { text: 'RED STORM', ground: '#a3121f', ink: '#ffffff', trim: '#ffb0b8' },
  { text: 'BURN THE SKY', ground: '#f6f0ee', ink: '#a3121f', trim: '#e0303f' },
  { text: 'RED NATION', ground: '#4a0710', ink: '#ff8c95', trim: '#ffffff' },
  { text: 'ALL OR NOTHING', ground: '#e0303f', ink: '#ffffff', trim: '#4a0710' },
];

/** Paints the fans' banners into one atlas (8 across) that the crowd shader samples. */
function createCrowdBannerAtlas() {
  const cellWidth = 512;
  const cellHeight = 96;
  const canvas = document.createElement('canvas');
  canvas.width = cellWidth * CROWD_BANNERS.length;
  canvas.height = cellHeight;
  const context = canvas.getContext('2d');
  if (context) {
    CROWD_BANNERS.forEach((banner, index) => {
      const x = index * cellWidth;
      context.fillStyle = banner.ground;
      context.fillRect(x, 0, cellWidth, cellHeight);
      // Hand-painted look: a trim band top and bottom, and a diamond at each end.
      context.fillStyle = banner.trim;
      context.fillRect(x, 6, cellWidth, 7);
      context.fillRect(x, cellHeight - 13, cellWidth, 7);
      for (const cx of [x + 32, x + cellWidth - 32]) {
        context.beginPath();
        context.moveTo(cx, 30); context.lineTo(cx + 16, 48); context.lineTo(cx, 66); context.lineTo(cx - 16, 48);
        context.closePath();
        context.fill();
      }
      context.fillStyle = banner.ink;
      context.font = '800 52px "Barlow Condensed", Rajdhani, Arial, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(banner.text, x + cellWidth / 2, cellHeight / 2 + 2, cellWidth - 110);
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function crowdSurfaceMaterial(rig: Rig) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: .88, metalness: .02, side: THREE.DoubleSide,
  });
  material.defines = { USE_UV: '' };
  const bannerAtlas = createCrowdBannerAtlas();
  material.userData.bannerAtlas = bannerAtlas;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, rig.crowdUniforms, {
      crowdSeat: { value: new THREE.Vector2(SEAT_WIDTH, ROW_DEPTH) },
      crowdTifoBand: { value: 34 * SHELL_SCALE },
      crowdBanner: { value: bannerAtlas },
    });
    shader.vertexShader = `varying vec3 vCrowdWorld;
${shader.vertexShader}`.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vCrowdWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );
    shader.fragmentShader = `uniform float crowdTime;
uniform float crowdWave;
uniform float crowdIdle;
uniform float crowdNight;
uniform float crowdTifo;
uniform vec2 crowdSeat;
uniform float crowdTifoBand;
uniform sampler2D crowdBanner;
varying vec3 vCrowdWorld;
float cHash(vec2 p) {
  p = mod(p, 4096.0);
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float cBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float crowdNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1.0, 0.0)), u.x), mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 cShirt(float h, float team) {
  float stripe = step(0.5, fract(h * 7.0)) * 0.18;
  if (team < -0.5 && h < 0.64) return mix(vec3(0.10, 0.48, 0.78), vec3(0.85, 0.92, 0.97), stripe);
  if (team > 0.5 && h < 0.64) return mix(vec3(0.72, 0.10, 0.16), vec3(0.95, 0.88, 0.88), stripe);
  float k = fract(h * 13.7);
  if (k < 0.18) return vec3(0.80);
  if (k < 0.34) return vec3(0.05, 0.05, 0.06);
  if (k < 0.46) return vec3(0.28, 0.29, 0.32);
  if (k < 0.56) return vec3(0.05, 0.08, 0.18);
  if (k < 0.64) return vec3(0.60, 0.08, 0.10);
  if (k < 0.72) return vec3(0.74, 0.50, 0.08);
  if (k < 0.80) return vec3(0.08, 0.28, 0.12);
  if (k < 0.88) return vec3(0.10, 0.42, 0.70);
  return vec3(0.74, 0.26, 0.06);
}
${shader.fragmentShader}`.replace(
      '#include <map_fragment>',
      `
      vec2 seatUv = vUv / crowdSeat;
      vec2 cell = floor(seatUv);
      vec2 f = fract(seatUv);
      float h1 = cHash(cell);
      float h2 = cHash(cell + 19.7);
      float h3 = cHash(cell + 53.1);
      float h4 = cHash(cell + 7.3);
      // Seats-per-pixel along each axis. At grazing angles the two differ by
      // orders of magnitude, so they are handled separately.
      float pxX = clamp(fwidth(seatUv.x), 0.0001, 64.0);
      float pxY = clamp(fwidth(seatUv.y), 0.0001, 64.0);
      float px = max(pxX, pxY);
      float aa = px * 0.75;

      float radial = length(vCrowdWorld.xz);
      float endness = abs(vCrowdWorld.x) / max(radial, 1.0);
      float team = endness > 0.8 ? sign(vCrowdWorld.x) : 0.0;
      float endZone = smoothstep(0.84, 0.9, endness);

      float aisleCol = mod(cell.x, 28.0);
      float block = floor(cell.x / 28.0);
      float aisle = step(aisleCol, 0.99);
      float tunnel = step(mod(block, 4.0), 0.5) * step(9.0, aisleCol) * step(aisleCol, 19.0)
        * step(30.0, cell.y) * step(cell.y, 44.0);
      // Empty seats come in small clusters, the way real crowds thin out; the home ends stay packed.
      float emptyPatch = step(0.84, crowdNoise(seatUv / vec2(7.0, 3.0) + 31.0)) * (1.0 - abs(team));
      float occupied = step(0.04 + (1.0 - abs(team)) * 0.04, h3) * (1.0 - emptyPatch) * (1.0 - aisle) * (1.0 - tunnel);

      vec3 tifoBase = vCrowdWorld.x < 0.0 ? vec3(0.08, 0.46, 0.80) : vec3(0.76, 0.08, 0.16);
      float band = step(0.5, fract(vCrowdWorld.y / crowdTifoBand + (vCrowdWorld.x < 0.0 ? 0.0 : 0.5)));
      vec3 tifo = mix(tifoBase, vec3(0.9), band * 0.85);
      float tifoMix = crowdTifo * endZone;

      // Once either axis drops below ~2px per seat, people would alias into
      // sparkle. Use colour noise whose cells are coarsened per axis to about
      // one pixel each, like a hand-rolled anisotropic mip, with contrast that
      // falls off with distance the way a real crowd blurs out.
      // People only get drawn once a seat is ~6px+ wide; below that they read
      // as dots anyway and the noise path is far cheaper per pixel.
      float distant = smoothstep(0.12, 0.32, px);
      // Far crowd, properly filtered. Per-cell random colours at pixel size
      // alias into TV static that flickers whenever the camera moves. Instead:
      // smooth value noise sized to ~3 pixels, with two adjacent sizes blended
      // by the fractional level so nothing pops as distance changes.
      float lod = max(0.0, log2(px * 3.0));
      float lodBase = floor(lod);
      float lodBlend = lod - lodBase;
      float mottle = mix(crowdNoise(seatUv / exp2(lodBase) + lodBase * 17.0), crowdNoise(seatUv / exp2(lodBase + 1.0) + (lodBase + 1.0) * 17.0), lodBlend);
      vec3 mean = team < -0.5 ? vec3(0.13, 0.24, 0.36) : (team > 0.5 ? vec3(0.36, 0.13, 0.16) : vec3(0.24, 0.22, 0.23));
      vec3 average = mean * (1.0 + (mottle - 0.5) * 1.1 / (1.0 + lod * 0.3));
      average = mix(average, tifo, tifoMix * 0.9);
      vec3 color = average;
      float personShape = 0.35;

      // Seats and people are the expensive part. Most of the far stands are
      // pure noise already, so they skip this entirely.
      if (distant < 0.999) {
        vec3 concrete = vec3(0.15, 0.16, 0.18);
        vec3 near = concrete * (0.8 + 0.2 * step(0.28, f.y));
        vec3 plastic = team < -0.5 ? vec3(0.04, 0.16, 0.30) : (team > 0.5 ? vec3(0.30, 0.04, 0.07) : vec3(0.10, 0.12, 0.16));
        float seatBack = cBox(f - vec2(0.5, 0.5), vec2(0.40, 0.15), 0.06);
        near = mix(near, plastic, (1.0 - aisle) * (1.0 - smoothstep(-aa, aa, seatBack)));

        float ring = atan(vCrowdWorld.z, vCrowdWorld.x) / 6.2831853 + 0.5;
        float travel = fract(ring - crowdTime * 0.045);
        float crest = smoothstep(0.0, 0.02, travel) * (1.0 - smoothstep(0.02, 0.07, travel));
        float stand = clamp(crest * crowdWave + step(0.965, h2) * crowdIdle, 0.0, 1.0);
        float bob = sin(crowdTime * (2.0 + h1 * 3.0) + h2 * 30.0) * 0.025 * crowdIdle;
        // Build: children to big adults, each sitting a little off-centre.
        float build = 0.84 + fract(h1 * 7.31) * 0.3;
        vec2 p = f - vec2(0.5 + (h4 - 0.5) * 0.12, 0.0);
        p.y -= stand * 0.22 + bob;
        p /= build;
        float torso = cBox(p - vec2(0.0, 0.40), vec2(0.30 + h1 * 0.06, 0.22), 0.13);
        float armL = cBox(p - vec2(-0.36, 0.62 + stand * 0.12), vec2(0.055, 0.07 + stand * 0.18), 0.05);
        float armR = cBox(p - vec2(0.36, 0.62 + stand * 0.12), vec2(0.055, 0.07 + stand * 0.18), 0.05);
        float body = min(torso, mix(1.0, min(armL, armR), step(0.35, stand)));
        float head = length((p - vec2(0.0, 0.76)) * vec2(1.0, 0.92)) - 0.15;
        // Skin: a realistic spread from light to deep brown.
        float tone = fract(h4 * 3.71);
        vec3 skin = tone < 0.5
          ? mix(vec3(0.89, 0.70, 0.58), vec3(0.72, 0.50, 0.36), tone * 2.0)
          : mix(vec3(0.72, 0.50, 0.36), vec3(0.30, 0.19, 0.13), (tone - 0.5) * 2.0);
        // Hair: mostly dark, some brown, blonde, grey; some wear caps.
        float hairPick = fract(h2 * 5.13);
        vec3 hair = hairPick < 0.55 ? vec3(0.03, 0.025, 0.02) : hairPick < 0.8 ? vec3(0.20, 0.12, 0.06)
          : hairPick < 0.92 ? vec3(0.62, 0.48, 0.24) : vec3(0.55, 0.55, 0.55);
        float cap = step(0.8, fract(h3 * 9.7));
        vec3 capColor = abs(team) > 0.5 && fract(h3 * 17.1) < 0.7 ? (team < 0.0 ? vec3(0.08, 0.40, 0.75) : vec3(0.70, 0.08, 0.14)) : vec3(0.08, 0.08, 0.09);
        vec3 crown = mix(hair, capColor, cap);
        float crownLine = cap > 0.5 ? 0.02 : 0.06;
        vec3 headColor = mix(skin, crown, smoothstep(crownLine, crownLine + 0.05, p.y - 0.76));
        // Light from above: faces lit on one side, chins and the far cheek in shade.
        headColor *= 0.82 + 0.3 * clamp(0.5 - p.x * 1.6 + (p.y - 0.76) * 1.2, 0.0, 1.0);
        // Shirts: lit on the shoulders, darker at the sides and in the lap.
        vec3 shirt = cShirt(h1, team);
        shirt *= (0.7 + 0.4 * clamp((p.y - 0.18) / 0.5, 0.0, 1.0)) * (1.0 - 0.28 * smoothstep(0.14, 0.34, abs(p.x)));
        // Team scarves round the neck; standing fans hold them up overhead.
        float scarfOwner = step(abs(team) > 0.5 ? 0.45 : 0.85, fract(h2 * 11.3));
        vec3 scarfColor = team < 0.0 || (team == 0.0 && h4 < 0.5) ? vec3(0.08, 0.42, 0.80) : vec3(0.74, 0.08, 0.15);
        scarfColor = mix(scarfColor, vec3(0.92), step(0.5, fract(p.x * 6.0 + 0.25)) * 0.8);
        float scarfNeck = cBox(p - vec2(0.0, 0.585), vec2(0.20, 0.035), 0.02);
        float scarfUp = cBox(p - vec2(0.0, 0.98), vec2(0.36, 0.05), 0.02) + (1.0 - step(0.35, stand)) * 9.0;
        near = mix(near, shirt, occupied * (1.0 - smoothstep(-aa, aa, body)));
        near = mix(near, scarfColor, occupied * scarfOwner * (1.0 - smoothstep(-aa, aa, scarfNeck)));
        near = mix(near, headColor, occupied * (1.0 - smoothstep(-aa, aa, head)));
        near = mix(near, scarfColor, occupied * scarfOwner * (1.0 - smoothstep(-aa, aa, scarfUp)));
        // The row in front shades the lower part of each seat.
        near *= 0.8 + 0.2 * smoothstep(0.0, 0.32, f.y);

        vec3 stairs = vec3(0.40, 0.42, 0.44) * (0.75 + 0.25 * step(0.5, f.y));
        stairs = mix(stairs, vec3(0.80, 0.62, 0.10), step(f.y, 0.07));
        near = mix(near, stairs, aisle);
        near = mix(near, vec3(0.015, 0.018, 0.022), tunnel);
        near = mix(near, tifo, tifoMix * occupied);

        color = mix(near, average, distant);
        personShape = mix(1.0 - smoothstep(-aa, aa, min(body, head)), 0.35, distant);
      }

      // A packed crowd reads darker than any one shirt: fabric, shadow, gaps.
      color *= 0.52;

      // Fans' banners held up across the rows, in about one block in three:
      // team slogans at each home end, a mix along the sides.
      vec2 bannerGrid = vec2(28.0, 8.0);
      vec2 bannerCell = floor(seatUv / bannerGrid);
      vec2 inBlock = seatUv - bannerCell * bannerGrid;
      float bannerSeed = cHash(bannerCell + 91.7);
      vec2 bannerSize = vec2(13.0 + floor(cHash(bannerCell + 4.4) * 6.0), 2.2);
      vec2 bannerStart = vec2(2.0 + floor(cHash(bannerCell + 3.1) * (25.0 - bannerSize.x)), 1.5 + floor(cHash(bannerCell + 8.4) * 4.0));
      vec2 bannerLocal = (inBlock - bannerStart) / bannerSize;
      // The cloth ripples along its length.
      float ripple = sin(bannerLocal.x * 10.0 + crowdTime * 2.2 + bannerSeed * 40.0);
      bannerLocal.y += ripple * 0.035;
      float bannerIn = step(0.66, bannerSeed) * (1.0 - tifoMix)
        * smoothstep(0.0, 0.015, bannerLocal.x) * (1.0 - smoothstep(0.985, 1.0, bannerLocal.x))
        * smoothstep(0.0, 0.05, bannerLocal.y) * (1.0 - smoothstep(0.95, 1.0, bannerLocal.y));
      float bannerPick = floor(cHash(bannerCell + 5.5) * 4.0);
      float bannerSide = team < -0.5 ? 0.0 : (team > 0.5 ? 4.0 : step(0.5, cHash(bannerCell + 2.2)) * 4.0);
      vec2 atlasUv = vec2((bannerSide + bannerPick + clamp(bannerLocal.x, 0.002, 0.998)) / 8.0, clamp(bannerLocal.y, 0.03, 0.97));
      vec3 bannerColor = texture2D(crowdBanner, atlasUv).rgb * (0.62 + 0.1 * ripple);
      // Poles at each end, held by the fans below.
      float poleX = min(abs(bannerLocal.x), abs(bannerLocal.x - 1.0)) * bannerSize.x;
      float pole = step(0.66, bannerSeed) * (1.0 - tifoMix) * (1.0 - smoothstep(0.08, 0.08 + px, poleX))
        * step(-0.45, bannerLocal.y) * step(bannerLocal.y, 1.08);
      // Far away a banner is a few pixels: let it fade into the crowd rather than shimmer.
      float bannerFade = 1.0 - smoothstep(1.5, 3.5, px);
      color = mix(color, vec3(0.05, 0.05, 0.06), pole * bannerFade);
      color = mix(color, bannerColor, bannerIn * bannerFade);
      if (!gl_FrontFacing) color = vec3(0.22, 0.24, 0.27);
      diffuseColor.rgb *= color;

      float resolved = 1.0 - distant;
      float flash = step(0.992, h2) * step(0.86, fract(crowdTime * (0.3 + h1) + h3 * 10.0)) * resolved;
      float torch = step(0.975, h1) * crowdNight * 0.6 * resolved;
      totalEmissiveRadiance += vec3(1.0, 0.97, 0.9) * (flash * 1.4 + torch) * occupied * personShape
        * (1.0 - bannerIn * bannerFade) * (gl_FrontFacing ? 1.0 : 0.0);
      `,
    );
  };
  return material;
}

/** Fan flags waving in the stands: one instanced draw, cloth motion in the vertex shader. */
function buildCrowdFlags(rig: Rig) {
  const count = 1_400;
  const width = 22 / SHELL_SCALE;
  const height = 14 / SHELL_SCALE;
  const geometry = new THREE.PlaneGeometry(width, height, 6, 3);
  geometry.translate(width / 2, height * 1.4, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .82, side: THREE.DoubleSide });
  material.defines = { USE_UV: '' };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.crowdTime = rig.crowdUniforms.crowdTime;
    shader.uniforms.crowdWave = rig.crowdUniforms.crowdWave;
    shader.uniforms.flagWidth = { value: width };
    shader.vertexShader = `uniform float crowdTime;
uniform float crowdWave;
uniform float flagWidth;
${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 flagAt = instanceMatrix[3].xyz;
        float phase = flagAt.x * 3.1 + flagAt.z * 1.7;
        float along = clamp(position.x / flagWidth, 0.0, 1.0);
        float speed = 4.0 + crowdWave * 3.0;
        transformed.z += sin(crowdTime * speed + phase - along * 4.0) * along * flagWidth * (0.18 + crowdWave * 0.12);
        transformed.y += sin(crowdTime * 1.6 + phase) * flagWidth * 0.12 * (0.4 + crowdWave);
      #endif`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      if (abs(vUv.y - 0.5) < 0.13) diffuseColor.rgb = vec3(0.86);`,
    );
  };
  const flags = new THREE.InstancedMesh(geometry, material, count);
  const dummy = new THREE.Object3D();
  const azure = new THREE.Color('#1477c6');
  const ember = new THREE.Color('#c41a2c');
  const neutral = [new THREE.Color('#e9e9e9'), new THREE.Color('#e0a91c'), new THREE.Color('#1a1d24')];
  let placed = 0;
  for (let attempt = 0; attempt < count * 3 && placed < count; attempt += 1) {
    const tier = TIERS[attempt % TIERS.length];
    const angle = Math.random() * Math.PI * 2;
    const t = .08 + Math.random() * .84;
    const rx = tier.front[0] + (tier.back[0] - tier.front[0]) * t;
    const rz = tier.front[1] + (tier.back[1] - tier.front[1]) * t;
    const y = tier.front[2] + (tier.back[2] - tier.front[2]) * t;
    const x = Math.cos(angle) * rx;
    const endness = Math.abs(Math.cos(angle));
    // Flags cluster in the home ends, like real supporters' sections.
    if (endness < .8 && Math.random() < .7) continue;
    dummy.position.set(x, y, Math.sin(angle) * rz);
    dummy.rotation.set(0, -angle + Math.PI / 2 + (Math.random() - .5) * .8, 0);
    dummy.updateMatrix();
    flags.setMatrixAt(placed, dummy.matrix);
    const color = endness > .8 ? (x < 0 ? azure : ember) : neutral[placed % neutral.length];
    flags.setColorAt(placed, color);
    placed += 1;
  }
  flags.count = placed;
  flags.instanceMatrix.needsUpdate = true;
  if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
  rig.root.add(flags);
}

/** Lit facade texture: concrete panels, glazing bands and vertical fins. */
function createFacadeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  const glow = document.createElement('canvas');
  glow.width = 256;
  glow.height = 512;
  const glowContext = glow.getContext('2d');
  if (context && glowContext) {
    context.fillStyle = '#3a4650';
    context.fillRect(0, 0, 256, 512);
    glowContext.fillStyle = '#000';
    glowContext.fillRect(0, 0, 256, 512);
    for (let band = 0; band < 6; band += 1) {
      const y = 30 + band * 80;
      context.fillStyle = '#0e1820';
      context.fillRect(0, y, 256, 34);
      for (let pane = 0; pane < 8; pane += 1) {
        const lit = (band * 8 + pane * 5) % 7 < 4;
        glowContext.fillStyle = lit ? '#ffd9a0' : '#1b2a33';
        glowContext.fillRect(pane * 32 + 3, y + 4, 26, 26);
      }
    }
    context.fillStyle = '#56626c';
    for (const x of [0, 128]) context.fillRect(x, 0, 14, 512);
    context.fillStyle = 'rgba(255,255,255,.05)';
    for (let line = 0; line < 512; line += 16) context.fillRect(0, line, 256, 1);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  const emissive = new THREE.CanvasTexture(glow);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.wrapS = THREE.RepeatWrapping;
  return { map, emissive };
}

function buildBowl(rig: Rig) {
  const { root, surfaces } = rig;

  // Seating tiers.
  const crowd = crowdSurfaceMaterial(rig);
  for (const tier of TIERS) {
    const band = new THREE.Mesh(bandGeometry(tier.front, tier.back), crowd);
    band.receiveShadow = true;
    root.add(band);
  }
  buildCrowdFlags(rig);

  // Concourses between the tiers.
  const concourse = detailedStandard('#3a4b56', .78, .2, surfaces, 'concrete');
  addOvalDeck(root, 78, TIERS[1].front[0], TIERS[1].front[1], TIERS[0].back[0], TIERS[0].back[1], concourse);
  addOvalDeck(root, 170, TIERS[2].front[0], TIERS[2].front[1], TIERS[1].back[0], TIERS[1].back[1], concourse);

  // Facade: the stadium's outer skin, glazed and lit at night.
  const facadeTexture = createFacadeTexture();
  const facadeMaterial = new THREE.MeshStandardMaterial({
    map: facadeTexture.map, emissiveMap: facadeTexture.emissive, emissive: '#ffffff', emissiveIntensity: .15,
    roughness: .7, metalness: .25,
  });
  rig.nightGlow.push({ material: facadeMaterial, day: .08, night: .9 });
  const facadeTop = TIERS[2].back[2] + 18;
  root.add(new THREE.Mesh(wallGeometry(FACADE[0], FACADE[1], 0, facadeTop, 36 * SHELL_SCALE, true), facadeMaterial));
  // Back of the upper tier, seen from the concourse roof.
  root.add(new THREE.Mesh(wallGeometry(TIERS[2].back[0], TIERS[2].back[1], TIERS[2].back[2], facadeTop, 36 * SHELL_SCALE), concourse));
  addOvalDeck(root, facadeTop, FACADE[0] + 6, FACADE[1] + 6, TIERS[2].back[0], TIERS[2].back[1], concourse);

  // Roof ring cantilevered over the upper tier, edged with a band of lights.
  const roofSteel = detailedStandard('#4a5c66', .5, .55, surfaces, 'steel');
  addOvalDeck(root, ROOF_RING.y, ROOF_RING.outer[0], ROOF_RING.outer[1], ROOF_RING.inner[0], ROOF_RING.inner[1], roofSteel);
  const ringLights = new THREE.MeshStandardMaterial({ color: '#202a30', emissive: '#f4f8ff', emissiveIntensity: .4, roughness: .3 });
  rig.nightGlow.push({ material: ringLights, day: .3, night: 2.2 });
  root.add(new THREE.Mesh(wallGeometry(ROOF_RING.inner[0], ROOF_RING.inner[1], ROOF_RING.y - 5, ROOF_RING.y, 12 * SHELL_SCALE), ringLights));
  for (let index = 0; index < 40; index += 1) {
    const angle = (index / 40) * Math.PI * 2;
    const inner = new THREE.Vector3(Math.cos(angle) * ROOF_RING.inner[0], ROOF_RING.y, Math.sin(angle) * ROOF_RING.inner[1]);
    const outer = new THREE.Vector3(Math.cos(angle) * FACADE[0], facadeTop, Math.sin(angle) * FACADE[1]);
    addBeam(root, inner, outer, 2.2, roofSteel);
    addBeam(root, inner.clone().setY(ROOF_RING.y + 7), outer.clone().setY(ROOF_RING.y + 7), 1.4, roofSteel);
  }

  // Ground plaza and the outer masts.
  const outerSteel = detailedStandard('#425d6b', .48, .52, surfaces, 'steel');
  const outerDeck = detailedStandard('#304a58', .58, .42, surfaces, 'concrete');
  addOvalDeck(root, -11, 1_205, 985, 485, 375, detailedStandard('#223846', .9, .12, surfaces, 'asphalt'));
  addOvalDeck(root, 142, 1_135, 920, 1_070, 850, outerDeck);
  for (const y of [166, 226, 298, 375]) addLine(root, ellipsePoints(1_085, 875, y), 0x7ddcf0, y === 226 ? .58 : .3);

  const outerPylonMaterial = detailedStandard('#536c78', .46, .56, surfaces, 'steel');
  for (let index = 0; index < 20; index += 1) {
    const angle = (index / 20) * Math.PI * 2;
    const x = Math.cos(angle) * 1_085;
    const z = Math.sin(angle) * 875;
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 15, 420, 8), outerPylonMaterial);
    pylon.position.set(x, 210, z); pylon.castShadow = true; root.add(pylon);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(10, 1.7, 6, 12), outerDeck);
    collar.rotation.x = Math.PI / 2; collar.position.set(x, 330, z); root.add(collar);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(3.2, 8, 6), basic('#ff586d'));
    beacon.position.set(x, 424, z); root.add(beacon); beacon.material = rig.lampMaterial; rig.warningLamps.push(beacon);
  }
  return { outerSteel, outerDeck, outerPylonMaterial };
}

function buildRoofAndFloods(rig: Rig, roofMetal: THREE.Material) {
  const { root } = rig;
  addBox(root, '#263949', [1_190, 9, 17], [0, 322, 474], roofMetal);
  addBox(root, '#263949', [1_190, 9, 17], [0, 322, -474], roofMetal);
  addBox(root, '#263949', [17, 9, 950], [574, 322, 0], roofMetal);
  addBox(root, '#263949', [17, 9, 950], [-574, 322, 0], roofMetal);
  const archHeight = (z: number) => 322 + 42 * (1 - (z / 470) ** 2);
  for (const x of [-470, -235, 0, 235, 470]) {
    const arcPoints = Array.from({ length: 11 }, (_, index) => -470 + index * 94);
    for (let index = 0; index < arcPoints.length - 1; index += 1) {
      const z1 = arcPoints[index]; const z2 = arcPoints[index + 1];
      const start = new THREE.Vector3(x, archHeight(z1), z1);
      const end = new THREE.Vector3(x, archHeight(z2), z2);
      addBeam(root, start, end, 1.35, roofMetal);
      if (index % 2 === 0) addBeam(root, start, new THREE.Vector3(x, 322, z2), .55, roofMetal);
    }
    addBeam(root, new THREE.Vector3(x, 322, -470), new THREE.Vector3(x, 322, 470), .75, roofMetal);
  }
  for (const z of [-470, -235, 0, 235, 470]) {
    const y = archHeight(z);
    addBeam(root, new THREE.Vector3(-574, y, z), new THREE.Vector3(574, y, z), .7, roofMetal);
  }

  // Four floodlight rigs. Only these carry real spotlights; everything else
  // fakes its glow with emissive panels to keep the light count sane.
  const rigMetal = standard('#314455', .38, .72);
  for (const x of [-535, 535]) for (const z of [-435, 435]) {
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(4, 9, 320, 8), rigMetal);
    pylon.position.set(x, 176, z); pylon.castShadow = true; root.add(pylon);
    const head = new THREE.Group();
    head.position.set(x, 336, z);
    head.lookAt(0, 120, 0);
    root.add(head);
    const frame = addBox(head, '#1f3242', [34, 20, 5], [0, 0, 0], rigMetal);
    frame.castShadow = false;
    const lampMaterial = basic('#eaffff');
    rig.floodLamps.push(lampMaterial);
    for (let column = 0; column < 4; column += 1) for (let row = 0; row < 2; row += 1) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(6.6, 7.6, 1.6), lampMaterial);
      lamp.position.set(-12 + column * 8, -4 + row * 8, 3.2);
      head.add(lamp);
    }
  }
}

function buildDome(rig: Rig) {
  const { root } = rig;
  // No transmission here: a transmissive material makes three.js render the
  // whole scene a second time into a backdrop buffer every frame, which on an
  // integrated GPU roughly halves the frame rate. Plain alpha looks the same
  // at this scale and thickness.
  const domeMaterial = new THREE.MeshBasicMaterial({
    color: '#aeeeff', transparent: true, opacity: .06, side: THREE.BackSide, depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 36, 0, Math.PI * 2, 0, Math.PI / 2), domeMaterial);
  const domeRadiusX = 1_160; const domeRadiusZ = 940; const domeHeight = 720; const domeBase = -60;
  dome.scale.set(domeRadiusX, domeHeight, domeRadiusZ); dome.position.y = domeBase; root.add(dome);
  const domeRib = standard('#b9c8d2', .24, .92);
  for (let meridian = 0; meridian < 16; meridian += 1) {
    const azimuth = (meridian / 16) * Math.PI * 2;
    const points = Array.from({ length: 25 }, (_, index) => {
      const phi = (index / 24) * Math.PI / 2;
      return new THREE.Vector3(
        domeRadiusX * Math.sin(phi) * Math.cos(azimuth),
        domeBase + domeHeight * Math.cos(phi),
        domeRadiusZ * Math.sin(phi) * Math.sin(azimuth),
      );
    });
    for (let index = 0; index < points.length - 1; index += 1) addBeam(root, points[index], points[index + 1], .7, domeRib);
  }
  for (const y of [55, 150, 245, 335, 415, 485, 565, 630]) {
    const vertical = (y - domeBase) / domeHeight;
    const radius = Math.sqrt(Math.max(0, 1 - vertical * vertical));
    addLine(root, ellipsePoints(domeRadiusX * radius, domeRadiusZ * radius, y), 0x78c4df, .38);
  }
}

/* ------------------------------------------------------------------ */
/* Centrepiece, gates, flight deck and floodlights                     */
/* ------------------------------------------------------------------ */

/**
 * normalize() of a zero vector is NaN, and so is pow() of a base that rounds a
 * hair below zero. Merged geometry can interpolate a normal to zero, and one NaN
 * pixel is enough for bloom to black out the whole frame, so the hand-written
 * shaders use these instead.
 */
const SAFE_GLSL = `vec3 safeNormalize(vec3 v) { return v * inversesqrt(max(dot(v, v), 1e-12)); }`;

const ENERGY_VERTEX = `${SAFE_GLSL}
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vToCamera;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalWorld = safeNormalize(mat3(modelMatrix) * normal);
    vToCamera = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const NOISE_GLSL = `float eHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float eNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(eHash(i), eHash(i + vec2(1.0, 0.0)), u.x), mix(eHash(i + vec2(0.0, 1.0)), eHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }`;

/** Flowing plasma: drifting noise, travelling bands and a hot rim. Bright enough to bloom. */
function plasmaMaterial(time: { value: number }) {
  return new THREE.ShaderMaterial({
    uniforms: { time, deep: { value: new THREE.Color('#0b6f9c') }, bright: { value: new THREE.Color('#d9fbff') }, intensity: { value: 1.5 } },
    vertexShader: ENERGY_VERTEX,
    fragmentShader: `uniform float time;
      uniform vec3 deep;
      uniform vec3 bright;
      uniform float intensity;
      varying vec2 vUv;
      varying vec3 vNormalWorld;
      varying vec3 vToCamera;
      ${SAFE_GLSL}
      ${NOISE_GLSL}
      void main() {
        float flow = eNoise(vec2(vUv.x * 6.0, vUv.y * 9.0 - time * 1.4)) * 0.6
          + eNoise(vec2(vUv.x * 15.0 + time * 0.4, vUv.y * 26.0 - time * 3.1)) * 0.4;
        float bands = pow(max(0.0, 0.5 + 0.5 * sin(vUv.y * 70.0 - time * 5.0)), 8.0);
        float rim = pow(clamp(1.0 - abs(dot(safeNormalize(vNormalWorld), safeNormalize(vToCamera))), 0.0, 1.0), 1.5);
        vec3 color = mix(deep, bright, clamp(flow * 0.85 + bands * 0.4 + rim * 0.55, 0.0, 1.0));
        gl_FragColor = vec4(color * intensity, 1.0);
      }`,
  });
}

/** Additive light volume: bright at the source (uv.y = 1), fading along its length and at its silhouette. */
function lightVolumeMaterial(time: { value: number }, color: string, strength: number) {
  return new THREE.ShaderMaterial({
    uniforms: { time, color: { value: new THREE.Color(color) }, strength: { value: strength } },
    vertexShader: ENERGY_VERTEX,
    fragmentShader: `uniform float time;
      uniform vec3 color;
      uniform float strength;
      varying vec2 vUv;
      varying vec3 vNormalWorld;
      varying vec3 vToCamera;
      ${SAFE_GLSL}
      void main() {
        float facing = min(1.0, abs(dot(safeNormalize(vNormalWorld), safeNormalize(vToCamera))));
        float along = pow(clamp(vUv.y, 0.0, 1.0), 1.6);
        float shimmer = 0.85 + 0.15 * sin(vUv.y * 30.0 - time * 6.0);
        gl_FragColor = vec4(color * strength * along * facing * facing * shimmer, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function buildReactor(rig: Rig) {
  const { root, surfaces } = rig;
  const reactor = new THREE.Group();
  root.add(reactor);
  const hull = detailedStandard('#1f2a33', .32, .82, surfaces, 'steel');
  const trim = detailedStandard('#3b4c58', .26, .9, surfaces, 'steel');
  // Emissive accents: dark by day, they carry the reactor's light at night.
  const seam = new THREE.MeshBasicMaterial({ color: new THREE.Color(.4, 1.5, 2.1) });
  const reactorGlow = new THREE.MeshStandardMaterial({
    color: '#0d2f3d', emissive: '#4fe3ff', emissiveIntensity: 2.2, roughness: .2, metalness: .6,
  });
  rig.reactorCore = reactorGlow;

  // Stepped hexagonal plinth with glowing seams.
  for (const [radius, height, y] of [[34, 6, 3], [27, 6, 9], [21, 5, 14.5]] as const) {
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius + 2, height, 6), hull);
    tier.position.y = y; tier.castShadow = true; tier.receiveShadow = true; reactor.add(tier);
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(radius + .4, radius + .4, .8, 6, 1, true), seam);
    glow.position.y = y + height / 2 - .6; reactor.add(glow);
  }

  // Plasma column and crown: the light everything else in the bowl reflects.
  const plasma = plasmaMaterial(rig.energy.time);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 7.4, 152, 24, 8, true), plasma);
  column.position.y = 93; reactor.add(column);
  const crown = new THREE.Mesh(new THREE.SphereGeometry(9, 28, 18), plasma);
  crown.position.y = 182; reactor.add(crown);

  // Containment rings: dark frames with a glowing inner edge, counter-rotating.
  for (const [index, y] of [30, 62, 94, 126, 158].entries()) {
    // The group lies flat (its local Z is vertical), so spinning it about Z —
    // which the update loop does — turns the ring about the column.
    const ring = new THREE.Group();
    ring.position.y = y; ring.rotation.x = Math.PI / 2; reactor.add(ring); rig.reactorRings.push(ring);
    const radius = 15 - index * .8;
    const frame = new THREE.Mesh(new THREE.TorusGeometry(radius, 1.5, 10, 64), trim);
    frame.castShadow = true; ring.add(frame);
    ring.add(new THREE.Mesh(new THREE.TorusGeometry(radius - 1.5, .35, 6, 96), reactorGlow));
    for (let clamp = 0; clamp < 6; clamp += 1) {
      const angle = (clamp / 6) * Math.PI * 2;
      const block = addBox(ring, '#2b3943', [3.4, 3.4, 3.4], [Math.cos(angle) * radius, Math.sin(angle) * radius, 0], hull);
      block.rotation.z = angle;
    }
  }

  // Eight swept struts carrying the crown.
  for (let index = 0; index < 8; index += 1) {
    const angle = index * Math.PI / 4;
    addBeam(reactor, new THREE.Vector3(Math.cos(angle) * 24, 17, Math.sin(angle) * 24),
      new THREE.Vector3(Math.cos(angle) * 9, 172, Math.sin(angle) * 9), 1.2, trim);
  }
  // Service decks with lit rims.
  for (const y of [72, 116]) {
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 2.2, 24), hull);
    deck.position.y = y; reactor.add(deck);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(20, .4, 6, 64), seam);
    rim.rotation.x = Math.PI / 2; rim.position.y = y + 1.2; reactor.add(rim);
  }

  // A light pillar from the crown to the dome, and a glow pooled on the deck.
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 4.5, 420, 20, 1, true), lightVolumeMaterial(rig.energy.time, '#8ff2ff', .9));
  pillar.position.y = 182 + 210; pillar.rotation.x = Math.PI; reactor.add(pillar);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(95, 64), new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color('#5fe6ff') } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 color; varying vec2 vUv;
      void main() { float d = length(vUv - 0.5) * 2.0; gl_FragColor = vec4(color * pow(max(0.0, 1.0 - d), 2.2) * 0.9, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  pool.rotation.x = -Math.PI / 2; pool.position.y = .6; root.add(pool);

  rig.rotators.push({ object: reactor, axis: 'y', speed: .035 });
}

function buildGate(rig: Rig, radius: number, frameMaterial: THREE.Material, lightMaterial: THREE.Material, dimLight: THREE.Material) {
  const gate = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.TorusGeometry(radius, 1.05, 10, 96), frameMaterial);
  frame.castShadow = true; gate.add(frame);
  gate.add(new THREE.Mesh(new THREE.TorusGeometry(radius - 1.3, .3, 6, 128), lightMaterial));
  gate.add(new THREE.Mesh(new THREE.TorusGeometry(radius + 2, .16, 4, 128), dimLight));
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    const clamp = addBox(gate, '#1b2630', [3.6, 5.2, 3.6], [Math.cos(angle) * radius, Math.sin(angle) * radius, 0], frameMaterial);
    clamp.rotation.z = angle;
    // A small marker lamp on every other clamp.
    if (index % 2 === 0) addBox(gate, '#ffffff', [1.2, 1.2, 4], [Math.cos(angle) * (radius + 2.8), Math.sin(angle) * (radius + 2.8), 0], lightMaterial);
  }
  return gate;
}

function buildGates(rig: Rig) {
  const frame = new THREE.MeshStandardMaterial({ color: '#18222b', roughness: .26, metalness: .9 });
  const light = new THREE.MeshBasicMaterial({ color: new THREE.Color(.35, 1.35, 2.0) });
  const dim = new THREE.MeshBasicMaterial({ color: new THREE.Color(.2, .6, .85) });
  const gateSpots: { position: [number, number, number]; axis: 'x' | 'z'; radius: number }[] = [
    { position: [-250, 78, 0], axis: 'x', radius: 44 },
    { position: [250, 78, 0], axis: 'x', radius: 44 },
    { position: [-170, 168, 0], axis: 'x', radius: 52 },
    { position: [170, 168, 0], axis: 'x', radius: 52 },
    { position: [0, 246, -240], axis: 'z', radius: 48 },
    { position: [0, 246, 240], axis: 'z', radius: 48 },
  ];
  for (const spot of gateSpots) {
    const gate = buildGate(rig, spot.radius, frame, light, dim);
    gate.position.set(...spot.position);
    if (spot.axis === 'x') gate.rotation.y = Math.PI / 2;
    rig.root.add(gate);
    rig.gates.push(gate);
  }
}

/** Painted flight deck: panels, the Skyforge emblem, team end zones, hazard edging. */
function createDeckTextures() {
  const width = 2048;
  const deckX = AUTHORED.halfWidth * 2 + 25;
  const deckZ = AUTHORED.halfDepth * 2 + 25;
  const height = Math.round(width * deckZ / deckX);
  const paint = document.createElement('canvas'); paint.width = width; paint.height = height;
  const glow = document.createElement('canvas'); glow.width = width / 2; glow.height = Math.round(height / 2);
  const p = paint.getContext('2d');
  const g = glow.getContext('2d');
  if (!p || !g) throw new Error('deck canvas');
  const px = (x: number) => (x / deckX + .5) * width;
  const pz = (z: number) => (z / deckZ + .5) * height;
  const cx = width / 2; const cz = height / 2;
  g.scale(.5, .5);

  // Base plate with tonal variation, then panel seams.
  p.fillStyle = '#141a20'; p.fillRect(0, 0, width, height);
  let seed = 3;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const panel = 64;
  for (let x = 0; x < width; x += panel) for (let y = 0; y < height; y += panel) {
    const tone = 18 + Math.floor(random() * 7);
    p.fillStyle = `rgb(${tone},${tone + 5},${tone + 10})`; p.fillRect(x, y, panel, panel);
  }
  for (let speck = 0; speck < 9000; speck += 1) {
    p.fillStyle = random() > .5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.12)';
    p.fillRect(random() * width, random() * height, 1 + random() * 3, 1 + random() * 2);
  }
  p.strokeStyle = 'rgba(0,0,0,.55)'; p.lineWidth = 2;
  for (let x = 0; x <= width; x += panel) { p.beginPath(); p.moveTo(x, 0); p.lineTo(x, height); p.stroke(); }
  for (let y = 0; y <= height; y += panel) { p.beginPath(); p.moveTo(0, y); p.lineTo(width, y); p.stroke(); }
  p.strokeStyle = 'rgba(255,255,255,.05)'; p.lineWidth = 1;
  for (let x = 2; x <= width; x += panel) { p.beginPath(); p.moveTo(x, 0); p.lineTo(x, height); p.stroke(); }

  // Team end zones with inward chevrons.
  for (const [side, color, name] of [[-1, '#2aa7e3', 'BLUE'], [1, '#e2364c', 'RED']] as const) {
    const edge = side < 0 ? 0 : width;
    const inner = px(side * 300);
    const zone = p.createLinearGradient(edge, 0, inner, 0);
    zone.addColorStop(0, `${color}55`); zone.addColorStop(1, `${color}00`);
    p.fillStyle = zone; p.fillRect(Math.min(edge, inner), 0, Math.abs(inner - edge), height);
    for (let index = 0; index < 3; index += 1) {
      const tip = px(side * (300 - index * 46));
      const draw = (ctx: CanvasRenderingContext2D, alpha: number) => {
        ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = 16;
        ctx.beginPath(); ctx.moveTo(tip + side * 70, cz - 120); ctx.lineTo(tip, cz); ctx.lineTo(tip + side * 70, cz + 120); ctx.stroke();
        ctx.globalAlpha = 1;
      };
      draw(p, .55); draw(g, .9 - index * .25);
    }
    p.save(); p.translate(px(side * 440), cz); p.rotate(side * Math.PI / 2);
    p.fillStyle = 'rgba(235,240,245,.18)'; p.font = '800 120px Rajdhani, Arial Black, sans-serif'; p.textAlign = 'center';
    p.fillText(name, 0, 40); p.restore();
  }

  // Centre line.
  p.setLineDash([42, 30]); p.strokeStyle = 'rgba(230,240,245,.28)'; p.lineWidth = 6;
  p.beginPath(); p.moveTo(px(-300), cz); p.lineTo(px(300), cz); p.stroke(); p.setLineDash([]);

  // Centre emblem: rings, ticks, lettering, and a winged chevron.
  for (const [radius, widthLine, alpha] of [[300, 10, .5], [250, 3, .35], [180, 6, .45]] as const) {
    p.strokeStyle = `rgba(110,215,255,${alpha})`; p.lineWidth = widthLine;
    p.beginPath(); p.arc(cx, cz, radius, 0, Math.PI * 2); p.stroke();
    g.strokeStyle = '#6fdcff'; g.globalAlpha = alpha + .2; g.lineWidth = widthLine;
    g.beginPath(); g.arc(cx, cz, radius, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
  }
  for (let tick = 0; tick < 72; tick += 1) {
    const angle = (tick / 72) * Math.PI * 2;
    const long = tick % 6 === 0;
    p.strokeStyle = 'rgba(160,225,255,.4)'; p.lineWidth = long ? 5 : 2;
    p.beginPath(); p.moveTo(cx + Math.cos(angle) * 254, cz + Math.sin(angle) * 254);
    p.lineTo(cx + Math.cos(angle) * (long ? 290 : 275), cz + Math.sin(angle) * (long ? 290 : 275)); p.stroke();
  }
  const motto = 'SKYFORGE  ·  AEROSPACE COMBAT LEAGUE  ·  ';
  p.fillStyle = 'rgba(200,235,250,.55)'; p.font = '700 30px Rajdhani, Arial, sans-serif'; p.textAlign = 'center';
  for (let index = 0; index < motto.length * 2; index += 1) {
    const angle = (index / (motto.length * 2)) * Math.PI * 2 - Math.PI / 2;
    p.save(); p.translate(cx + Math.cos(angle) * 214, cz + Math.sin(angle) * 214); p.rotate(angle + Math.PI / 2);
    p.fillText(motto[index % motto.length], 0, 0); p.restore();
  }
  p.fillStyle = 'rgba(120,220,255,.55)';
  p.beginPath(); p.moveTo(cx, cz - 110); p.lineTo(cx + 120, cz + 40); p.lineTo(cx + 40, cz + 20); p.lineTo(cx, cz + 80);
  p.lineTo(cx - 40, cz + 20); p.lineTo(cx - 120, cz + 40); p.closePath(); p.fill();

  // Hazard edging along the barrier line, with a row of runway-style lights.
  const inset = (12.5 / deckX) * width;
  p.save(); p.beginPath(); p.rect(inset, inset, width - inset * 2, height - inset * 2);
  p.rect(inset + 22, inset + 22, width - (inset + 22) * 2, height - (inset + 22) * 2); p.clip('evenodd');
  for (let stripe = -height; stripe < width + height; stripe += 40) {
    p.fillStyle = (stripe / 40) % 2 ? '#c9a227' : '#16181a';
    p.beginPath(); p.moveTo(stripe, 0); p.lineTo(stripe + 20, 0); p.lineTo(stripe + 20 - height, height); p.lineTo(stripe - height, height); p.closePath(); p.fill();
  }
  p.restore();
  g.fillStyle = '#9fe9ff';
  for (let x = inset + 50; x < width - inset; x += 56) for (const y of [inset + 38, height - inset - 38]) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
  for (let y = inset + 50; y < height - inset; y += 56) for (const x of [inset + 38, width - inset - 38]) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
  void pz;

  const map = new THREE.CanvasTexture(paint); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const emissive = new THREE.CanvasTexture(glow); emissive.colorSpace = THREE.SRGBColorSpace; emissive.anisotropy = 4;
  return { map, emissive };
}

function buildGroundPlane(rig: Rig) {
  const { root, surfaces } = rig;
  const deck = createDeckTextures();
  // Fine grain tiled over the painted deck, so close passes still show texture.
  const grain = surfaces.asphalt.roughness.clone();
  grain.repeat.set(70, 54); grain.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({
    map: deck.map, emissiveMap: deck.emissive, emissive: '#ffffff', emissiveIntensity: .5,
    roughness: .48, roughnessMap: grain, metalness: .45,
  });
  rig.nightGlow.push({ material, day: .35, night: 1.8 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(AUTHORED.halfWidth * 2 + 25, AUTHORED.halfDepth * 2 + 25), material);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1;
  floor.receiveShadow = true;
  root.add(floor);
}

/**
 * Floodlight banks ringing the roof, aimed at the pitch, and the light shafts
 * they throw through the haze after dark.
 */
function buildFloodlightRig(rig: Rig) {
  const count = 56;
  const housingGeometry = new THREE.BoxGeometry(16, 7, 6);
  const faceGeometry = new THREE.BoxGeometry(14.4, 5.4, .8);
  const housings = new THREE.InstancedMesh(housingGeometry, new THREE.MeshStandardMaterial({ color: '#171f26', roughness: .4, metalness: .8 }), count);
  const faceMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 1.25, 1.3) });
  const faces = new THREE.InstancedMesh(faceGeometry, faceMaterial, count);
  rig.floodLamps.push(faceMaterial);
  const dummy = new THREE.Object3D();
  const target = new THREE.Vector3();
  const shafts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const x = Math.cos(angle) * (ROOF_RING.inner[0] + 6);
    const z = Math.sin(angle) * (ROOF_RING.inner[1] + 6);
    const y = ROOF_RING.y - 9;
    target.set(x * .32, 0, z * .32);
    dummy.position.set(x, y, z); dummy.lookAt(target); dummy.updateMatrix();
    housings.setMatrixAt(index, dummy.matrix);
    dummy.translateZ(3.4); dummy.updateMatrix();
    faces.setMatrixAt(index, dummy.matrix);
    // Every fourth lamp throws a visible shaft.
    if (index % 4 === 0) {
      const from = new THREE.Vector3(x, y, z);
      const direction = new THREE.Vector3().subVectors(from, target);
      const length = direction.length();
      const cone = new THREE.ConeGeometry(52, length, 28, 1, true);
      // Apex (+Y) at the lamp, base on the deck.
      cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()));
      cone.translate((from.x + target.x) / 2, (from.y + target.y) / 2, (from.z + target.z) / 2);
      shafts.push(cone);
    }
  }
  housings.instanceMatrix.needsUpdate = true;
  faces.instanceMatrix.needsUpdate = true;
  rig.root.add(housings, faces);
  const shaftMaterial = lightVolumeMaterial(rig.energy.time, '#dcebff', 0);
  const beams = new THREE.Mesh(mergeGeometries(shafts, false)!, shaftMaterial);
  beams.frustumCulled = false;
  rig.root.add(beams);
  rig.shafts = shaftMaterial;
}

function buildLoungesAndDecks(rig: Rig) {
  const { root, surfaces } = rig;
  const deckSteel = detailedStandard('#3b566a', .5, .5, surfaces, 'steel');
  const glass = new THREE.MeshPhysicalMaterial({
    color: '#16262f', roughness: .06, metalness: .25, transparent: true, opacity: .62, side: THREE.DoubleSide,
  });
  const loungeGlow = new THREE.MeshStandardMaterial({
    color: '#1b3444', emissive: '#ffd9a8', emissiveIntensity: .35, roughness: .4, metalness: .3,
  });
  rig.nightGlow.push({ material: loungeGlow, day: .22, night: 1.3 });
  const concourseTop = 85;

  // Glass-fronted VIP boxes on the first concourse, backed against the middle tier.
  for (const side of [-1, 1]) {
    const z = side * 519;
    addBox(root, '#19303f', [124, 26, 10], [0, concourseTop + 13, z + side * 3], loungeGlow);
    const front = new THREE.Mesh(new THREE.BoxGeometry(120, 24, 1.2), glass);
    front.position.set(0, concourseTop + 13, z - side * 3); root.add(front);
    addBox(root, side < 0 ? '#4cc9f0' : '#ef334b', [118, 1.4, 1.2], [0, concourseTop + 26, z - side * 3.6], basic(side < 0 ? '#4cc9f0' : '#ef334b'));
  }
  // Broadcast booths above the VIP boxes: glazed commentary rooms with an
  // ON-AIR lamp and a camera on a boom reaching out over the bowl.
  const boomMaterial = detailedStandard('#4a6676', .42, .6, surfaces, 'steel');
  const onAir = basic('#ff3b3b');
  for (const side of [-1, 1]) {
    const z = side * 528;
    const y = concourseTop + 44;
    addBox(root, '#152938', [72, 18, 14], [0, y, z + side * 4], loungeGlow);
    const front = new THREE.Mesh(new THREE.BoxGeometry(68, 13, 1.2), glass);
    front.position.set(0, y + 1, z - side * 3.4); root.add(front);
    addBox(root, '#2b4557', [76, 2, 18], [0, y - 10, z + side * 4], deckSteel);
    addBox(root, '#ff3b3b', [10, 3, 1], [-28, y + 11, z - side * 3.6], onAir);
    for (const x of [-46, 46]) {
      addBeam(root, new THREE.Vector3(x, y - 2, z + side * 2), new THREE.Vector3(x + Math.sign(x) * 4, y - 4, z - side * 34), 1.4, boomMaterial);
      addBox(root, '#20313c', [6, 5, 9], [x + Math.sign(x) * 4, y - 6, z - side * 36], boomMaterial);
      addBox(root, '#9fe8ff', [3, 3, .6], [x + Math.sign(x) * 4, y - 6, z - side * 40.6], basic('#9fe8ff'));
    }
  }
  for (const side of [-1, 1]) {
    const x = side * 657;
    addBox(root, '#19303f', [10, 24, 156], [x + side * 3, concourseTop + 12, 0], loungeGlow);
    const front = new THREE.Mesh(new THREE.BoxGeometry(1.2, 22, 152), glass);
    front.position.set(x - side * 3, concourseTop + 12, 0); root.add(front);
  }

  // Observation pods cantilevered over the back of the middle tier.
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2 + Math.PI / 8;
    const pod = new THREE.Group();
    pod.position.set(Math.cos(angle) * 786, 190, Math.sin(angle) * 628);
    pod.rotation.y = -angle - Math.PI / 2;
    root.add(pod);
    addBox(pod, '#2b4557', [30, 4, 22], [0, 0, 0], deckSteel);
    addBox(pod, '#1b3141', [30, 7, 3], [0, 5, -10], loungeGlow);
    const window = new THREE.Mesh(new THREE.BoxGeometry(27, 11, 1.2), glass);
    window.position.set(0, 7, 10.4); pod.add(window);
    addBox(pod, '#4a6676', [30, 1, 1], [0, 12, 11], deckSteel);
    for (const rail of [-13, 0, 13]) addBox(pod, '#4a6676', [1, 11, 1], [rail, 7, 11], deckSteel);
    addBeam(pod, new THREE.Vector3(0, -1, -8), new THREE.Vector3(0, -14, -26), 2, deckSteel);
    const strobe = new THREE.Mesh(new THREE.SphereGeometry(1.8, 8, 6), basic('#ff7a4d'));
    strobe.position.set(0, -3, 11); pod.add(strobe);
    strobe.material = rig.lampMaterial; rig.warningLamps.push(strobe);
  }
}

/** Woven team banner: gradient field, chevron crest, vertical name and a fringe. */
function createBannerTexture(team: 'azure' | 'ember') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 640;
  const context = canvas.getContext('2d');
  if (context) {
    const [deep, bright] = team === 'azure' ? ['#06315a', '#1c8fd6'] : ['#4a0710', '#d22a3f'];
    const field = context.createLinearGradient(0, 0, 0, 640);
    field.addColorStop(0, deep);
    field.addColorStop(.5, bright);
    field.addColorStop(1, deep);
    context.fillStyle = field;
    context.fillRect(0, 0, 256, 640);
    context.fillStyle = '#f2f2ea';
    context.fillRect(18, 0, 8, 600);
    context.fillRect(230, 0, 8, 600);
    // Chevron crest.
    context.beginPath();
    context.moveTo(128, 70); context.lineTo(206, 150); context.lineTo(206, 196);
    context.lineTo(128, 128); context.lineTo(50, 196); context.lineTo(50, 150); context.closePath();
    context.fill();
    context.beginPath();
    context.moveTo(128, 150); context.lineTo(186, 210); context.lineTo(186, 240);
    context.lineTo(128, 196); context.lineTo(70, 240); context.lineTo(70, 210); context.closePath();
    context.fill();
    // Vertical team name.
    context.save();
    context.translate(140, 560);
    context.rotate(-Math.PI / 2);
    context.font = '800 74px Rajdhani, Arial Black, sans-serif';
    context.fillText(team === 'azure' ? 'BLUE' : 'RED', 0, 0);
    context.restore();
    // Fringe.
    for (let tassel = 0; tassel < 20; tassel += 1) {
      context.fillStyle = tassel % 2 ? '#f2d27a' : '#d9b55c';
      context.fillRect(6 + tassel * 12.5, 600, 7, 40);
    }
    // Weave.
    context.globalAlpha = .06;
    context.fillStyle = '#000';
    for (let line = 0; line < 640; line += 3) context.fillRect(0, line, 256, 1);
    context.globalAlpha = 1;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function buildScreensAndBanners(rig: Rig, scoreboard: ScreenHandle) {
  const { root } = rig;
  const frameMaterial = standard('#1d3142', .32, .65);
  rig.screens.push({ material: scoreboard.material, day: .86, night: 1 });

  // Two giant end scoreboards hung from the roof truss.
  for (const side of [-1, 1]) {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(190, 48), scoreboard.material);
    screen.position.set(0, 258, side * 449);
    if (side < 0) screen.rotation.y = Math.PI;
    root.add(screen);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(202, 56, 4), frameMaterial);
    frame.position.set(0, 258, side * 445);
    root.add(frame);
  }
  // Four corner broadcast screens angled into the bowl.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(112, 30), scoreboard.material);
    screen.position.set(sx * 392, 196, sz * 330);
    screen.lookAt(0, 150, 0);
    root.add(screen);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(120, 36, 3.4), frameMaterial);
    frame.position.copy(screen.position);
    frame.quaternion.copy(screen.quaternion);
    frame.translateZ(-2.4);
    root.add(frame);
  }

  // Team drapes hung from the inner edge of the roof ring. The vertex shader
  // ripples the cloth and bends the normal with it, so folds catch the light.
  const bannerHeight = 100;
  const bannerWidth = 40;
  const bannerUniforms = rig.bannerUniforms;
  const makeBanner = (team: 'azure' | 'ember') => {
    const material = new THREE.MeshStandardMaterial({
      map: createBannerTexture(team), roughness: .92, metalness: 0, side: THREE.DoubleSide,
      emissive: '#ffffff', emissiveIntensity: .02,
    });
    material.emissiveMap = material.map;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.bannerTime = bannerUniforms.bannerTime;
      shader.uniforms.bannerGust = bannerUniforms.bannerGust;
      shader.uniforms.bannerHeight = { value: bannerHeight };
      shader.uniforms.bannerWidth = { value: bannerWidth };
      shader.vertexShader = `uniform float bannerTime;
uniform float bannerGust;
uniform float bannerHeight;
uniform float bannerWidth;
float bannerWave(vec2 at) {
  float hang = clamp((bannerHeight * 0.5 - at.y) / bannerHeight, 0.0, 1.0);
  return (sin(at.y * 0.11 - bannerTime * 1.7 + at.x * 0.2) * 0.7
    + sin(at.y * 0.05 + bannerTime * 0.9 + at.x * 0.09) * 0.5) * hang * (2.2 + bannerGust * 4.0);
}
${shader.vertexShader}`
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          // Cloth coordinates come from uv, not position, so the banners still
          // wave after being merged into one shell-space mesh.
          vec2 bannerAt = vec2((uv.x - 0.5) * bannerWidth, (uv.y - 0.5) * bannerHeight);
          float bannerDx = bannerWave(bannerAt + vec2(0.5, 0.0)) - bannerWave(bannerAt - vec2(0.5, 0.0));
          float bannerDy = bannerWave(bannerAt + vec2(0.0, 0.5)) - bannerWave(bannerAt - vec2(0.0, 0.5));
          vec3 bannerUp = vec3(0.0, 1.0, 0.0);
          vec3 bannerSide = cross(bannerUp, normal);
          bannerSide *= inversesqrt(max(dot(bannerSide, bannerSide), 1e-12));
          objectNormal = normal - bannerSide * bannerDx - bannerUp * bannerDy;
          objectNormal *= inversesqrt(max(dot(objectNormal, objectNormal), 1e-12));`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          transformed += normal * bannerWave(bannerAt);`,
        );
    };
    rig.nightGlow.push({ material, day: .02, night: .22 });
    return material;
  };
  const azureBanner = makeBanner('azure');
  const emberBanner = makeBanner('ember');
  const railMaterial = standard('#6e8794', .4, .6);
  for (let index = 0; index < 20; index += 1) {
    const angle = (index / 20) * Math.PI * 2;
    const x = Math.cos(angle) * (ROOF_RING.inner[0] + 8);
    const z = Math.sin(angle) * (ROOF_RING.inner[1] + 8);
    const team = Math.abs(Math.cos(angle)) > .5 ? (x < 0 ? 'azure' : 'ember') : (index % 2 ? 'ember' : 'azure');
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(bannerWidth, bannerHeight, 10, 28), team === 'azure' ? azureBanner : emberBanner);
    banner.position.set(x, ROOF_RING.y - 4 - bannerHeight / 2, z);
    banner.rotation.y = -angle - Math.PI / 2;
    root.add(banner);
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 44, 6), railMaterial);
    rail.position.set(x, ROOF_RING.y - 3, z);
    rail.rotation.set(0, -angle - Math.PI / 2, Math.PI / 2);
    root.add(rail);
  }

  // Continuous LED ribbon boards on the pitch wall and both tier fascias.
  const advertPair = [createAdvert('#45c9eb'), createAdvert('#ef5266')];
  for (const advert of advertPair) {
    if (advert.material.map) advert.material.map.wrapS = THREE.RepeatWrapping;
    rig.adverts.push(advert);
    rig.screens.push({ material: advert.material, day: .78, night: 1 });
  }
  const ribbons: [number, number, number, number][] = [
    [TIERS[0].front[0], TIERS[0].front[1], 0, TIERS[0].front[2]],
    [TIERS[1].front[0], TIERS[1].front[1], 85, TIERS[1].front[2]],
    [TIERS[2].front[0], TIERS[2].front[1], 177, TIERS[2].front[2]],
  ];
  for (const [index, [rx, rz, bottom, top]] of ribbons.entries()) {
    const height = (top - bottom) * SHELL_SCALE;
    root.add(new THREE.Mesh(wallGeometry(rx - .4, rz - .4, bottom, top, height * 6), advertPair[index % 2].material));
  }

  const holoMaterial = new THREE.MeshBasicMaterial({
    color: '#86e8ff', transparent: true, opacity: .26, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2;
    const holo = new THREE.Mesh(new THREE.TorusGeometry(26, 1.1, 6, 40), holoMaterial);
    holo.position.set(Math.cos(angle) * 640, 360 + (index % 3) * 36, Math.sin(angle) * 515);
    holo.rotation.x = Math.PI / 2.4;
    root.add(holo);
    rig.holograms.push(holo);
  }

  // Holographic advertisements: translucent panels hovering over the stands,
  // turned to face the pitch, showing the same rolling sponsor feed as the
  // LED ribbons (shared textures, so no extra repaints).
  const frameGlow = new THREE.MeshBasicMaterial({ color: '#8ff2ff', transparent: true, opacity: .55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  for (let index = 0; index < 4; index += 1) {
    const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
    const panel = new THREE.Group();
    panel.position.set(Math.cos(angle) * 700, 300, Math.sin(angle) * 560);
    panel.lookAt(0, 300, 0);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(132, 22), new THREE.MeshBasicMaterial({
      map: advertPair[index % 2].material.map, transparent: true, opacity: .72, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    panel.add(screen);
    for (const y of [-12.5, 12.5]) { const edge = new THREE.Mesh(new THREE.BoxGeometry(136, .7, .7), frameGlow); edge.position.y = y; panel.add(edge); }
    // Emitter pylon underneath, projecting the image.
    const emitter = new THREE.Mesh(new THREE.ConeGeometry(9, 26, 10, 1, true), frameGlow);
    emitter.position.y = -26; emitter.rotation.x = Math.PI; panel.add(emitter);
    root.add(panel);
    rig.oscillators.push({ object: panel, axis: 'y', home: 300, amplitude: 5, speed: .4, phase: index * 1.3 });
  }
}

function buildCombatLevels(rig: Rig) {
  const { root, surfaces } = rig;
  const bridgeMaterial = detailedStandard('#405b69', .46, .54, surfaces, 'steel');
  const bridgeGlow = basic('#79ddf2');

  for (const side of [-1, 1]) {
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(585, 5, 20), bridgeMaterial);
    bridge.position.set(0, 86, side * 292); bridge.castShadow = true; bridge.receiveShadow = true; root.add(bridge);
    addBox(root, '#8cecff', [570, .8, .8], [0, 89, side * 282], bridgeGlow);
    for (const x of [-270, -180, 180, 270]) {
      const pylon = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.2, 72, 8), bridgeMaterial);
      pylon.position.set(x, 48, side * 292); pylon.castShadow = true; root.add(pylon);
    }
  }
  for (const side of [-1, 1]) {
    const serviceDeck = new THREE.Mesh(new THREE.BoxGeometry(28, 5, 176), bridgeMaterial);
    serviceDeck.position.set(side * 325, 126, 0); root.add(serviceDeck);
    for (const z of [-64, 64]) {
      const support = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.2, 118, 8), bridgeMaterial);
      support.position.set(side * 325, 63, z); root.add(support);
    }
    const tunnel = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 9, 82, 12, 1, true, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: '#213949', roughness: .35, metalness: .7, side: THREE.DoubleSide }),
    );
    tunnel.rotation.z = Math.PI / 2; tunnel.position.set(side * 325, 139, 0); root.add(tunnel);
  }

  // Floating maintenance pads: extra high-altitude cover that bobs in place.
  const padMaterial = detailedStandard('#3c5464', .5, .48, surfaces, 'steel');
  const thrusterMaterial = new THREE.MeshBasicMaterial({
    color: '#7fe9ff', transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  // Deliberately nothing near x=z=0: the reactor column stays clear.
  const padSpots: [number, number, number][] = [
    [-300, 212, -206], [300, 212, 206], [-130, 258, 250], [130, 258, -250],
  ];
  for (const [index, spot] of padSpots.entries()) {
    const pad = new THREE.Group();
    pad.position.set(...spot);
    root.add(pad);
    addBox(pad, '#2b4152', [56, 4, 40], [0, 0, 0], padMaterial);
    addBox(pad, '#45606f', [56, 1.4, 1.4], [0, 3, 20], padMaterial);
    addBox(pad, '#45606f', [56, 1.4, 1.4], [0, 3, -20], padMaterial);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const thruster = new THREE.Mesh(new THREE.ConeGeometry(5, 11, 10), thrusterMaterial);
      thruster.rotation.x = Math.PI;
      thruster.position.set(sx * 22, -7, sz * 15);
      pad.add(thruster);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.4, 16, 6), padMaterial);
    mast.position.y = 10; pad.add(mast);
    const strobe = new THREE.Mesh(new THREE.SphereGeometry(1.9, 8, 6), basic('#ff6a52'));
    strobe.position.y = 19; pad.add(strobe);
    strobe.material = rig.lampMaterial; rig.warningLamps.push(strobe);
    rig.floaters.push({ object: pad, home: spot[1], phase: index * 1.37 });
  }
}

function buildIndustrialYard(rig: Rig, outerPylonMaterial: THREE.Material) {
  const { root, surfaces } = rig;
  const apronMetal = detailedStandard('#647c87', .48, .5, surfaces, 'steel');
  const industrial = detailedStandard('#536b77', .48, .52, surfaces, 'steel');
  const tankMaterial = detailedStandard('#667d87', .4, .5, surfaces, 'steel');
  const windowGlow = new THREE.MeshStandardMaterial({
    color: '#13303f', emissive: '#8ad9f0', emissiveIntensity: .3, roughness: .35, metalness: .3,
  });
  rig.nightGlow.push({ material: windowGlow, day: .2, night: 1.2 });

  // Oversized hangars and fuel silos beyond the stands.
  for (const side of [-1, 1]) {
    for (const z of [-255, 0, 255]) {
      const hangar = new THREE.Group(); hangar.position.set(side * 770, 0, z); root.add(hangar);
      addBox(hangar, '#263e4d', [156, 32, 104], [0, 16, 0], apronMetal);
      addBox(hangar, '#627b88', [168, 7, 112], [0, 35.5, 0], outerPylonMaterial);
      addBox(hangar, '#13303f', [4, 21, 68], [-side * 78, 12, 0], windowGlow);
      const silo = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 58, 12), apronMetal);
      silo.position.set(side * 866, 29, z + 55); silo.castShadow = true; root.add(silo);
      const band = new THREE.Mesh(new THREE.TorusGeometry(20, 1.2, 6, 16), basic(side < 0 ? '#4cc9f0' : '#ef5266'));
      band.rotation.x = Math.PI / 2; band.position.set(side * 866, 31, z + 55); root.add(band);
    }
    const crane = new THREE.Group(); crane.position.set(side * 910, 0, 0); root.add(crane);
    addBox(crane, '#344c5b', [20, 150, 20], [0, 75, 0], outerPylonMaterial);
    addBox(crane, '#536d7a', [168, 9, 10], [-side * 62, 149, 0], outerPylonMaterial);
    addBeam(crane, new THREE.Vector3(-side * 136, 146, 0), new THREE.Vector3(0, 90, 0), 2.4, outerPylonMaterial);
    // A trolley slides along the jib so the yard never looks frozen.
    const trolley = addBox(crane, '#7e98a4', [14, 7, 12], [-side * 62, 141, 0], outerPylonMaterial);
    rig.oscillators.push({ object: trolley, axis: 'x', home: -side * 62, amplitude: 56, speed: .22, phase: side > 0 ? 0 : 1.9 });
    const hook = addBox(crane, '#b9ccd3', [4, 22, 4], [-side * 62, 120, 0], outerPylonMaterial);
    rig.oscillators.push({ object: hook, axis: 'y', home: 120, amplitude: 14, speed: .31, phase: side > 0 ? .6 : 2.4 });

    const dish = new THREE.Mesh(new THREE.SphereGeometry(20, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), outerPylonMaterial);
    dish.position.set(side * 1_000, 240, 320); dish.rotation.x = -Math.PI / 3; root.add(dish);
    rig.rotators.push({ object: dish, axis: 'y', speed: side > 0 ? .11 : -.11 });
    const dishMast = new THREE.Mesh(new THREE.CylinderGeometry(3, 5, 85, 8), outerPylonMaterial);
    dishMast.position.set(side * 1_000, 197, 320); root.add(dishMast);
  }

  // Cooling towers with live steam plumes.
  for (const side of [-1, 1]) for (const z of [-430, 430]) {
    const profile = Array.from({ length: 10 }, (_, index) => {
      const t = index / 9;
      return new THREE.Vector2(34 - Math.sin(t * Math.PI) * 13, t * 118);
    });
    const tower = new THREE.Mesh(new THREE.LatheGeometry(profile, 24), detailedStandard('#7d8f98', .78, .18, surfaces, 'concrete'));
    tower.position.set(side * 700, 0, z); tower.castShadow = true; tower.receiveShadow = true; root.add(tower);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(22, 1.6, 6, 28), industrial);
    rim.rotation.x = Math.PI / 2; rim.position.set(side * 700, 119, z); root.add(rim);
    rig.columns.push({
      base: .8,
      field: createColumn(root, rig.puffTexture, {
        origin: new THREE.Vector3(side * 700, 122, z), count: 70, rise: 230, spread: 34, size: 62,
        color: '#e8f6fb', opacity: .36, lifetime: 8.5,
      }),
    });
  }

  // Generator hall with spinning turbine fans.
  for (const side of [-1, 1]) {
    const hall = new THREE.Group();
    hall.position.set(side * 640, 0, side * 560);
    root.add(hall);
    addBox(hall, '#32485a', [150, 44, 86], [0, 22, 0], apronMetal);
    addBox(hall, '#5d7682', [160, 6, 94], [0, 47, 0], industrial);
    for (let index = 0; index < 5; index += 1) {
      addBox(hall, '#13303f', [22, 12, 2.4], [-58 + index * 29, 28, 44], windowGlow);
      const fanHousing = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 6, 16), industrial);
      fanHousing.rotation.x = Math.PI / 2;
      fanHousing.position.set(-58 + index * 29, 30, -44);
      hall.add(fanHousing);
      const fan = new THREE.Group();
      fan.position.set(-58 + index * 29, 30, -46.5);
      hall.add(fan);
      for (let blade = 0; blade < 5; blade += 1) {
        const vane = addBox(fan, '#9db3bc', [3.4, 18, .9], [0, 0, 0], industrial);
        vane.rotation.z = (blade / 5) * Math.PI * 2;
        vane.position.set(Math.sin((blade / 5) * Math.PI * 2) * 5, Math.cos((blade / 5) * Math.PI * 2) * 5, 0);
      }
      rig.rotators.push({ object: fan, axis: 'z', speed: 2.1 + index * .24 });
    }
    // Scissor-lift maintenance platform.
    const lift = new THREE.Group();
    lift.position.set(side * 96, 0, 56);
    hall.add(lift);
    addBox(lift, '#2d4150', [26, 3, 20], [0, 0, 0], industrial);
    for (const sx of [-1, 1]) addBox(lift, '#5f7a86', [1.2, 11, 1.2], [sx * 12, 6, 9], industrial);
    addBox(lift, '#5f7a86', [26, 1.2, 1.2], [0, 11, 9], industrial);
    rig.oscillators.push({ object: lift, axis: 'y', home: 26, amplitude: 22, speed: .17, phase: side > 0 ? .4 : 2.2 });
    lift.position.y = 26;
  }

  // Pipelines linking tanks to the reactor ring, with elbow joints.
  const pipeMaterial = detailedStandard('#5d7480', .42, .56, surfaces, 'steel');
  for (const side of [-1, 1]) for (const z of [-180, 0, 180]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(18, 18, 38, 16), tankMaterial);
    tank.position.set(side * 578, 22, z); tank.castShadow = true; root.add(tank);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(18, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), tankMaterial);
    cap.position.set(side * 578, 41, z); root.add(cap);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 50, 8), pipeMaterial);
    pipe.rotation.z = Math.PI / 2; pipe.position.set(side * 535, 7, z); root.add(pipe);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(3.1, 10, 8), pipeMaterial);
    elbow.position.set(side * 510, 7, z); root.add(elbow);
    const riser = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 44, 8), pipeMaterial);
    riser.position.set(side * 510, 29, z); root.add(riser);
  }
  for (const side of [-1, 1]) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 640, 10), pipeMaterial);
    trunk.rotation.x = Math.PI / 2;
    trunk.position.set(side * 620, 12, 0);
    root.add(trunk);
    for (let index = 0; index < 9; index += 1) {
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(12, 10, 7), pipeMaterial);
      saddle.position.set(side * 620, 5, -300 + index * 75);
      root.add(saddle);
    }
  }

  // Ventilation stacks with extractor fans.
  for (const side of [-1, 1]) for (const z of [-320, -120, 120, 320]) {
    const duct = new THREE.Mesh(new THREE.BoxGeometry(16, 30, 16), industrial);
    duct.position.set(side * 655, 15, z); duct.castShadow = true; root.add(duct);
    const cowl = new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 9, 12), industrial);
    cowl.position.set(side * 655, 34, z); root.add(cowl);
    const extractor = new THREE.Group();
    extractor.position.set(side * 655, 39, z);
    root.add(extractor);
    for (let blade = 0; blade < 4; blade += 1) {
      const vane = addBox(extractor, '#aebfc6', [14, .8, 4.4], [0, 0, 0], industrial);
      vane.rotation.y = (blade / 4) * Math.PI;
    }
    rig.rotators.push({ object: extractor, axis: 'y', speed: 3.4 });
  }

  // Comms towers: lattice masts with blinking aviation lights.
  for (const [index, spot] of ([[-980, -560], [980, -560], [-980, 560], [980, 560]] as const).entries()) {
    const mast = new THREE.Group();
    mast.position.set(spot[0], 0, spot[1]);
    root.add(mast);
    const height = 300 + (index % 2) * 70;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      addBeam(mast, new THREE.Vector3(sx * 11, 0, sz * 11), new THREE.Vector3(sx * 2.6, height, sz * 2.6), 1.1, industrial);
    }
    for (let level = 0; level < 10; level += 1) {
      const t = level / 9;
      const half = 11 - t * 8.4;
      const y = t * height;
      addLine(mast, [
        new THREE.Vector3(-half, y, -half), new THREE.Vector3(half, y, -half),
        new THREE.Vector3(half, y, half), new THREE.Vector3(-half, y, half), new THREE.Vector3(-half, y, -half),
      ], 0x8fa8b4, .6);
      if (level % 3 === 1) {
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), basic('#ff5a4a'));
        lamp.position.set(0, y, half);
        mast.add(lamp);
        lamp.material = rig.lampMaterial; rig.warningLamps.push(lamp);
      }
    }
    const dish = new THREE.Mesh(new THREE.SphereGeometry(13, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), standard('#b8cad1', .24, .78));
    dish.position.set(0, height * .72, 10);
    dish.rotation.x = -Math.PI / 3;
    mast.add(dish);
    rig.rotators.push({ object: dish, axis: 'y', speed: index % 2 ? .18 : -.14 });
    const top = new THREE.Mesh(new THREE.SphereGeometry(3.4, 10, 8), basic('#ff3f3f'));
    top.position.y = height + 5;
    mast.add(top);
    top.material = rig.lampMaterial; rig.warningLamps.push(top);
  }

  // Maintenance sheds along the outer apron.
  for (const side of [-1, 1]) for (let index = 0; index < 4; index += 1) {
    const shed = new THREE.Group();
    shed.position.set(side * 1_010, 0, -330 + index * 220);
    root.add(shed);
    addBox(shed, '#2c4252', [74, 24, 48], [0, 12, 0], apronMetal);
    addBox(shed, '#56707d', [80, 4, 54], [0, 25, 0], industrial);
    for (let window = 0; window < 4; window += 1) {
      addBox(shed, '#13303f', [12, 7, 1.8], [-27 + window * 18, 15, 24.5], windowGlow);
    }
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 22, 10), industrial);
    stack.position.set(24, 36, -14);
    shed.add(stack);
  }
}

function buildCargoAndProps(rig: Rig) {
  const { root, surfaces } = rig;
  const industrial = detailedStandard('#536b77', .48, .52, surfaces, 'steel');

  // Container yard, instanced so a few hundred crates cost one draw call.
  const containerGeometry = new THREE.BoxGeometry(24, 11, 10);
  const containerMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .74, metalness: .22 });
  const containerTints = [0x3f6f86, 0xa8513f, 0x4f7a52, 0x8a7a3f, 0x5b5f78, 0x8f4455];
  const containers = new THREE.InstancedMesh(containerGeometry, containerMaterial, 320);
  const dummy = new THREE.Object3D();
  let crate = 0;
  for (const side of [-1, 1]) for (let bay = 0; bay < 8; bay += 1) for (let column = 0; column < 5; column += 1) {
    const stack = 1 + ((bay + column) % 4);
    for (let level = 0; level < stack; level += 1) {
      if (crate >= containers.count) break;
      dummy.position.set(side * (2_300 + column * 13), 5.5 + level * 11.4, -420 + bay * 118 + (level % 2) * 2);
      dummy.rotation.set(0, (bay % 2 ? .04 : -.03) + Math.PI / 2, 0);
      dummy.updateMatrix();
      containers.setMatrixAt(crate, dummy.matrix);
      containers.setColorAt(crate, new THREE.Color(containerTints[(bay * 3 + column + level) % containerTints.length]));
      crate += 1;
    }
  }
  containers.count = crate;
  containers.instanceMatrix.needsUpdate = true;
  if (containers.instanceColor) containers.instanceColor.needsUpdate = true;
  containers.castShadow = true;
  containers.receiveShadow = true;
  root.add(containers);

  // Destructible perimeter clutter. These sit just inside the barrier so
  // strafing runs and crashes actually chew them up.
  const propSpots: { x: number; z: number; kind: 'crate' | 'tank' | 'generator' | 'mast' }[] = [];
  for (const side of [-1, 1]) {
    for (const z of [-300, -180, -60, 60, 180, 300]) propSpots.push({ x: side * 448, z, kind: z % 120 === 0 ? 'crate' : 'tank' });
    for (const x of [-380, -230, -80, 80, 230, 380]) propSpots.push({ x, z: side * 338, kind: Math.abs(x) > 300 ? 'generator' : 'mast' });
  }

  const propSteel = detailedStandard('#4f6773', .5, .5, surfaces, 'steel');
  const hazardMaterial = new THREE.MeshStandardMaterial({
    color: '#1d2f3a', emissive: '#ffb347', emissiveIntensity: .5, roughness: .4, metalness: .3,
  });
  rig.nightGlow.push({ material: hazardMaterial, day: .35, night: 1.1 });

  for (const [index, spot] of propSpots.entries()) {
    const group = new THREE.Group();
    group.position.set(spot.x, 0, spot.z);
    group.rotation.y = (index % 4) * .18;
    root.add(group);
    const scorch: THREE.MeshStandardMaterial[] = [];
    let radius = 18;
    let hp = 120;

    if (spot.kind === 'crate') {
      const shell = new THREE.MeshStandardMaterial({ color: '#56707d', roughness: .72, metalness: .2 });
      scorch.push(shell);
      for (let level = 0; level < 3; level += 1) {
        const crateMesh = new THREE.Mesh(new THREE.BoxGeometry(26, 11, 12), shell);
        crateMesh.position.set((level % 2) * 3 - 1.5, 5.5 + level * 11.2, 0);
        crateMesh.castShadow = true; crateMesh.receiveShadow = true;
        group.add(crateMesh);
      }
      radius = 20; hp = 110;
    } else if (spot.kind === 'tank') {
      const shell = new THREE.MeshStandardMaterial({ color: '#6d838d', roughness: .42, metalness: .5 });
      scorch.push(shell);
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 30, 14), shell);
      tank.position.y = 15; tank.castShadow = true; group.add(tank);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(12, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), shell);
      cap.position.y = 30; group.add(cap);
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(12.3, .9, 6, 20), hazardMaterial);
      stripe.rotation.x = Math.PI / 2; stripe.position.y = 20; group.add(stripe);
      radius = 18; hp = 90;
    } else if (spot.kind === 'generator') {
      const shell = new THREE.MeshStandardMaterial({ color: '#3d5464', roughness: .56, metalness: .42 });
      scorch.push(shell);
      const body = new THREE.Mesh(new THREE.BoxGeometry(36, 20, 24), shell);
      body.position.y = 10; body.castShadow = true; body.receiveShadow = true; group.add(body);
      for (let rib = 0; rib < 5; rib += 1) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(2, 22, 26), propSteel);
        fin.position.set(-14 + rib * 7, 11, 0); group.add(fin);
      }
      const coil = new THREE.Mesh(new THREE.TorusGeometry(8, 1.6, 6, 20), hazardMaterial);
      coil.rotation.x = Math.PI / 2; coil.position.set(0, 22, 0); group.add(coil);
      const spinner = new THREE.Group();
      spinner.position.set(0, 10, 13);
      group.add(spinner);
      for (let blade = 0; blade < 4; blade += 1) {
        const vane = addBox(spinner, '#9db3bc', [13, .8, 3.6], [0, 0, 0], propSteel);
        vane.rotation.z = (blade / 4) * Math.PI;
      }
      rig.rotators.push({ object: spinner, axis: 'z', speed: 2.6 });
      radius = 24; hp = 150;
    } else {
      const shell = new THREE.MeshStandardMaterial({ color: '#5d7480', roughness: .44, metalness: .54 });
      scorch.push(shell);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 3.2, 46, 8), shell);
      mast.position.y = 23; mast.castShadow = true; group.add(mast);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(9, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), shell);
      dish.position.y = 48; dish.rotation.x = -Math.PI / 3; group.add(dish);
      rig.rotators.push({ object: dish, axis: 'y', speed: index % 2 ? .5 : -.42 });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.9, 8, 6), basic('#ff5f4a'));
      lamp.position.y = 52; group.add(lamp);
      lamp.material = rig.lampMaterial; rig.warningLamps.push(lamp);
      radius = 16; hp = 70;
    }

    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(radius + 5, radius + 6, 1.6, 16), propSteel);
    skirt.position.y = .8; skirt.receiveShadow = true; group.add(skirt);

    rig.props.push({
      group,
      anchor: new THREE.Vector3(spot.x * SHELL_SCALE, 10 * SHELL_SCALE, spot.z * SHELL_SCALE),
      radius: radius * SHELL_SCALE,
      hp,
      maxHp: hp,
      fall: 0,
      tilt: (index % 2 ? 1 : -1) * (.5 + (index % 3) * .18),
      smoke: null,
      scorch,
    });
  }
}

function buildClouds(rig: Rig) {
  const cloudMaterial = new THREE.MeshStandardMaterial({
    color: '#f4fbff', roughness: 1, transparent: true, opacity: .66, depthWrite: false,
  });
  const cloudGeometry = new THREE.SphereGeometry(1, 9, 6);
  for (let index = 0; index < 11; index += 1) {
    const group = new THREE.Group();
    const x = -1_000 + (index % 6) * 390;
    const z = index < 6 ? -780 - (index % 2) * 130 : 760 + (index % 2) * 140;
    group.position.set(x, 430 + (index % 3) * 28, z);
    for (let puff = 0; puff < 5; puff += 1) {
      const cloud = new THREE.Mesh(cloudGeometry, cloudMaterial);
      cloud.position.set((puff - 2) * 27, Math.sin(puff * 1.7) * 8, Math.cos(puff * 1.4) * 13);
      cloud.scale.set(32 + (puff % 3) * 13, 10 + (puff % 2) * 5, 19 + (puff % 3) * 6);
      group.add(cloud);
    }
    group.userData.phase = index * .73;
    group.userData.homeX = x;
    group.userData.homeZ = z;
    rig.root.add(group);
    rig.clouds.push(group);
  }
  return cloudMaterial;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */


/**
 * Collapses the stadium's static parts into as few draws as possible. Moving
 * parts are protected; materials animated at runtime are pinned so they are
 * never swapped for a look-alike that would stop responding.
 */
function mergeStatic(shell: THREE.Group, rig: Rig) {
  const protect: THREE.Object3D[] = [
    ...rig.rotators.map((entry) => entry.object),
    ...rig.oscillators.map((entry) => entry.object),
    ...rig.floaters.map((entry) => entry.object),
    ...rig.props.map((entry) => entry.group),
    ...rig.gates, ...rig.holograms, ...rig.reactorRings, ...rig.protect,
  ];
  const pinned = new Set<THREE.Material>([
    rig.lampMaterial,
    ...rig.nightGlow.map((entry) => entry.material),
    ...rig.screens.map((entry) => entry.material),
    ...rig.floodLamps,
    ...(rig.reactorCore ? [rig.reactorCore] : []),
    ...rig.props.flatMap((prop) => prop.scorch),
  ]);
  // Moving groups (fans, props, floating pads, the reactor) hold many small
  // static parts of their own. Merge inside each one too, leaving alone any
  // nested part that moves independently of it.
  const isInside = (object: THREE.Object3D, group: THREE.Object3D) => {
    for (let node = object.parent; node; node = node.parent) if (node === group) return true;
    return false;
  };
  for (const group of protect) {
    if (!(group instanceof THREE.Group)) continue;
    mergeStaticMeshes(group, protect.filter((other) => other !== group && isInside(other, group)), pinned);
  }
  return mergeStaticMeshes(shell, protect, pinned);
}

export function buildSkyforge(scene: THREE.Scene, surfaces: SurfaceMaps, lighting: ArenaLighting): SkyforgeHandle {
  const root = new THREE.Group();
  scene.add(root);
  // Everything the builders add goes into `shell`, authored at 1x and scaled
  // up as a unit. World-space effects attach to `root` instead.
  const shell = new THREE.Group();
  shell.scale.setScalar(SHELL_SCALE);
  root.add(shell);

  const puffTexture = createPuffTexture();
  const rig: Rig = {
    root: shell, surfaces, puffTexture,
    warningLamps: [], lampMaterial: new THREE.MeshBasicMaterial({ color: '#ff586d', toneMapped: false }), nightGlow: [], screens: [], floodLamps: [],
    rotators: [], oscillators: [], adverts: [], holograms: [], columns: [], props: [], clouds: [],
    crowdUniforms: { crowdTime: { value: 0 }, crowdWave: { value: 0 }, crowdIdle: { value: 1 }, crowdNight: { value: 0 }, crowdTifo: { value: 0 } },
    bannerUniforms: { bannerTime: { value: 0 }, bannerGust: { value: .2 } },
    protect: [],
    reactorRings: [], reactorCore: null, gates: [], floaters: [], energy: { time: { value: 0 } }, shafts: null,
  };

  buildGroundPlane(rig);
  const bowl = buildBowl(rig);
  buildRoofAndFloods(rig, detailedStandard('#526a76', .44, .58, surfaces, 'steel'));
  buildDome(rig);
  buildReactor(rig);
  buildLoungesAndDecks(rig);
  const scoreboard = createScoreboard();
  buildScreensAndBanners(rig, scoreboard);
  buildCombatLevels(rig);
  buildGates(rig);
  buildFloodlightRig(rig);
  // The yard is authored around the old, smaller bowl. Build it in its own
  // group and push every piece radially out past the facade, so tanks and
  // cooling towers ring the stadium instead of sitting under its stands.
  const yard = new THREE.Group();
  shell.add(yard);
  rig.root = yard;
  buildIndustrialYard(rig, bowl.outerPylonMaterial);
  rig.root = shell;
  for (const piece of yard.children) {
    piece.position.x *= YARD_PUSH;
    piece.position.z *= YARD_PUSH;
  }
  buildCargoAndProps(rig);
  mergeStatic(shell, rig);

  // World space: these must line up with server coordinates.
  const barrier = createBarrier(root);
  const sparks = createSparks(root, puffTexture, 260);
  const weather = createWeather(root, puffTexture);

  // Lighting-cycle scratch state.
  const sunDirection = new THREE.Vector3();
  const horizonColor = new THREE.Color();
  const zenithColor = new THREE.Color();
  const sunTint = new THREE.Color();
  const fogColor = new THREE.Color();
  const scratchColor = new THREE.Color();
  const keyDirection = new THREE.Vector3();
  const floodTint = new THREE.Color('#dcecff');
  const hemiSkyColor = new THREE.Color();
  const hemiGroundColor = new THREE.Color();
  const ambientColor = new THREE.Color();
  const sunFrom = new THREE.Vector3();
  const sunTo = new THREE.Vector3();

  let nightness = 0;
  let storm = 0;
  let phaseLabel = 'DAY';
  let alarmUntil = 0;
  let alertLevel = 0;
  let lastScoreboardAt = -1;
  let lastScoreboardSignature = '';
  let lastDisplayState: DisplayState | undefined;
  let lightningUntil = 0;
  let crowdExcitementUntil = 0;

  const applySkyCycle = (nowMs: number) => {
    const phase = (nowMs % DAY_CYCLE_MS) / DAY_CYCLE_MS;
    let from = SKY_KEYS[SKY_KEYS.length - 1];
    let to = SKY_KEYS[0];
    let span = SKY_KEYS[0].at + 1 - from.at;
    let local = ((phase - from.at + 1) % 1) / span;
    for (let index = 0; index < SKY_KEYS.length - 1; index += 1) {
      if (phase >= SKY_KEYS[index].at && phase < SKY_KEYS[index + 1].at) {
        from = SKY_KEYS[index];
        to = SKY_KEYS[index + 1];
        span = to.at - from.at;
        local = (phase - from.at) / span;
        break;
      }
    }
    // Smoothstep keeps the transitions from reading as a linear slide.
    const blend = local * local * (3 - 2 * local);
    const mixNumber = (a: number, b: number) => a + (b - a) * blend;

    horizonColor.set(from.horizon).lerp(scratchColor.set(to.horizon), blend);
    zenithColor.set(from.zenith).lerp(scratchColor.set(to.zenith), blend);
    sunTint.set(from.sunTint).lerp(scratchColor.set(to.sunTint), blend);
    sunFrom.set(...from.sunDir);
    sunTo.set(...to.sunDir);
    sunDirection.copy(sunFrom).lerp(sunTo, blend);

    nightness = mixNumber(from.nightness, to.nightness);
    phaseLabel = blend < .5 ? from.label : to.label;
    lighting.sky.setSky(horizonColor, zenithColor, sunTint, sunDirection, mixNumber(from.stars, to.stars));

    // Key light: the sun by day, swinging overhead to become the floodlights
    // at night. Placed far out along its direction so even the dome and roof
    // fall inside the shadow camera.
    keyDirection.copy(sunDirection).normalize().lerp(FLOOD_KEY, THREE.MathUtils.smoothstep(nightness, .4, .9)).normalize();
    lighting.sun.position.copy(keyDirection).multiplyScalar(ARENA.halfWidth * 1.6);
    lighting.sun.color.set(from.sunColor).lerp(scratchColor.set(to.sunColor), blend);
    lighting.sun.intensity = mixNumber(from.sunIntensity, to.sunIntensity);

    hemiSkyColor.set(from.hemiSky).lerp(scratchColor.set(to.hemiSky), blend);
    hemiGroundColor.set(from.hemiGround).lerp(scratchColor.set(to.hemiGround), blend);
    lighting.hemisphere.color.copy(hemiSkyColor);
    lighting.hemisphere.groundColor.copy(hemiGroundColor);
    lighting.hemisphere.intensity = mixNumber(from.hemiIntensity, to.hemiIntensity);

    ambientColor.set(from.ambient).lerp(scratchColor.set(to.ambient), blend);
    lighting.ambient.color.copy(ambientColor);
    lighting.ambient.intensity = mixNumber(from.ambientIntensity, to.ambientIntensity);

    fogColor.set(from.fog).lerp(scratchColor.set(to.fog), blend);
    if (lighting.scene.fog instanceof THREE.FogExp2) {
      lighting.scene.fog.color.copy(fogColor);
      // Keyframe densities are authored for the 1x arena; exponential fog must
      // thin by the same factor the distances grow, or the stands white out.
      lighting.scene.fog.density = mixNumber(from.fogDensity, to.fogDensity) * (1 + storm * .9) / SHELL_SCALE;
    }
    if (lighting.scene.background instanceof THREE.Color) lighting.scene.background.copy(fogColor);
    lighting.renderer.toneMappingExposure = mixNumber(from.exposure, to.exposure);
  };

  const scorchTint = new THREE.Color('#20262b');
  const damageProp = (prop: Prop, amount: number) => {
    if (prop.hp <= 0) return;
    prop.hp = Math.max(0, prop.hp - amount);
    const wear = 1 - prop.hp / prop.maxHp;
    for (const material of prop.scorch) {
      material.color.lerp(scorchTint, Math.min(.4, wear * .4));
      material.roughness = Math.min(1, material.roughness + wear * .02);
    }
    sparks.burst(prop.anchor.x, prop.anchor.y + 6 * SHELL_SCALE, prop.anchor.z, 14, 34 * SHELL_SCALE);
    if (prop.hp > 0) return;
    prop.smoke = createColumn(root, puffTexture, {
      origin: new THREE.Vector3(prop.anchor.x, 6 * SHELL_SCALE, prop.anchor.z),
      count: 48, rise: 150 * SHELL_SCALE, spread: 20 * SHELL_SCALE, size: 40 * SHELL_SCALE,
      color: '#2a2b2d', opacity: .5, lifetime: 6,
    });
    sparks.burst(prop.anchor.x, prop.anchor.y + 8 * SHELL_SCALE, prop.anchor.z, 46, 72 * SHELL_SCALE);
    alarmUntil = Math.max(alarmUntil, performance.now() + 2_600);
  };

  const handle: SkyforgeHandle = {
    mood() { return nightness; },
    draw(state) {
      lastDisplayState = state;
      lastScoreboardAt = -1;
    },
    update(nowMs, dt, jets) {
      applySkyCycle(Date.now());

      // Weather drifts on its own slow schedule and peaks around dusk.
      const weatherPhase = (nowMs % 420_000) / 420_000;
      storm = Math.max(0, Math.sin(weatherPhase * Math.PI * 2) ** 3) * (.35 + nightness * .55);
      if (storm > .55 && Math.random() < dt * .35) lightningUntil = nowMs + 170;
      // Lightning is outside the dome: a soft flash that decays, not a hard
      // full-stadium on/off, which read as the screen flickering.
      const lightningLeft = Math.max(0, lightningUntil - nowMs) / 170;
      const lightning = lightningLeft * lightningLeft;
      if (lightning > 0) {
        lighting.hemisphere.intensity += .7 * lightning;
        lighting.ambient.intensity += .25 * lightning;
      }
      weather.update(dt, nowMs, storm, nightness);

      const alarmActive = nowMs < alarmUntil;
      alertLevel += ((alarmActive ? 1 : 0) - alertLevel) * Math.min(1, dt * 5);

      // Screens.
      // Repaint only when what the board shows has actually changed.
      const flashOn = alarmActive && Math.sin(nowMs * .012) > -.2;
      const shown = lastDisplayState;
      scoreboard.setAlert(flashOn);
      const signature = (shown ? [shown.phase, shown.round, shown.roundWins.azure, shown.roundWins.ember, Math.floor(shown.secondsLeft), shown.room, shown.defender, shown.overtime, ...(shown.towers ?? []).map((tower) => Math.ceil(tower.hp / tower.maxHp * 20))].join('|') : '-')
        + '|' + phaseLabel + '|' + Math.floor(nowMs / 9_000);
      if (signature !== lastScoreboardSignature && nowMs - lastScoreboardAt > 120) {
        lastScoreboardSignature = signature;
        lastScoreboardAt = nowMs;
        scoreboard.draw(lastDisplayState, nowMs, false, phaseLabel);
      }
      for (const advert of rig.adverts) advert.draw(nowMs);
      for (const screen of rig.screens) {
        const level = screen.day + (screen.night - screen.day) * nightness;
        screen.material.color.setScalar(.7 + level * .3);
      }

      // Crowd: a travelling wave that fires on goals and after dusk.
      if (alarmActive) crowdExcitementUntil = Math.max(crowdExcitementUntil, nowMs + 4_200);
      rig.crowdUniforms.crowdTime.value = nowMs / 1_000;
      const excited = nowMs < crowdExcitementUntil;
      const targetWave = excited ? 1 : .34;
      rig.crowdUniforms.crowdWave.value += (targetWave - rig.crowdUniforms.crowdWave.value) * Math.min(1, dt * 1.6);
      rig.crowdUniforms.crowdIdle.value = .6 + (excited ? .8 : .25);
      rig.crowdUniforms.crowdNight.value = nightness;
      // The home ends hold up a card-stunt tifo for a few seconds every 40s,
      // and immediately after any core alert.
      const tifoCycle = (nowMs % 40_000) / 40_000;
      const tifoTarget = excited || (tifoCycle > .82 && tifoCycle < .97) ? 1 : 0;
      rig.crowdUniforms.crowdTifo.value += (tifoTarget - rig.crowdUniforms.crowdTifo.value) * Math.min(1, dt * 2.4);

      // Banners pick up gusts with the weather.
      rig.bannerUniforms.bannerTime.value = nowMs / 1_000;
      rig.bannerUniforms.bannerGust.value = .25 + storm * 1.1;

      // Floodlights: lamp faces run HDR bright after dark so they bloom, and
      // the shafts they throw through the haze fade in from dusk.
      for (const lamp of rig.floodLamps) {
        const level = .9 + nightness * 2.6 + alertLevel * .6;
        lamp.color.setRGB(level, level * .98, level * .94);
      }
      if (rig.shafts) rig.shafts.uniforms.strength.value = Math.max(0, nightness - .25) * .11;
      rig.energy.time.value = nowMs / 1_000;
      lighting.sky.setClouds(nowMs / 1_000, .38 + storm * .5);
      for (const entry of rig.nightGlow) {
        entry.material.emissiveIntensity = entry.day + (entry.night - entry.day) * nightness;
      }

      // Machinery.
      for (const rotator of rig.rotators) rotator.object.rotation[rotator.axis] += rotator.speed * dt;
      for (const oscillator of rig.oscillators) {
        oscillator.object.position[oscillator.axis] =
          oscillator.home + Math.sin(nowMs / 1_000 * oscillator.speed * Math.PI * 2 + oscillator.phase) * oscillator.amplitude;
      }
      for (const floater of rig.floaters) {
        floater.object.position.y = floater.home + Math.sin(nowMs / 1_000 * .55 + floater.phase) * 5.5;
        floater.object.rotation.y += dt * .06;
      }
      for (let index = 0; index < rig.reactorRings.length; index += 1) rig.reactorRings[index].rotation.z = nowMs / 1_000 * (index % 2 ? -.5 : .66);
      if (rig.reactorCore) rig.reactorCore.emissiveIntensity = 2 + Math.sin(nowMs * .0016) * .4 + alertLevel * 1.5;
      // Gates turn slowly about their own axis.
      for (let index = 0; index < rig.gates.length; index += 1) rig.gates[index].rotation.z += dt * (index % 2 ? .12 : -.12);
      for (const [index, holo] of rig.holograms.entries()) {
        holo.rotation.z += dt * (index % 2 ? .22 : -.19);
        holo.position.y += Math.sin(nowMs / 1_000 * .6 + index) * dt * 4;
      }

      // Steam and smoke scale back in bright daylight so they stay readable.
      for (const column of rig.columns) column.field.update(dt, column.base * (.55 + nightness * .45 + storm * .3));
      sparks.update(dt);

      // Warning lamps: slow pulse normally, hard strobe on an alert.
      if (alertLevel > .25) {
        const strobe = .45 + .55 * Math.abs(Math.sin(nowMs * .014));
        rig.lampMaterial.color.setRGB(strobe, strobe * .18, strobe * .22);
      } else {
        const pulse = .5 + .35 * Math.sin(nowMs * .002);
        const warm = .25 + nightness * .75;
        rig.lampMaterial.color.setRGB(pulse * warm + .2, pulse * warm * .34, pulse * warm * .28);
      }

      // Destructible props settle and smoke once they are down.
      for (const prop of rig.props) {
        if (prop.hp <= 0 && prop.fall < 1) {
          prop.fall = Math.min(1, prop.fall + dt * .9);
          const eased = prop.fall * prop.fall;
          prop.group.rotation.z = prop.tilt * eased;
          prop.group.position.y = -eased * 5;  // shell space
        }
        prop.smoke?.update(dt, prop.hp <= 0 ? .9 : 0);
      }

      // Jets flying close to the service yard trip proximity strobes.
      if (jets?.length) {
        for (const prop of rig.props) {
          if (prop.hp > 0) continue;
          for (const jet of jets) {
            if (Math.abs(jet.x - prop.anchor.x) < 90 * SHELL_SCALE && Math.abs(jet.z - prop.anchor.z) < 90 * SHELL_SCALE && jet.y < 120 * SHELL_SCALE) {
              if (Math.random() < dt * 1.4) sparks.burst(prop.anchor.x, 8 * SHELL_SCALE, prop.anchor.z, 4, 20 * SHELL_SCALE);
              break;
            }
          }
        }
      }

      barrier.update(dt, nowMs, alertLevel + lightning * .4, nightness);
    },
    signalBoundary(x, y, z) {
      alarmUntil = Math.max(alarmUntil, performance.now() + 1_800);
      if (x === undefined || y === undefined || z === undefined) return;
      // Snap the ripple onto the nearest barrier face so it reads as contact.
      const toX = PLAY.halfWidth - Math.abs(x);
      const toZ = PLAY.halfDepth - Math.abs(z);
      const toY = Math.min(y - PLAY.floor, PLAY.ceiling - y);
      const point = new THREE.Vector3(x, y, z);
      if (toX <= toZ && toX <= toY) point.x = Math.sign(x) * PLAY.halfWidth;
      else if (toZ <= toY) point.z = Math.sign(z) * PLAY.halfDepth;
      else point.y = y - PLAY.floor < PLAY.ceiling - y ? PLAY.floor : PLAY.ceiling;
      barrier.ripple(point.x, point.y, point.z);
      sparks.burst(point.x, point.y, point.z, 18, 30 * FLIGHT_SCALE);
    },
    raiseAlarm(ms) {
      alarmUntil = Math.max(alarmUntil, performance.now() + ms);
    },
    reportImpact(x, y, z, major) {
      sparks.burst(x, y, z, major ? 54 : 16, (major ? 70 : 32) * FLIGHT_SCALE);
      if (major) alarmUntil = Math.max(alarmUntil, performance.now() + 2_200);
      const reach = (major ? 95 : 42) * SHELL_SCALE;
      for (const prop of rig.props) {
        if (prop.hp <= 0) continue;
        const distance = Math.hypot(x - prop.anchor.x, z - prop.anchor.z);
        if (distance > reach + prop.radius || y > 110 * SHELL_SCALE) continue;
        damageProp(prop, (major ? 120 : 45) * (1 - distance / (reach + prop.radius)));
      }
    },
    dispose() {
      scoreboard.dispose();
      for (const advert of rig.adverts) advert.dispose();
      for (const column of rig.columns) column.field.dispose();
      for (const prop of rig.props) prop.smoke?.dispose();
      sparks.dispose();
      weather.dispose();
      barrier.dispose();
      puffTexture.dispose();
      scene.remove(root);
    },
  };
  return handle;
}
