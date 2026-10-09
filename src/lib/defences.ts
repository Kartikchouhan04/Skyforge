import * as THREE from 'three';
import { ARENA_SCALE, FLIGHT_SCALE, GROUND, TOWER, type JetState, type StationState, type Team, type TowerState } from '@/lib/protocol';
import { addBox, basic, detailedStandard, mergeStaticMeshes, standard, TEAM_COLORS, TEAM_MATERIALS, type SurfaceMaps } from '@/lib/arena-kit';

/**
 * The defenders' hardware: the three strategic towers, the gun stations in
 * front of them, and the mobile anti-aircraft units ground defenders crew.
 * Static parts are merged per moving piece, because draw calls are what limit
 * this scene.
 */

/** Frees the geometry and materials of a tree built here (none of it is shared). */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => material?.dispose());
  });
}

function labelTexture(text: string, team: Team, width = 512, height = 192, size = 104) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#06121c'; context.fillRect(0, 0, width, height);
    context.strokeStyle = TEAM_MATERIALS[team]; context.lineWidth = 14; context.strokeRect(10, 10, width - 20, height - 20);
    context.fillStyle = '#f2fbff'; context.font = `700 ${size}px Rajdhani, Arial, sans-serif`;
    context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(text, width / 2, height / 2 + size * .06);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/* ------------------------------------------------------------------ towers */

export type TowerObject = {
  group: THREE.Group;
  update(tower: TowerState, dt: number, now: number): void;
  /** The Weapons Tower's turret swings to where it just fired. */
  fired(yaw: number, pitch: number, now: number): void;
  dispose(): void;
};

/** Energy bubble: bright at the rim, nearly clear face-on, with bands climbing it. */
function bubbleMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: color }, strength: { value: 0 }, time: { value: 0 } },
    vertexShader: `varying vec3 vNormalView;
      varying vec3 vToCamera;
      varying float vHeight;
      void main() {
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vNormalView = normalMatrix * normal;
        vToCamera = -view.xyz;
        vHeight = position.y;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `uniform vec3 color;
      uniform float strength;
      uniform float time;
      varying vec3 vNormalView;
      varying vec3 vToCamera;
      varying float vHeight;
      vec3 safeNormalize(vec3 v) { return v * inversesqrt(max(dot(v, v), 1e-12)); }
      void main() {
        float facing = abs(dot(safeNormalize(vNormalView), safeNormalize(vToCamera)));
        float rim = pow(clamp(1.0 - facing, 0.0, 1.0), 2.4);
        float bands = 0.5 + 0.5 * sin(vHeight * 0.45 - time * 3.0);
        float glow = (rim * 0.85 + 0.06 + bands * 0.05) * strength;
        gl_FragColor = vec4(color * glow, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** A strategic tower, authored at 1x (radius 20, height 72) and scaled with the arena. Its crown shows what it does. */
export function buildTower(scene: THREE.Scene, tower: TowerState, surfaces: SurfaceMaps): TowerObject {
  const group = new THREE.Group();
  group.position.set(tower.x, 0, tower.z);
  group.scale.setScalar(ARENA_SCALE);
  // Face the centre of the stadium.
  const facing = Math.atan2(-tower.x, -tower.z);
  group.rotation.y = facing;
  scene.add(group);
  const teamColor = TEAM_COLORS[tower.team];
  const concrete = detailedStandard('#4b5c66', .86, .1, surfaces, 'concrete');
  const steel = detailedStandard('#5d7684', .45, .62, surfaces, 'steel');
  const darkSteel = standard('#1b2a33', .42, .7);

  // Everything that survives destruction: plinth, buttresses, lower shaft.
  const lower = new THREE.Group(); group.add(lower);
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(24, 27, 6, 6), concrete);
  plinth.position.y = 3; plinth.castShadow = true; plinth.receiveShadow = true; lower.add(plinth);
  for (let index = 0; index < 6; index += 1) {
    const angle = index / 6 * Math.PI * 2 + Math.PI / 6;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 22, 9), steel);
    fin.position.set(Math.sin(angle) * 15.5, 15, Math.cos(angle) * 15.5); fin.rotation.y = angle; fin.castShadow = true; lower.add(fin);
  }
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(11, 15, 40, 12), steel);
  shaft.position.y = 26; shaft.castShadow = true; shaft.receiveShadow = true; lower.add(shaft);
  for (const y of [12, 24, 36]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(14.6 - y * .1, .7, 6, 24), steel);
    rib.rotation.x = Math.PI / 2; rib.position.y = y; lower.add(rib);
  }
  // Name plates on the front and back.
  const label = labelTexture(tower.label, tower.team);
  const plateMaterial = new THREE.MeshBasicMaterial({ map: label });
  for (const side of [1, -1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(20, 7.5), plateMaterial);
    plate.position.set(0, 15, side * 14.6); plate.rotation.y = side > 0 ? 0 : Math.PI; lower.add(plate);
  }

  // The upper tower, gone once it's destroyed.
  const upper = new THREE.Group(); group.add(upper);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(18, 16, 3, 12), darkSteel);
  collar.position.y = 47; collar.castShadow = true; upper.add(collar);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(19, 19, .8, 12), standard('#5d7684', .42, .7));
  deck.position.y = 48.9; upper.add(deck);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 10, 20, 10), standard('#5d7684', .42, .7));
  mast.position.y = 59; mast.castShadow = true; upper.add(mast);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(10, 8, 4, 10), darkSteel);
  crown.position.y = 70; crown.castShadow = true; upper.add(crown);

  // Team light strips up the shaft and around the deck: they dim and flicker with damage.
  const glow = new THREE.MeshBasicMaterial({ color: teamColor, toneMapped: false });
  const glowRing = new THREE.Mesh(new THREE.TorusGeometry(19.2, .45, 6, 48), glow);
  glowRing.rotation.x = Math.PI / 2; glowRing.position.y = 49.4; upper.add(glowRing);
  for (let index = 0; index < 4; index += 1) {
    const angle = index / 4 * Math.PI * 2 + Math.PI / 4;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(1, 30, .6), glow);
    strip.position.set(Math.sin(angle) * 13.1, 26, Math.cos(angle) * 13.1); strip.rotation.y = angle; lower.add(strip);
  }
  const beaconMaterial = new THREE.MeshBasicMaterial({ color: teamColor, toneMapped: false });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.8, 12, 8), beaconMaterial);
  beacon.position.y = 84; upper.add(beacon);

  // The crown: what this tower does.
  const spinner = new THREE.Group(); spinner.position.y = 72; upper.add(spinner);
  const turretPitch = new THREE.Group();
  if (tower.kind === 'radar') {
    // A big tilted dish on a yoke.
    addBox(spinner, '#1b2a33', [2.4, 6, 2.4], [0, 3, 0], darkSteel);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(10, 20, 8, 0, Math.PI * 2, 0, Math.PI / 3.2), standard('#c7d6dd', .42, .7));
    dish.rotation.x = -Math.PI / 2.3; dish.position.set(0, 8, -2); spinner.add(dish);
    addBox(spinner, '#1b2a33', [.8, .8, 9], [0, 8, 2.5], darkSteel);
  } else if (tower.kind === 'weapons') {
    // A twin-gun turret that tracks its targets.
    addBox(spinner, '#1b2a33', [9, 4, 9], [0, 2, 0], darkSteel);
    turretPitch.position.y = 4; spinner.add(turretPitch);
    for (const side of [-1.8, 1.8]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.55, .7, 14, 8), darkSteel);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(side, 0, 7); turretPitch.add(barrel);
    }
  } else {
    // Shield emitter: a ring of field projectors around a glowing core.
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(4.2, 1), glow);
    core.position.y = 5; spinner.add(core);
    for (let index = 0; index < 4; index += 1) {
      const angle = index / 4 * Math.PI * 2;
      addBox(spinner, '#1b2a33', [1.4, 9, 1.4], [Math.sin(angle) * 8, 4.5, Math.cos(angle) * 8], darkSteel);
    }
    const halo = new THREE.Mesh(new THREE.TorusGeometry(8, .5, 6, 36), glow);
    halo.rotation.x = Math.PI / 2; halo.position.y = 9; spinner.add(halo);
  }

  // Energy bubble: the Shield Tower's protection, or a defender's shield activation.
  const bubbleColor = new THREE.Color(teamColor);
  const bubble = new THREE.Mesh(new THREE.SphereGeometry(33, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), bubbleMaterial(bubbleColor));
  bubble.scale.y = 2.45; bubble.visible = false; bubble.renderOrder = 5; group.add(bubble);
  const bubbleUniforms = (bubble.material as THREE.ShaderMaterial).uniforms;

  // A fire on the stump, once destroyed.
  const fireMaterial = new THREE.MeshBasicMaterial({ color: '#ff7a2a', transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const fire = new THREE.Mesh(new THREE.ConeGeometry(11, 26, 12, 1, true), fireMaterial);
  fire.position.y = 30; fire.visible = false; group.add(fire);

  // Few distinct looks per piece, so each merges to a handful of draws.
  if (tower.kind === 'weapons') mergeStaticMeshes(turretPitch);
  mergeStaticMeshes(spinner, tower.kind === 'weapons' ? [turretPitch] : [], new Set([glow]));
  mergeStaticMeshes(lower, [], new Set([glow, plateMaterial]));
  mergeStaticMeshes(upper, [spinner, beacon], new Set([glow, beaconMaterial]));
  const base = new THREE.Color(teamColor);
  const hurt = new THREE.Color('#ff3b2f');
  const barrierColor = new THREE.Color('#fff3c4');
  let aimYaw = 0; let aimPitch = .3; let lastShot = 0;
  return {
    group,
    update(state, dt, now) {
      const health = Math.max(0, state.hp / state.maxHp);
      const destroyed = state.hp <= 0;
      upper.visible = !destroyed;
      // The shaft breaks off: what's left is a stump about a fifth as tall.
      lower.scale.y = destroyed ? .42 : 1;
      fire.visible = destroyed;
      bubble.visible = !destroyed && (state.shielded || state.barrier > 0);
      if (destroyed) {
        fire.scale.set(1 + Math.sin(now * .013) * .08, 1 + Math.sin(now * .021) * .15, 1);
        fireMaterial.opacity = .55 + Math.sin(now * .03) * .15;
        glow.color.set('#2a0b08');
        return;
      }
      if (bubble.visible) {
        // A defender's activation flares bright gold; the Shield Tower's cover is a steady team-coloured shell.
        const activated = state.barrier > 0;
        bubbleColor.copy(activated ? barrierColor : base);
        bubbleUniforms.strength.value = activated ? .9 + Math.sin(now * .02) * .15 : .32;
        bubbleUniforms.time.value = now / 1_000;
      }
      if (tower.kind === 'weapons') {
        // Track the last shot, then idle-scan.
        const idle = now - lastShot > 1_500;
        const wantYaw = idle ? spinner.rotation.y + dt * .4 : aimYaw - facing;
        const turn = Math.atan2(Math.sin(wantYaw - spinner.rotation.y), Math.cos(wantYaw - spinner.rotation.y));
        spinner.rotation.y += turn * Math.min(1, dt * 10);
        turretPitch.rotation.x = -(idle ? .25 : aimPitch);
      } else {
        spinner.rotation.y += dt * (tower.kind === 'radar' ? 1.6 : .8);
      }
      const critical = health < TOWER.critical;
      const flicker = critical ? (Math.sin(now * .04) > 0 ? 1 : .3) : 1;
      glow.color.copy(base).lerp(hurt, 1 - health).multiplyScalar((.5 + health * 1.3) * flicker);
      beaconMaterial.color.copy(critical ? hurt : base).multiplyScalar(1.5 + Math.sin(now * (critical ? .03 : .006)) * .8);
    },
    fired(yaw, pitch, now) { aimYaw = yaw; aimPitch = pitch; lastShot = now; },
    dispose() {
      scene.remove(group);
      disposeTree(group);
      label.dispose();
    },
  };
}

/* ---------------------------------------------------------------- stations */

/** All six gun stations and three repair pads of one defending side, as one merged group. */
export function buildStations(scene: THREE.Scene, stations: StationState[], surfaces: SurfaceMaps) {
  const group = new THREE.Group();
  scene.add(group);
  const pad = detailedStandard('#3a4a53', .82, .12, surfaces, 'concrete');
  const hazard = basic('#e8b83a');
  const medic = basic('#4dff9a');
  // Pad markings share one atlas (1–6, then 7–9 with a repair cross), so every pad merges into the same draws.
  const cells = 9;
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = 128 * cells; atlasCanvas.height = 128;
  const atlasContext = atlasCanvas.getContext('2d');
  const team = stations[0]?.team ?? 'azure';
  if (atlasContext) {
    for (let index = 0; index < cells; index += 1) {
      const x = index * 128;
      const repair = index >= 6;
      atlasContext.fillStyle = '#06121c'; atlasContext.fillRect(x, 0, 128, 128);
      atlasContext.strokeStyle = repair ? '#4dff9a' : TEAM_MATERIALS[team]; atlasContext.lineWidth = 10; atlasContext.strokeRect(x + 8, 8, 112, 112);
      atlasContext.textAlign = 'center'; atlasContext.textBaseline = 'middle';
      if (repair) {
        atlasContext.fillStyle = '#4dff9a';
        atlasContext.fillRect(x + 50, 26, 28, 60); atlasContext.fillRect(x + 34, 42, 60, 28);
        atlasContext.fillStyle = '#f2fbff'; atlasContext.font = '700 26px Rajdhani, Arial, sans-serif';
        atlasContext.fillText(String(index + 1), x + 64, 104);
      } else {
        atlasContext.fillStyle = '#f2fbff'; atlasContext.font = '700 92px Rajdhani, Arial, sans-serif';
        atlasContext.fillText(String(index + 1), x + 64, 70);
      }
    }
  }
  const atlas = new THREE.CanvasTexture(atlasCanvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  const numberMaterial = new THREE.MeshBasicMaterial({ map: atlas });
  const textures: THREE.Texture[] = [atlas];
  for (const station of stations) {
    const spot = new THREE.Group();
    spot.position.set(station.x, 0, station.z);
    spot.scale.setScalar(FLIGHT_SCALE);
    group.add(spot);
    const repair = station.kind === 'repair';
    const base = new THREE.Mesh(new THREE.CylinderGeometry(repair ? 16 : 20, repair ? 18 : 22, 1.2, 16), pad);
    base.position.y = .6; base.receiveShadow = true; spot.add(base);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(repair ? 16.6 : 20.6, .45, 4, 32), repair ? medic : hazard);
    ring.rotation.x = Math.PI / 2; ring.position.y = 1.25; spot.add(ring);
    if (repair) {
      // A service gantry with a cable reel: repair pads sit right under the tower.
      for (const side of [-1, 1]) addBox(spot, '#59656a', [1.2, 14, 1.2], [side * 9, 7, -8], standard('#59656a', .6, .5));
      addBox(spot, '#59656a', [19.2, 1.4, 1.4], [0, 14, -8], standard('#59656a', .6, .5));
    } else {
      // Sandbag-style berm on the outer side.
      for (let index = 0; index < 5; index += 1) {
        const angle = (index - 2) * .32 + (station.x < 0 ? -Math.PI / 2 : Math.PI / 2);
        addBox(spot, '#59656a', [9, 3.2, 3.4], [Math.sin(angle) * 24, 1.6, Math.cos(angle) * 24], standard('#59656a', .95, .02)).rotation.y = angle;
      }
    }
    const plane = new THREE.PlaneGeometry(9, 9);
    const uv = plane.getAttribute('uv');
    for (let index = 0; index < uv.count; index += 1) uv.setX(index, (station.index % cells + uv.getX(index)) / cells);
    const number = new THREE.Mesh(plane, numberMaterial);
    number.rotation.x = -Math.PI / 2; number.position.set(0, 1.3, repair ? 9 : 14); spot.add(number);
  }
  mergeStaticMeshes(group, [], new Set([numberMaterial]));
  return {
    group,
    dispose() { scene.remove(group); disposeTree(group); textures.forEach((texture) => texture.dispose()); },
  };
}

/* ------------------------------------------------------------- ground unit */

/** A wheeled anti-aircraft unit: twin flak cannons and a SAM pod on a turret. Authored in FLIGHT_SCALE units. */
export function makeGroundUnit(team: Team) {
  const unit = new THREE.Group();
  unit.scale.setScalar(FLIGHT_SCALE);
  const hull = standard('#3d4f3f', .7, .35);
  const dark = standard('#1a2226', .6, .5);
  const teamMaterial = basic(TEAM_MATERIALS[team]);
  const body = new THREE.Group(); unit.add(body);
  addBox(body, '#3d4f3f', [10, 2.6, 16], [0, 3.3, 0], hull);
  addBox(body, '#3d4f3f', [8.6, 1.6, 6], [0, 5.2, 5], hull);
  addBox(body, '#1a2226', [10.4, .5, 16.4], [0, 2, 0], dark);
  addBox(body, TEAM_MATERIALS[team], [10.2, .5, 2], [0, 4.4, -7.2], teamMaterial);
  for (const side of [-1, 1]) for (const z of [-5.4, 0, 5.4]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 1.4, 12), dark);
    wheel.rotation.z = Math.PI / 2; wheel.position.set(side * 5.4, 1.7, z); wheel.castShadow = true; body.add(wheel);
  }
  // Turret: yaws. Gun cradle: pitches.
  const turret = new THREE.Group(); turret.position.y = 5.2; body.add(turret);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 4, 1.2, 14), dark);
  ring.position.y = .6; turret.add(ring);
  addBox(turret, '#46594a', [6.4, 3, 5.6], [0, 2.5, 0], hull);
  addBox(turret, TEAM_MATERIALS[team], [6.5, .45, 5.7], [0, 3.6, 0], teamMaterial);
  // SAM pod on the left, radar on the back.
  const pod = new THREE.Group(); pod.position.set(-4.6, 2.8, 0); turret.add(pod);
  addBox(pod, '#2b3a30', [2.6, 2.6, 5], [0, 0, 0], hull);
  for (const [x, y] of [[-.6, -.6], [.6, -.6], [-.6, .6], [.6, .6]]) {
    const tube = new THREE.Mesh(new THREE.CircleGeometry(.45, 10), basic('#d8e2e6'));
    tube.position.set(x, y, 2.52); pod.add(tube);
  }
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(1.8, .4, .5, 12), standard('#b9c7cc', .4, .6));
  dish.rotation.x = Math.PI / 2.4; dish.position.set(0, 5, -3.4); turret.add(dish);
  const cradle = new THREE.Group(); cradle.position.set(.8, 3, .8); turret.add(cradle);
  addBox(cradle, '#1a2226', [3.2, 2, 2.6], [0, 0, 0], dark);
  for (const side of [-1, 1]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.32, .42, 9, 8), dark);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(side * 1, 0, 5.4); barrel.castShadow = true; cradle.add(barrel);
  }
  const flashMaterial = new THREE.MeshBasicMaterial({ color: '#ffd38a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1.3, 8, 6), flashMaterial);
  flash.position.set(0, 0, 10.4); flash.scale.set(1.6, 1, 2.4); cradle.add(flash);
  mergeStaticMeshes(cradle, [flash]);
  mergeStaticMeshes(turret, [cradle]);
  mergeStaticMeshes(body, [turret]);
  // Repair beam to the tower, shown while a repair is in progress.
  const beamMaterial = new THREE.MeshBasicMaterial({ color: '#5dffa4', transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(.5, .5, 1, 8, 1, true).translate(0, .5, 0), beamMaterial);
  beam.visible = false; unit.add(beam);
  unit.userData = { body, turret, cradle, flashMaterial, heading: 0, flashUntil: 0, alive: true, hull, beam, beamMaterial };
  return unit;
}

const deadTint = new THREE.Color('#151515');

const beamStart = new THREE.Vector3();
const beamDirection = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Points the repair beam at a world position (the tower being repaired), or hides it. */
export function setRepairBeam(unit: THREE.Group, target: { x: number; y: number; z: number } | null, now: number) {
  const { beam, beamMaterial } = unit.userData as { beam: THREE.Mesh; beamMaterial: THREE.MeshBasicMaterial };
  beam.visible = Boolean(target);
  if (!target) return;
  // The beam is a child of the unit (scaled by FLIGHT_SCALE, never rotated), so work in its local space.
  beamStart.set(0, 9, 0);
  beamDirection.set((target.x - unit.position.x) / FLIGHT_SCALE, target.y / FLIGHT_SCALE - 9, (target.z - unit.position.z) / FLIGHT_SCALE);
  const length = beamDirection.length();
  beam.position.copy(beamStart);
  beam.quaternion.setFromUnitVectors(UP, beamDirection.normalize());
  beam.scale.set(1 + Math.sin(now * .03) * .3, length, 1 + Math.sin(now * .03) * .3);
  beamMaterial.opacity = .45 + Math.sin(now * .02) * .25;
}

/** Places a ground unit: the hull follows its drive, the turret its gun. */
export function updateGroundUnit(unit: THREE.Group, player: JetState, dt: number, now: number) {
  const data = unit.userData as { body: THREE.Group; turret: THREE.Group; cradle: THREE.Group; flashMaterial: THREE.MeshBasicMaterial; heading: number; flashUntil: number; alive: boolean; lastX?: number; lastZ?: number };
  if (data.lastX !== undefined && data.lastZ !== undefined) {
    const dx = player.x - data.lastX; const dz = player.z - data.lastZ;
    // Face the way it's driving.
    if (dx * dx + dz * dz > 1) data.heading = Math.atan2(dx, dz);
  } else {
    data.heading = Math.atan2(-Math.sign(player.x), 0);
  }
  data.lastX = player.x; data.lastZ = player.z;
  unit.position.set(player.x, 0, player.z);
  const turn = data.heading - data.body.rotation.y;
  data.body.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * Math.min(1, dt * 4);
  if (player.alive) {
    const want = player.yaw - data.body.rotation.y;
    data.turret.rotation.y = Math.atan2(Math.sin(want), Math.cos(want));
    data.cradle.rotation.x = -player.pitch;
    data.body.rotation.z = 0;
  } else {
    // Knocked out: slumped, guns down.
    data.cradle.rotation.x = .15;
    data.body.rotation.z = .12;
  }
  if (data.alive !== player.alive) {
    data.alive = player.alive;
    unit.traverse((object) => {
      const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!material || !(material instanceof THREE.MeshStandardMaterial)) return;
      if (!material.userData.original) material.userData.original = material.color.clone();
      material.color.copy(player.alive ? material.userData.original : deadTint);
    });
  }
  data.flashMaterial.opacity = now < data.flashUntil ? .9 : 0;
}

export function flashGroundUnit(unit: THREE.Group, now: number) {
  (unit.userData as { flashUntil: number }).flashUntil = now + 45;
}

/** Height of the gun above the deck, for cameras. */
export const GUN_HEIGHT = GROUND.gunHeight;
export const TOWER_HEIGHT = TOWER.height;
