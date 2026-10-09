import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ARENA, ARENA_SCALE, DEFAULT_ARENA_ID, FLIGHT_SCALE, GROUND, JET_FLIGHT, METERS_PER_UNIT, PROJECTILE_SPEED, TOWER, type ArenaId, type JetModel, type ProjectileKind, type RoomState, type Team } from '@/lib/protocol';
import { createParticleField } from '@/lib/particles';
import { sfx } from '@/lib/sfx';
import {
  addAtmosphericSky, addBox, addLine, ARENA_PALETTES, basic, createImpact, createSurfaceMaps, detailedStandard,
  mergeStaticMeshes, standard, TEAM_COLORS, TEAM_MATERIALS, type SurfaceMaps,
} from '@/lib/arena-kit';
import { buildSkyforge, type ArenaLighting, type SkyforgeHandle } from '@/lib/skyforge';
import { attachTrails, detachTrails, makeJet, updateJet } from '@/lib/jets';
import { buildStations, buildTower, disposeTree, flashGroundUnit, makeGroundUnit, setRepairBeam, updateGroundUnit, type TowerObject } from '@/lib/defences';

/** The two airfields at each end are scenery; the towers are the objective. */
type AirportSpot = { id: string; team: Team; x: number; z: number };
export type ReadAim = () => { yaw: number; pitch: number } | null;
/** Which player the camera should follow (you, or the teammate you chose to spectate). */
export type ReadViewId = () => string | null;

/** Every arena exposes the same surface so `mountArena` stays arena-agnostic. */
type StadiumHandle = SkyforgeHandle;
function addMesaScenery(scene: THREE.Scene) {
  const cliff = standard('#a95138', .96, .02);
  const cliffShade = standard('#713d33', .95, .02);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(36, 128, ARENA.halfDepth * 2 + 120), cliff);
    wall.position.set(side * 520, 30, 0); wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
    for (let index = 0; index < 7; index += 1) {
      const z = -330 + index * 110;
      const spire = new THREE.Mesh(new THREE.ConeGeometry(30 + (index % 3) * 9, 80 + (index % 2) * 54, 6), index % 2 ? cliffShade : cliff);
      spire.position.set(side * (492 + (index % 2) * 35), 58, z); spire.rotation.z = side * -.08; spire.castShadow = true; scene.add(spire);
    }
  }
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(ARENA.halfWidth * 2 + 100, 115, 30), cliffShade);
    wall.position.set(0, 22, side * 414); wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
  }
  const beaconMaterial = new THREE.MeshBasicMaterial({ color: '#ffb172' });
  for (const side of [-1, 1]) for (const z of [-350, 0, 350]) {
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(2, 3.2, 25, 8), standard('#553c38', .45, .5));
    beacon.position.set(side * 448, 12.5, z); scene.add(beacon);
    const light = new THREE.Mesh(new THREE.SphereGeometry(3.5, 8, 6), beaconMaterial);
    light.position.set(side * 448, 27, z); scene.add(light);
  }
}

function addFjordScenery(scene: THREE.Scene) {
  const ice = standard('#5ca0bc', .3, .32);
  const deepIce = standard('#326b88', .34, .38);
  const ridgeMaterial = standard('#d8f5ff', .25, .24);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(30, 135, ARENA.halfDepth * 2 + 140), side < 0 ? ice : deepIce);
    wall.position.set(side * 520, 34, 0); wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
    for (let index = 0; index < 9; index += 1) {
      const crystal = new THREE.Mesh(new THREE.ConeGeometry(17 + (index % 3) * 7, 78 + (index % 4) * 23, 5), index % 2 ? ice : ridgeMaterial);
      crystal.position.set(side * (493 + (index % 2) * 24), 40, -355 + index * 88); crystal.rotation.z = side * .08; crystal.castShadow = true; scene.add(crystal);
    }
  }
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(ARENA.halfWidth * 2 + 100, 120, 28), side < 0 ? deepIce : ice);
    wall.position.set(0, 25, side * 410); wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
    for (let index = 0; index < 8; index += 1) {
      const crystal = new THREE.Mesh(new THREE.ConeGeometry(18 + (index % 3) * 8, 70 + (index % 2) * 42, 5), ridgeMaterial);
      crystal.position.set(-430 + index * 123, 35, side * 388); crystal.rotation.z = (index % 2 ? .12 : -.1); crystal.castShadow = true; scene.add(crystal);
    }
  }
}


/**
 * Red Mesa and Ice Fjord: open ranges with the same play volume but natural
 * scenery instead of the Skyforge superstructure.
 */
function buildOpenRange(scene: THREE.Scene, arenaId: ArenaId, surfaces: SurfaceMaps): StadiumHandle {
  const palette = ARENA_PALETTES[arenaId];
  const boundaryLights: THREE.Mesh[] = [];
  let boundaryWarningUntil = 0;

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(ARENA.halfWidth * 2 + 25, 10, ARENA.halfDepth * 2 + 25),
    detailedStandard(palette.floor, .88, .08, surfaces, 'asphalt'),
  );
  floor.position.y = -6;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(ARENA.halfWidth * 2, 36, palette.grid, palette.gridMinor);
  grid.position.y = -.85;
  grid.scale.z = ARENA.halfDepth / ARENA.halfWidth;
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
  gridMaterials.forEach((material, index) => { material.transparent = true; material.opacity = index === 0 ? .12 : .055; });
  scene.add(grid);

  for (const radius of [66, 142, 220]) {
    const points = Array.from({ length: 97 }, (_, index) => {
      const angle = (index / 96) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle) * radius, -.72, Math.sin(angle) * radius);
    });
    addLine(scene, points, radius === 142 ? palette.ring : palette.grid, radius === 142 ? .32 : .12);
  }
  const centerMark = new THREE.Mesh(
    new THREE.CircleGeometry(18, 48),
    new THREE.MeshBasicMaterial({ color: palette.ring, transparent: true, opacity: .08, side: THREE.DoubleSide }),
  );
  centerMark.rotation.x = -Math.PI / 2;
  centerMark.position.y = -.7;
  scene.add(centerMark);

  if (arenaId === 'red-mesa') addMesaScenery(scene); else addFjordScenery(scene);

  const wallMat = new THREE.MeshBasicMaterial({ color: palette.boundary, transparent: true, opacity: .045, side: THREE.DoubleSide, depthWrite: false });
  for (const side of [-1, 1]) {
    const xWall = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.halfDepth * 2, ARENA.maxAltitude - ARENA.minAltitude), wallMat);
    xWall.rotation.y = Math.PI / 2;
    xWall.position.set(side * (ARENA.halfWidth - 12), (ARENA.maxAltitude + ARENA.minAltitude) / 2, 0);
    scene.add(xWall);
    const zWall = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.halfWidth * 2, ARENA.maxAltitude - ARENA.minAltitude), wallMat);
    zWall.position.set(0, (ARENA.maxAltitude + ARENA.minAltitude) / 2, side * (ARENA.halfDepth - 12));
    scene.add(zWall);
  }
  const boundary = [
    new THREE.Vector3(-ARENA.halfWidth + 24, 40, -ARENA.halfDepth + 24), new THREE.Vector3(ARENA.halfWidth - 24, 40, -ARENA.halfDepth + 24),
    new THREE.Vector3(ARENA.halfWidth - 24, 40, ARENA.halfDepth - 24), new THREE.Vector3(-ARENA.halfWidth + 24, 40, ARENA.halfDepth - 24),
    new THREE.Vector3(-ARENA.halfWidth + 24, 40, -ARENA.halfDepth + 24),
  ];
  addLine(scene, boundary, palette.boundary, .8);
  addLine(scene, boundary.map((point) => new THREE.Vector3(point.x, ARENA.maxAltitude, point.z)), palette.boundary, .38);
  for (let index = 0; index < boundary.length - 1; index += 1) {
    addLine(scene, [boundary[index], new THREE.Vector3(boundary[index].x, ARENA.maxAltitude, boundary[index].z)], palette.boundary, .25);
  }
  const perimeterLampGeometry = new THREE.BoxGeometry(5, 2.4, 8);
  const boundaryHex = `#${palette.boundary.toString(16).padStart(6, '0')}`;
  for (let index = 0; index < 26; index += 1) {
    const x = -ARENA.halfWidth + 40 + index * ((ARENA.halfWidth * 2 - 80) / 25);
    const marker = new THREE.Mesh(perimeterLampGeometry, basic(index % 2 ? '#ef334b' : boundaryHex));
    marker.position.set(x, 325, -ARENA.halfDepth + 10); scene.add(marker);
    const mirror = marker.clone(); mirror.position.z *= -1; scene.add(mirror);
    boundaryLights.push(marker, mirror);
    const z = -ARENA.halfDepth + 40 + index * ((ARENA.halfDepth * 2 - 80) / 25);
    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(perimeterLampGeometry, basic(index % 2 ? '#ef334b' : boundaryHex));
      edge.position.set(side * (ARENA.halfWidth - 10), 325, z); scene.add(edge); boundaryLights.push(edge);
    }
  }

  return {
    draw() { /* open ranges carry no scoreboard */ },
    update(nowMs) {
      const warning = nowMs < boundaryWarningUntil;
      boundaryLights.forEach((lamp, index) => {
        const material = lamp.material as THREE.MeshBasicMaterial;
        const pulse = warning ? .45 + .55 * Math.abs(Math.sin(nowMs * .014)) : .58 + .28 * Math.sin(nowMs * .002 + index * .22);
        material.color.set(warning ? '#ff435b' : (index % 3 === 0 ? '#ef5266' : boundaryHex));
        lamp.scale.y = warning ? 1.4 + pulse : .75 + pulse;
      });
    },
    signalBoundary() { boundaryWarningUntil = performance.now() + 1_800; },
    reportImpact() { /* no destructible scenery on the open ranges */ },
    raiseAlarm() { boundaryWarningUntil = performance.now() + 1_800; },
    dispose() { /* geometry is released by the scene sweep in mountArena */ },
  };
}
function buildAirport(scene: THREE.Scene, base: AirportSpot, surfaces: SurfaceMaps) {
  const group = new THREE.Group();
  group.position.set(base.x, 0, base.z);
  group.scale.setScalar(ARENA_SCALE);
  if (base.team === 'ember') group.rotation.y = Math.PI;
  scene.add(group);
  const team = TEAM_COLORS[base.team];
  const padMat = detailedStandard('#354853', .9, .08, surfaces, 'asphalt');
  const runway = new THREE.Mesh(new THREE.BoxGeometry(164, 2, 92), padMat);
  runway.position.set(0, 1, -95); runway.receiveShadow = true; group.add(runway);
  const stripeMat = new THREE.MeshBasicMaterial({ color: '#d7e2e8' });
  for (let i = 0; i < 13; i += 1) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(4.8, .28, 2.2), stripeMat);
    stripe.position.set(-58 + i * 9.6, 2.12, -95); group.add(stripe);
  }
  const thresholdMat = new THREE.MeshBasicMaterial({ color: team });
  for (const x of [-73, 73]) {
    for (let i = 0; i < 6; i += 1) {
      const mark = new THREE.Mesh(new THREE.BoxGeometry(2.1, .35, 7), thresholdMat);
      mark.position.set(x, 2.2, -123 + i * 11.2); group.add(mark);
    }
  }
  const taxiway = new THREE.Mesh(new THREE.BoxGeometry(38, 1.5, 88), detailedStandard('#425763', .9, .08, surfaces, 'asphalt'));
  taxiway.position.set(-72, .8, -48); taxiway.receiveShadow = true; group.add(taxiway);
  const apron = new THREE.Mesh(new THREE.BoxGeometry(98, 1.5, 70), detailedStandard('#3f5661', .9, .08, surfaces, 'concrete'));
  apron.position.set(-2, .8, 102); apron.receiveShadow = true; group.add(apron);
  const taxiLine = new THREE.Mesh(new THREE.BoxGeometry(2, .15, 74), new THREE.MeshBasicMaterial({ color: '#f1cd72' }));
  taxiLine.position.set(-72, 1.65, -48); group.add(taxiLine);

  for (const x of [-74, 74]) {
    for (let i = 0; i < 13; i += 1) {
      const light = new THREE.Mesh(new THREE.SphereGeometry(1.35, 8, 6), new THREE.MeshBasicMaterial({ color: i === 0 || i === 12 ? team : '#b7f2ff' }));
      light.position.set(x, 2.1, -134 + i * 6.5); group.add(light);
    }
  }

  for (const z of [76, 128]) {
    addBox(group, '#526979', [38, 18, 34], [30, 10, z], detailedStandard('#526979', .72, .28, surfaces, 'concrete'));
    addBox(group, '#233b4c', [42, 3, 38], [30, 20.5, z], detailedStandard('#29495e', .52, .48, surfaces, 'steel'));
    addBox(group, '#142a39', [1.2, 12, 24], [49.8, 7, z], standard('#142a39', .58, .32));
    addBox(group, team, [1.8, 2.4, 24], [50.8, 14.2, z], new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: .9 }));
    for (const side of [-1, 1]) addBox(group, '#9ed7e5', [1.5, 5.5, 3], [50.9, 8, z + side * 13], new THREE.MeshBasicMaterial({ color: '#a8eaff' }));
  }

  // Additional covered shelters, revetments and apron lights give each team a
  // recognizable forward operating base without filling the central airspace.
  for (const [index, z] of [58, 112, 166].entries()) {
    const shelter = new THREE.Group(); shelter.position.set(-62, 0, z); group.add(shelter);
    addBox(shelter, '#344b5a', [48, 15, 37], [0, 8, 0], detailedStandard('#344b5a', .68, .3, surfaces, 'concrete'));
    addBox(shelter, '#526c7b', [54, 3, 43], [0, 16.5, 0], detailedStandard('#526c7b', .5, .52, surfaces, 'steel'));
    for (const side of [-1, 1]) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(18.5, 1.15, 8, 28, Math.PI), standard('#8297a0', .4, .7));
      rib.rotation.z = side > 0 ? 0 : Math.PI; rib.position.set(0, 16, side * 18.5); shelter.add(rib);
    }
    addBox(shelter, '#142c3b', [1.4, 11, 29], [24.8, 7, 0], standard('#142c3b', .48, .54));
    addBox(shelter, team, [1.2, 2.2, 25], [25.8, 13, 0], new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: .86 }));
    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 6), new THREE.MeshBasicMaterial({ color: team }));
      lamp.position.set(side * 28, 2, z > 100 ? z - 18 : z + 18); group.add(lamp);
    }
    if (index === 1) addBox(shelter, '#d9f7ff', [2, 7, 17], [-26, 9, 0], new THREE.MeshBasicMaterial({ color: '#d9f7ff' }));
  }

  const corePad = new THREE.Mesh(new THREE.CylinderGeometry(30, 36, 7, 12), detailedStandard('#263f4c', .62, .34, surfaces, 'steel'));
  corePad.position.set(0, 4, 0); corePad.castShadow = true; corePad.receiveShadow = true; group.add(corePad);
  const coreOuter = new THREE.Mesh(new THREE.CylinderGeometry(17, 22, 38, 12), detailedStandard('#526b76', .4, .58, surfaces, 'steel'));
  coreOuter.position.set(0, 25, 0); coreOuter.castShadow = true; group.add(coreOuter);
  const coreMaterial = new THREE.MeshStandardMaterial({ color: team, emissive: team, emissiveIntensity: 1.25, roughness: .14, metalness: .44, transparent: true, opacity: .88 });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(13, 1), coreMaterial);
  core.position.set(0, 28, 0); core.rotation.y = Math.PI / 8; core.castShadow = true; group.add(core);
  const coreRing = new THREE.Mesh(new THREE.TorusGeometry(25, 1.25, 8, 36), new THREE.MeshBasicMaterial({ color: team }));
  coreRing.rotation.x = Math.PI / 2; coreRing.position.set(0, 9, 0); group.add(coreRing);
  for (const side of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.8, 36, 8), standard('#8da2aa', .28, .74));
    strut.position.set(side * 24, 23, 0); group.add(strut);
    addBox(group, '#152e3e', [12, 3, 3], [side * 19, 41, 0], standard('#152e3e', .4, .68));
  }
  const coreSign = addBox(group, '#122b3a', [36, 10, 2], [0, 52, 11], standard('#122b3a', .35, .5));
  const coreLabelCanvas = document.createElement('canvas'); coreLabelCanvas.width = 512; coreLabelCanvas.height = 128;
  const coreLabelContext = coreLabelCanvas.getContext('2d');
  if (coreLabelContext) {
    coreLabelContext.fillStyle = '#071725'; coreLabelContext.fillRect(0, 0, 512, 128);
    coreLabelContext.fillStyle = TEAM_MATERIALS[base.team]; coreLabelContext.fillRect(0, 0, 10, 128);
    coreLabelContext.fillStyle = '#effbff'; coreLabelContext.font = '700 52px Rajdhani, sans-serif'; coreLabelContext.fillText('BASE CORE', 30, 70);
    coreLabelContext.fillStyle = TEAM_MATERIALS[base.team]; coreLabelContext.font = '600 24px Rajdhani, sans-serif'; coreLabelContext.fillText(`${base.team.toUpperCase()} COMMAND`, 32, 104);
  }
  const coreTexture = new THREE.CanvasTexture(coreLabelCanvas); coreTexture.colorSpace = THREE.SRGBColorSpace;
  coreSign.material = new THREE.MeshBasicMaterial({ map: coreTexture, toneMapped: false });

  const radarTower = new THREE.Group(); radarTower.position.set(-76, 0, 170); group.add(radarTower);
  const radarMast = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.4, 32, 8), standard('#8399a2', .36, .72));
  radarMast.position.y = 16; radarTower.add(radarMast);
  const radarDish = new THREE.Mesh(new THREE.SphereGeometry(11, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), standard('#b7cbd2', .25, .8));
  radarDish.position.y = 34; radarDish.rotation.x = -Math.PI / 2.6; radarTower.add(radarDish);
  radarTower.userData.spin = true;

  const fuelMaterial = detailedStandard('#647985', .44, .42, surfaces, 'steel');
  for (const x of [-85, -75]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 28, 16), fuelMaterial);
    tank.position.set(x, 14, -104); tank.castShadow = true; group.add(tank);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(11, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), fuelMaterial);
    dome.position.set(x, 28, -104); group.add(dome);
    const band = new THREE.Mesh(new THREE.TorusGeometry(11.2, .65, 6, 24), new THREE.MeshBasicMaterial({ color: team }));
    band.rotation.x = Math.PI / 2; band.position.set(x, 19, -104); group.add(band);
  }
  for (const [x, z] of [[-112, 22], [-112, 48]] as const) {
    addBox(group, '#283e4b', [22, 14, 19], [x, 7, z], standard('#283e4b', .42, .68));
    addBox(group, '#425966', [24, 2.2, 21], [x, 15, z], standard('#425966', .36, .7));
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 8, 8), standard('#182c37', .4, .58));
    vent.position.set(x - 5, 19, z); group.add(vent);
    const status = new THREE.Mesh(new THREE.BoxGeometry(1.1, 8, 8), new THREE.MeshBasicMaterial({ color: team }));
    status.position.set(x + 11.7, 8, z); group.add(status);
  }

  for (const [x, z] of [[-38, -20], [38, -20], [0, 185]] as const) {
    const turret = new THREE.Group(); turret.position.set(x, 0, z); group.add(turret);
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(7, 9, 5, 10), standard('#354d5b', .4, .68));
    plinth.position.y = 2.5; turret.add(plinth);
    const housing = new THREE.Mesh(new THREE.SphereGeometry(4.2, 12, 8), standard('#526a77', .34, .68));
    housing.position.y = 6; turret.add(housing);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.85, 1.1, 13, 8), standard('#172a36', .28, .65));
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 7, 7); turret.add(barrel);
    const optic = new THREE.Mesh(new THREE.SphereGeometry(1.25, 8, 6), new THREE.MeshBasicMaterial({ color: team }));
    optic.position.set(0, 8, 3); turret.add(optic);
  }


  addBox(group, '#465d6d', [19, 34, 19], [-65, 18, -48]);
  addBox(group, '#738b98', [27, 8, 27], [-65, 39, -48]);
  addBox(group, '#19394b', [28, 8, 28], [-65, 47, -48], new THREE.MeshStandardMaterial({ color: '#4cc9f0', emissive: team, emissiveIntensity: .2, roughness: .3, metalness: .45, transparent: true, opacity: .85 }));
  addBox(group, team, [3, 2, 30], [-65, 53, -48], new THREE.MeshBasicMaterial({ color: team }));
  for (const side of [-1, 1]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(.7, 1.1, 17, 8), standard('#778b96', .45, .45));
    mast.position.set(side * 78, 8.5, -50); group.add(mast);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(2, 10, 8), new THREE.MeshBasicMaterial({ color: team }));
    beacon.position.set(side * 78, 18, -50); group.add(beacon);
  }
  group.userData.core = core;
  group.userData.coreMaterial = coreMaterial;
  group.userData.coreRing = coreRing;
  group.userData.radarTower = radarTower;
  group.userData.coreTexture = coreTexture;
  mergeStaticMeshes(group, [core, coreRing, radarTower, coreSign]);
  return group;
}

/**
 * 4x MSAA smooths edges but, on integrated GPUs, multisampling a framebuffer
 * this full of transparency costs enough bandwidth to drop flight below 60fps
 * (measured: night flight 45-57fps with it, a steady 60 without). Flip this on
 * for discrete GPUs if edge quality matters more than headroom.
 */
const MSAA = false;

/**
 * The whole post chain after bloom in ONE full-screen pass: ACES tone mapping
 * and sRGB (what OutputPass did), a colour grade, and FXAA. FXAA samples the
 * neighbourhood, so each sample is tone-mapped on the fly. On integrated GPUs
 * each full-screen pass costs ~1ms, and this replaces three of them.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    toneMappingExposure: { value: 1 },
    contrast: { value: 1.08 },
    saturation: { value: 1.12 },
    vignette: { value: .32 },
  },
  vertexShader: `varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float contrast;
    uniform float saturation;
    uniform float vignette;
    varying vec2 vUv;
    #define HDR_CEILING 32.0
    // ACESFilmicToneMapping, sRGBTransferOETF and toneMappingExposure come from
    // three.js, which prepends them to every ShaderMaterial.
    vec3 sanitizeHdr(vec3 c) {
      c = clamp(c, vec3(0.0), vec3(HDR_CEILING));
      return dot(c, vec3(1.0)) < HDR_CEILING * 3.5 ? c : vec3(0.0);
    }
    vec3 display(vec2 uv) {
      vec3 color = ACESFilmicToneMapping(sanitizeHdr(texture2D(tDiffuse, uv).rgb));
      return sRGBTransferOETF(vec4(color, 1.0)).rgb;
    }
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {
      vec3 nw = display(vUv + vec2(-1.0, -1.0) * resolution);
      vec3 ne = display(vUv + vec2(1.0, -1.0) * resolution);
      vec3 sw = display(vUv + vec2(-1.0, 1.0) * resolution);
      vec3 se = display(vUv + vec2(1.0, 1.0) * resolution);
      vec3 m = display(vUv);
      float lNW = luma(nw); float lNE = luma(ne); float lSW = luma(sw); float lSE = luma(se); float lM = luma(m);
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      vec3 color = m;
      // Only smooth real edges: flat areas skip the extra taps entirely.
      if (lMax - lMin > max(0.0312, lMax * 0.125)) {
        vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
        float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
        float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
        dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * resolution;
        vec3 a = 0.5 * (display(vUv + dir * (1.0 / 3.0 - 0.5)) + display(vUv + dir * (2.0 / 3.0 - 0.5)));
        vec3 b = a * 0.5 + 0.25 * (display(vUv - dir * 0.5) + display(vUv + dir * 0.5));
        float lB = luma(b);
        color = (lB < lMin || lB > lMax) ? a : b;
      }
      float grey = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(grey), color, saturation);
      color = (color - 0.5) * contrast + 0.5;
      vec2 offset = (vUv - 0.5) * vec2(1.0, 0.82);
      color *= mix(1.0 - vignette, 1.0, smoothstep(0.78, 0.22, length(offset)));
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }`,
};

export function mountArena(host: HTMLDivElement, readState: () => RoomState | null, readSelfId: () => string, mode: 'arena' | 'training' = 'arena', onError?: (error: unknown) => void, readAim?: ReadAim, readViewId?: ReadViewId) {
  const arenaId = readState()?.arenaId ?? DEFAULT_ARENA_ID;
  const palette = ARENA_PALETTES[arenaId];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(palette.background);
  scene.fog = new THREE.FogExp2(palette.background, .00056 / ARENA_SCALE);
  const camera = new THREE.PerspectiveCamera(62, 1, 1.5, 4_800 * ARENA_SCALE);
  // Start from the inner flight bowl so the first scene view reads as an
  // enclosed arena, not an exterior fly-by of the stadium shell.
  camera.position.set(0, 78 * ARENA_SCALE, 268 * ARENA_SCALE);
  camera.lookAt(0, 165 * ARENA_SCALE, -40 * ARENA_SCALE);
  // Reversed depth keeps precision across the 80k+ unit view (falls back to
  // standard depth where EXT_clip_control is unavailable).
  const renderer = new THREE.WebGLRenderer({ antialias: MSAA, powerPreference: 'high-performance', alpha: false, reversedDepthBuffer: true });
  // CSS-pixel resolution. On displays scaled to 125-150% this renders ~36-56%
  // fewer pixels than native, a large fill-rate saving for little softness.
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .95;
  // Post-processing. Bloom runs on the half-float HDR buffer before tone
  // mapping, so only genuinely bright things — lamps, LEDs, the reactor,
  // afterburners, the sun — glow. FXAA replaces the MSAA we can't afford.
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), .45, .3, 1.35);
  // Quarter resolution: a soft glow doesn't need detail, and it halves the cost.
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (width: number, height: number) => bloomSetSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  // A single NaN or near-infinite pixel (a specular glint on a thin rail can hit
  // either) gets blurred by bloom over its smallest mip, which covers the whole
  // screen, and the frame goes black. That was the in-flight flicker. Clamp
  // what goes into bloom so one bad pixel stays one pixel.
  bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace(
    'vec4 texel = texture2D( tDiffuse, vUv );',
    'vec4 texel = texture2D( tDiffuse, vUv ); texel.rgb = clamp( texel.rgb, vec3( 0.0 ), vec3( 32.0 ) ); if ( !( dot( texel.rgb, vec3( 1.0 ) ) < 112.0 ) ) texel.rgb = vec3( 0.0 );',
  );
  composer.addPass(bloom);
  const finalPass = new ShaderPass(FinalShader);
  composer.addPass(finalPass);
  renderer.setClearColor(palette.background, 1);
  renderer.domElement.className = 'arena-canvas';
  host.appendChild(renderer.domElement);

  const sky = addAtmosphericSky(scene, arenaId);
  const hemisphere = new THREE.HemisphereLight(0xb8d7e7, 0x202630, 1.05);
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight(0xffe2bd, 4.2);
  sun.position.set(-180 * ARENA_SCALE, 420 * ARENA_SCALE, 170 * ARENA_SCALE); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -ARENA.halfWidth; sun.shadow.camera.right = ARENA.halfWidth; sun.shadow.camera.top = ARENA.halfDepth; sun.shadow.camera.bottom = -ARENA.halfDepth;
  sun.shadow.camera.near = .5; sun.shadow.camera.far = 1_400 * ARENA_SCALE; sun.shadow.bias = -.0005; sun.shadow.normalBias = 3; sun.shadow.radius = 4;
  scene.add(sun);
  const ambient = new THREE.AmbientLight(0x7897b4, .28);
  scene.add(ambient);
  const lighting: ArenaLighting = { scene, renderer, sky, sun, hemisphere, ambient };

  let stadium: StadiumHandle | undefined;
  let surfaceMaps: SurfaceMaps | undefined;
  let environmentMap: THREE.Texture | undefined;
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  // A scene holding just the sky, sharing its material, to bake reflections from.
  const skyOnly = new THREE.Scene();
  skyOnly.add(new THREE.Mesh(sky.mesh.geometry, sky.mesh.material));
  let lastEnvironmentAt = -Infinity;
  const refreshEnvironment = () => {
    const baked = pmremGenerator.fromScene(skyOnly, 0, 1, 4_800 * ARENA_SCALE).texture;
    scene.environment = baked;
    environmentMap?.dispose();
    environmentMap = baked;
  };
  const jetObjects = new Map<string, THREE.Group>();
  const baseObjects = new Map<string, THREE.Group>();
  const projectileObjects = new Map<string, THREE.Object3D>();
  const previewBases: AirportSpot[] = [
    { id: 'azure-north', team: 'azure', x: -360 * ARENA_SCALE, z: -145 * ARENA_SCALE },
    { id: 'azure-south', team: 'azure', x: -360 * ARENA_SCALE, z: 145 * ARENA_SCALE },
    { id: 'ember-north', team: 'ember', x: 360 * ARENA_SCALE, z: -145 * ARENA_SCALE },
    { id: 'ember-south', team: 'ember', x: 360 * ARENA_SCALE, z: 145 * ARENA_SCALE },
  ];
  const towerObjects = new Map<string, TowerObject>();
  let stationSet: ReturnType<typeof buildStations> | undefined;
  let towerLayoutKey = '';
  // Projectiles share geometry and materials (flak fires ten rounds a second
  // per gun, so never build any per shot). Gun rounds are glowing tracer
  // streaks; missiles are bodies with fins, a motor flame and a smoke trail.
  const S = FLIGHT_SCALE;
  const shotParts = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>();
  const part = (key: string, make: () => { geometry: THREE.BufferGeometry; material: THREE.Material }) => {
    let found = shotParts.get(key);
    if (!found) { found = make(); shotParts.set(key, found); }
    return found;
  };
  const glowMaterial = (color: string, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const makeShot = (kind: ProjectileKind, team: Team): THREE.Object3D => {
    if (kind === 'cannon' || kind === 'flak') {
      const flak = kind === 'flak';
      const tint = flak ? '#ffb347' : team === 'azure' ? '#bff6ff' : '#ffc2b0';
      const look = part(`${kind}:${team}`, () => ({
        geometry: new THREE.CylinderGeometry((flak ? .55 : .42) * S, (flak ? .55 : .42) * S, (flak ? 12 : 30) * S, 6).rotateX(Math.PI / 2).translate(0, 0, (flak ? -6 : -15) * S),
        material: glowMaterial(tint, .95),
      }));
      const mesh = new THREE.Mesh(look.geometry, look.material);
      mesh.rotation.order = 'YXZ';
      return mesh;
    }
    const group = new THREE.Group();
    group.rotation.order = 'YXZ';
    const sam = kind === 'sam';
    const body = part(`${kind}:body`, () => ({ geometry: new THREE.CylinderGeometry(.42 * S, .42 * S, 7 * S, 8).rotateX(Math.PI / 2), material: new THREE.MeshStandardMaterial({ color: sam ? '#d9dfe3' : '#e8ecef', roughness: .5, metalness: .3 }) }));
    const nose = part(`${kind}:nose`, () => ({ geometry: new THREE.ConeGeometry(.42 * S, 1.8 * S, 8).rotateX(Math.PI / 2).translate(0, 0, 4.4 * S), material: new THREE.MeshStandardMaterial({ color: '#59636a', roughness: .4, metalness: .5 }) }));
    const fins = part(`${kind}:fins`, () => {
      const a = new THREE.BoxGeometry(2.4 * S, .08 * S, 1.1 * S).translate(0, 0, -3 * S);
      const b = new THREE.BoxGeometry(.08 * S, 2.4 * S, 1.1 * S).translate(0, 0, -3 * S);
      const geometry = new THREE.BufferGeometry();
      const merged = [a, b].map((g) => g.toNonIndexed());
      const positions = new Float32Array(merged.reduce((sum, g) => sum + g.attributes.position.array.length, 0));
      const normals = new Float32Array(positions.length);
      let offset = 0;
      for (const g of merged) { positions.set(g.attributes.position.array as Float32Array, offset); normals.set(g.attributes.normal.array as Float32Array, offset); offset += g.attributes.position.array.length; }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      return { geometry, material: new THREE.MeshStandardMaterial({ color: '#4c565c', roughness: .5, metalness: .4 }) };
    });
    const flame = part('rocket:flame', () => ({ geometry: new THREE.ConeGeometry(.55 * S, 5 * S, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -6.2 * S), material: glowMaterial('#ffb35c', .9) }));
    const glow = part('rocket:glow', () => ({ geometry: new THREE.SphereGeometry(1.1 * S, 10, 8).translate(0, 0, -3.9 * S), material: glowMaterial('#fff1c9', .95) }));
    for (const look of [body, nose, fins]) group.add(new THREE.Mesh(look.geometry, look.material));
    const flameMesh = new THREE.Mesh(flame.geometry, flame.material);
    const glowMesh = new THREE.Mesh(glow.geometry, glow.material);
    flameMesh.visible = false; glowMesh.visible = false;
    group.add(flameMesh, glowMesh);
    group.userData.flame = flameMesh; group.userData.glow = glowMesh;
    return group;
  };
  // Muzzle flashes at jet noses, one per jet, shown for a few frames after each round.
  const muzzleFlashGeometry = new THREE.SphereGeometry(1.6 * S, 8, 6);
  const muzzleFlashMaterial = glowMaterial('#ffe0a0', .95);
  const muzzleFlashes = new Map<string, { mesh: THREE.Mesh; until: number }>();
  const missileSmoke = createParticleField(scene, { capacity: 900, size: 6.5 * S, rise: 3 * S, drag: 1.1 });
  const burstSmoke = createParticleField(scene, { capacity: 500, size: 15 * S, rise: 1 * S, drag: 1.6 });
  const tail = new THREE.Vector3();
  const nosePoint = new THREE.Vector3();

  // Flak lead marker for a gunner: where to aim so the shells meet the jet.
  const leadMarker = new THREE.Mesh(
    new THREE.RingGeometry(.78, 1, 40),
    new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, opacity: .9, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
  );
  leadMarker.renderOrder = 2_000_000; leadMarker.visible = false; leadMarker.frustumCulled = false;
  scene.add(leadMarker);
  const leadPoint = new THREE.Vector3();
  const aimDirection = new THREE.Vector3();
  const flatAim = new THREE.Vector3();
  let hasGunnerCamera = false;

  // Damage and destruction effects: jet smoke and fire, tower smoke columns, sparks.
  const jetSmoke = createParticleField(scene, { capacity: 700, size: 26 * FLIGHT_SCALE, rise: 6 * FLIGHT_SCALE, drag: .9 });
  const fireField = createParticleField(scene, { capacity: 400, size: 12 * FLIGHT_SCALE, additive: true, rise: 10 * FLIGHT_SCALE, drag: 1.4 });
  const towerSmoke = createParticleField(scene, { capacity: 420, size: 34 * ARENA_SCALE, rise: 2 * ARENA_SCALE, drag: .25 });
  const sparkField = createParticleField(scene, { capacity: 500, size: 4 * FLIGHT_SCALE, additive: true, rise: -60 * FLIGHT_SCALE, drag: .6 });
  /** Tower destruction plays out over a few seconds: a chain of blasts down the shaft. */
  const destruction: { at: number; x: number; y: number; z: number; major: boolean }[] = [];
  const shaftOffset = new THREE.Vector3();
  const sparksAt = (x: number, y: number, z: number, count: number, speed: number) => {
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const lift = Math.random();
      sparkField.emit(x, y, z, Math.cos(angle) * speed * (1 - lift * .5), speed * (lift * 1.2 - .2), Math.sin(angle) * speed * (1 - lift * .5), .6 + Math.random() * .8, 1, .75 + Math.random() * .2, .35, 1);
    }
  };

  // HUD markers: names, distances and tower health drawn over the 3D view.
  const markerLayer = document.createElement('div');
  markerLayer.className = 'world-markers';
  host.appendChild(markerLayer);
  const markers = new Map<string, { element: HTMLDivElement; label: HTMLElement; detail: HTMLElement; text: string; sub: string; className: string; seen: number }>();
  const projected = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  let markerFrame = 0;
  const placeMarker = (id: string, x: number, y: number, z: number, text: string, sub: string, className: string, width: number, height: number) => {
    projected.set(x, y, z);
    cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const inFront = (x - camera.position.x) * cameraForward.x + (y - camera.position.y) * cameraForward.y + (z - camera.position.z) * cameraForward.z > 0;
    projected.project(camera);
    let marker = markers.get(id);
    if (!marker) {
      const element = document.createElement('div');
      const label = document.createElement('b');
      const detail = document.createElement('i');
      element.append(label, detail);
      markerLayer.appendChild(element);
      marker = { element, label, detail, text: '', sub: '', className: '', seen: 0 };
      markers.set(id, marker);
    }
    marker.seen = markerFrame;
    const visible = inFront && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
    if (!visible) { marker.element.style.display = 'none'; return; }
    marker.element.style.display = '';
    marker.element.style.transform = `translate3d(${((projected.x + 1) / 2 * width).toFixed(1)}px, ${((1 - projected.y) / 2 * height).toFixed(1)}px, 0)`;
    // Only touch the DOM text when it actually changes.
    if (marker.text !== text) { marker.text = text; marker.label.textContent = text; }
    if (marker.sub !== sub) { marker.sub = sub; marker.detail.textContent = sub; }
    if (marker.className !== className) { marker.className = className; marker.element.className = `world-marker ${className}`; }
  };
  const distanceLabel = (x: number, y: number, z: number) => {
    const meters = Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z) * METERS_PER_UNIT;
    return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} KM` : `${Math.round(meters / 50) * 50} M`;
  };
  let previewJets: { jet: THREE.Group; position: THREE.Vector3; yaw: number; pitch: number }[] = [];
  let sceneInitialized = false;
  let initializationFrame = 0;
  const initializeScene = () => {
    try {
      const environment = new RoomEnvironment();
      environmentMap = pmremGenerator.fromScene(environment).texture;
      environment.dispose();
      scene.environment = environmentMap;
      scene.environmentIntensity = .85;
      surfaceMaps = createSurfaceMaps();
      stadium = arenaId === 'skyforge'
        ? buildSkyforge(scene, surfaceMaps, lighting)
        : buildOpenRange(scene, arenaId, surfaceMaps);
      for (const base of previewBases) baseObjects.set(base.id, buildAirport(scene, base, surfaceMaps));
      previewJets = mode === 'training' ? [] : [
        // Anchored a fixed distance in front of the lobby camera (not scaled
        // with the arena), so the airframes stay on show at any stadium size.
        { jet: makeJet('azure', 'swift'), position: new THREE.Vector3(-34, 78 * ARENA_SCALE + 38, 268 * ARENA_SCALE - 150), yaw: Math.PI / 2 + .5, pitch: .08 },
        { jet: makeJet('ember', 'bastion'), position: new THREE.Vector3(62, 78 * ARENA_SCALE + 70, 268 * ARENA_SCALE - 250), yaw: -Math.PI / 2 - .4, pitch: -.05 },
      ];
      for (const preview of previewJets) {
        preview.jet.position.copy(preview.position);
        preview.jet.rotation.set(-preview.pitch, preview.yaw, preview.yaw > 0 ? -.35 : .3, 'YXZ');
        scene.add(preview.jet);
      }
      stadium.draw(readState() ?? undefined);
      // Warm up: three.js compiles shaders and uploads textures lazily, the
      // first time something is on screen, which stalls the first look at the
      // stands mid-flight. Do all of it now, behind the loading state.
      const textures = new Set<THREE.Texture>();
      scene.traverse((object) => {
        const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!material) return;
        for (const entry of Array.isArray(material) ? material : [material]) {
          for (const value of Object.values(entry)) if ((value as THREE.Texture | null)?.isTexture) textures.add(value as THREE.Texture);
        }
      });
      textures.forEach((texture) => renderer.initTexture(texture));
      renderer.compile(scene, camera);
      sceneInitialized = true;
    } catch (error: unknown) {
      onError?.(error);
    }
  };
  const resize = () => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    finalPass.material.uniforms.resolution.value.set(1 / width, 1 / height);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  let animation = 0;
  const desiredCamera = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const targetQuaternion = new THREE.Quaternion();
  const tempEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const jetGoal = new THREE.Vector3();
  const beamTarget = { x: 0, y: 0, z: 0 };
  const exhaust = new THREE.Vector3();
  /**
   * The simulation ticks at 30Hz but the screen draws at 60Hz+, and at combat
   * speed a jet moves about a full body length per tick. Rendering the raw
   * samples (or lerping toward them by a per-frame factor) makes everything
   * judder. Instead each object remembers its latest sample and when it
   * arrived, and is drawn where it would be NOW by extrapolating along its
   * heading — so motion is continuous between ticks.
   */
  type Track = { x: number; y: number; z: number; yaw: number; pitch: number; speed: number; at: number };
  const jetTracks = new Map<string, Track>();
  const shotTracks = new Map<string, Track>();
  const predicted = new THREE.Vector3();
  const heading = new THREE.Vector3();
  const sample = (tracks: Map<string, Track>, id: string, x: number, y: number, z: number, yaw: number, pitch: number, speed: number, now: number) => {
    const track = tracks.get(id);
    if (!track) {
      const fresh = { x, y, z, yaw, pitch, speed, at: now };
      tracks.set(id, fresh);
      return fresh;
    }
    if (track.x !== x || track.y !== y || track.z !== z) {
      track.x = x; track.y = y; track.z = z; track.yaw = yaw; track.pitch = pitch; track.speed = speed; track.at = now;
    }
    return track;
  };
  const extrapolate = (track: Track, now: number, out: THREE.Vector3) => {
    // Never run more than ~2 ticks ahead, so a stalled feed can't fling things.
    const ahead = Math.min(.07, Math.max(0, (now - track.at) / 1_000));
    heading.set(Math.sin(track.yaw) * Math.cos(track.pitch), Math.sin(track.pitch), Math.cos(track.yaw) * Math.cos(track.pitch));
    return out.set(track.x, track.y, track.z).addScaledVector(heading, track.speed * ahead);
  };
  // Frame-rate independent smoothing: the same feel at 60Hz or 144Hz.
  const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
  // The chase camera's own smoothed orientation. Following a quaternion (not
  // yaw/pitch angles) is what lets it ride through loops and rolls: at the top
  // of a loop yaw flips by 180°, which would whip an angle-based camera round.
  const cameraRig = new THREE.Quaternion();
  const cameraUp = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const cameraLift = new THREE.Vector3(0, 14, 0);
  let hasPilotCamera = false;
  const activeImpacts: ReturnType<typeof createImpact>[] = [];
  const seenEventIds = new Set<string>();
  let previousFrameAt = performance.now();
  let lastDisplayState = 'preview';
  const animate = () => {
    animation = requestAnimationFrame(animate);
    const now = performance.now();
    const frameDelta = Math.min(.05, Math.max(0, (now - previousFrameAt) / 1_000));
    previousFrameAt = now;
    const snapshot = readState();
    stadium?.update(now, frameDelta, snapshot?.players);
    for (let index = activeImpacts.length - 1; index >= 0; index -= 1) {
      if (!activeImpacts[index].update(frameDelta)) { activeImpacts[index].dispose(); activeImpacts.splice(index, 1); }
    }
    const displayState = snapshot ? `${snapshot.phase}:${snapshot.round}:${snapshot.roundWins.azure}:${snapshot.roundWins.ember}:${Math.floor(snapshot.secondsLeft)}:${snapshot.towers.map((tower) => Math.ceil(tower.hp / tower.maxHp * 20)).join(',')}` : 'preview';
    if (displayState !== lastDisplayState && stadium) {
      stadium.draw(snapshot ?? undefined);
      lastDisplayState = displayState;
    }
    previewJets.forEach(({ jet }) => {
      jet.visible = !snapshot;
      if (!snapshot) updateJet(jet, { alive: true, throttle: .9, burner: false, gLoad: 1 }, frameDelta, now);
    });
    if (sceneInitialized && snapshot) {
      for (const event of snapshot.events) {
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);
        if (seenEventIds.size > 256) seenEventIds.delete(seenEventIds.values().next().value as string);
        if (event.type === 'boundary') { stadium?.signalBoundary(event.x, event.y, event.z); continue; }
        if (event.x === undefined || event.y === undefined || event.z === undefined) continue;
        if (event.type === 'tower-down') {
          // Blasts walk down the shaft over ~2.5 s, the alarm sounds and sparks shower the deck.
          stadium?.raiseAlarm(6_000);
          for (let step = 0; step < 6; step += 1) {
            shaftOffset.set(Math.random() - .5, 0, Math.random() - .5).multiplyScalar(TOWER.radius * 1.2);
            destruction.push({ at: now + step * 420, x: event.x + shaftOffset.x, y: TOWER.height * (.95 - step * .14), z: event.z + shaftOffset.z, major: step % 2 === 0 });
          }
          continue;
        }
        if (event.type === 'tower-critical') {
          stadium?.raiseAlarm(4_000);
          sparksAt(event.x, event.y, event.z, 60, 140 * FLIGHT_SCALE);
          continue;
        }
        if (event.type === 'repair-interrupted' || event.type === 'prep' || event.type === 'round-start') continue;
        const major = event.type === 'jet-down';
        const color = event.type === 'repair' ? 0x6dffa8 : event.type === 'barrier' ? 0xfff0b8 : major ? 0xff713d : event.team === 'ember' ? 0xff566d : 0x63eaff;
        activeImpacts.push(createImpact(scene, event.x, event.y, event.z, color, major));
        stadium?.reportImpact(event.x, event.y, event.z, major);
      }
      for (const object of baseObjects.values()) {
        const core = object.userData.core as THREE.Mesh | undefined;
        const coreRing = object.userData.coreRing as THREE.Mesh | undefined;
        const radarTower = object.userData.radarTower as THREE.Group | undefined;
        if (core) core.rotation.y += frameDelta * 1.25;
        if (coreRing) coreRing.rotation.z += frameDelta * 1.05;
        if (radarTower) radarTower.rotation.y += frameDelta * .55;
      }
      // Towers and stations move to the defending team's end when sides switch.
      const layoutKey = snapshot.towers.map((tower) => `${tower.id}:${Math.round(tower.x)}:${Math.round(tower.z)}`).join('|');
      if (layoutKey !== towerLayoutKey && surfaceMaps) {
        towerLayoutKey = layoutKey;
        for (const tower of towerObjects.values()) tower.dispose();
        towerObjects.clear();
        stationSet?.dispose(); stationSet = undefined;
        for (const tower of snapshot.towers) towerObjects.set(tower.id, buildTower(scene, tower, surfaceMaps));
        if (snapshot.stations.length) stationSet = buildStations(scene, snapshot.stations, surfaceMaps);
      }
      for (const tower of snapshot.towers) {
        towerObjects.get(tower.id)?.update(tower, frameDelta, now);
        const health = tower.hp / tower.maxHp;
        if (tower.hp <= 0) {
          if (Math.random() < frameDelta * 9) towerSmoke.emit(tower.x + (Math.random() - .5) * TOWER.radius, TOWER.height * .3, tower.z + (Math.random() - .5) * TOWER.radius, (Math.random() - .5) * 40 * ARENA_SCALE, 18 * ARENA_SCALE, (Math.random() - .5) * 40 * ARENA_SCALE, 7 + Math.random() * 3, .09, .09, .1, .55);
        } else if (health < TOWER.critical) {
          if (Math.random() < frameDelta * 3) towerSmoke.emit(tower.x, TOWER.height * (.4 + Math.random() * .5), tower.z, (Math.random() - .5) * 20 * ARENA_SCALE, 10 * ARENA_SCALE, (Math.random() - .5) * 20 * ARENA_SCALE, 4, .25, .25, .27, .35);
          if (Math.random() < frameDelta * 1.6) sparksAt(tower.x + (Math.random() - .5) * TOWER.radius * 1.6, TOWER.height * (.3 + Math.random() * .6), tower.z + (Math.random() - .5) * TOWER.radius * 1.6, 14, 90 * FLIGHT_SCALE);
        }
      }
      for (let index = destruction.length - 1; index >= 0; index -= 1) {
        const blast = destruction[index];
        if (now < blast.at) continue;
        destruction.splice(index, 1);
        activeImpacts.push(createImpact(scene, blast.x, blast.y, blast.z, 0xff713d, blast.major));
        sparksAt(blast.x, blast.y, blast.z, blast.major ? 70 : 30, (blast.major ? 220 : 140) * FLIGHT_SCALE);
        stadium?.reportImpact(blast.x, Math.min(blast.y, 60 * ARENA_SCALE), blast.z, blast.major);
        for (let puff = 0; puff < 10; puff += 1) towerSmoke.emit(blast.x, blast.y, blast.z, (Math.random() - .5) * 120 * ARENA_SCALE, (Math.random() - .2) * 60 * ARENA_SCALE, (Math.random() - .5) * 120 * ARENA_SCALE, 5 + Math.random() * 3, .14, .12, .12, .7);
      }

      const selfId = readSelfId();
      const liveIds = new Set(snapshot.players.map((player) => player.id));
      const dropPlayer = (playerId: string, object: THREE.Group) => {
        if (object.userData.kind === 'pilot') detachTrails(object);
        scene.remove(object);
        if (object.userData.kind === 'ground') disposeTree(object); jetObjects.delete(playerId); jetTracks.delete(playerId);
      };
      for (const [playerId, object] of jetObjects) if (!liveIds.has(playerId)) dropPlayer(playerId, object);
      const localAim = readAim?.() ?? null;
      for (const jet of snapshot.players) {
        let object = jetObjects.get(jet.id);
        // Roles change between rounds: a pilot can be on a gun next round.
        if (object && object.userData.kind !== jet.role) { dropPlayer(jet.id, object); object = undefined; }
        if (!object) {
          if (jet.role === 'ground') {
            object = makeGroundUnit(jet.team);
            scene.add(object);
          } else {
            object = makeJet(jet.team, jet.model); object.position.set(jet.x, jet.y, jet.z); object.scale.setScalar(jet.id === selfId ? 1.32 : 1);
            scene.add(object); attachTrails(object, scene);
          }
          object.userData.kind = jet.role;
          jetObjects.set(jet.id, object);
        }
        if (jet.role === 'ground') {
          // A wreck stays where it was knocked out.
          object.visible = true;
          updateGroundUnit(object, jet.id === selfId && jet.alive && localAim ? { ...jet, yaw: localAim.yaw, pitch: localAim.pitch } : jet, frameDelta, now);
          const pad = jet.alive && jet.repairProgress > 0 ? snapshot.stations[jet.station] : undefined;
          const repairing = pad ? snapshot.towers.find((tower) => tower.id === pad.towerId) : undefined;
          if (repairing) {
            beamTarget.x = repairing.x; beamTarget.y = TOWER.height * .35; beamTarget.z = repairing.z;
            setRepairBeam(object, beamTarget, now);
            if (Math.random() < frameDelta * 6) sparksAt(repairing.x + (Math.random() - .5) * TOWER.radius, TOWER.height * .35, repairing.z + (Math.random() - .5) * TOWER.radius, 4, 40 * FLIGHT_SCALE);
          } else setRepairBeam(object, null, now);
          if (!jet.alive && Math.random() < frameDelta * 2) jetSmoke.emit(jet.x, 6 * FLIGHT_SCALE, jet.z, 0, 12 * FLIGHT_SCALE, 0, 3, .12, .12, .13, .5);
          continue;
        }
        object.visible = jet.alive;
        const track = sample(jetTracks, jet.id, jet.x, jet.y, jet.z, jet.yaw, jet.pitch, jet.speed, now);
        extrapolate(track, now, jetGoal);
        // Respawns and barrier bounces teleport: snap rather than glide.
        if (object.position.distanceToSquared(jetGoal) > (60 * FLIGHT_SCALE) ** 2) object.position.copy(jetGoal);
        else object.position.lerp(jetGoal, damp(28, frameDelta));
        if (jet.q) targetQuaternion.set(jet.q[0], jet.q[1], jet.q[2], jet.q[3]);
        else targetQuaternion.setFromEuler(tempEuler.set(-jet.pitch, jet.yaw, jet.roll, 'YXZ'));
        object.quaternion.slerp(targetQuaternion, damp(14, frameDelta));
        updateJet(object, jet, frameDelta, now);
        if (jet.alive && jet.hp < 65) {
          exhaust.set(0, 0, -9 * FLIGHT_SCALE).applyQuaternion(object.quaternion).add(object.position);
          const badly = jet.hp < 30;
          const rate = (badly ? 70 : 30) * frameDelta;
          for (let puff = 0; puff < rate || (puff === 0 && Math.random() < rate); puff += 1) {
            const shade = badly ? .08 : .32;
            jetSmoke.emit(exhaust.x + (Math.random() - .5) * 6, exhaust.y + (Math.random() - .5) * 6, exhaust.z + (Math.random() - .5) * 6, (Math.random() - .5) * 30, 10, (Math.random() - .5) * 30, badly ? 2.2 : 1.4, shade, shade, shade + .02, badly ? .75 : .45);
            if (badly && Math.random() < .6) fireField.emit(exhaust.x, exhaust.y, exhaust.z, (Math.random() - .5) * 40, 20, (Math.random() - .5) * 40, .35, 1, .45 + Math.random() * .3, .12, .9);
          }
        }
      }

      // Who the camera follows: you, or once you're down, a teammate still in the round.
      const self = snapshot.players.find((jet) => jet.id === selfId);
      let viewed = self?.alive ? self : undefined;
      const chosenId = readViewId?.();
      if (!viewed && chosenId) viewed = snapshot.players.find((jet) => jet.id === chosenId && jet.alive);
      if (!viewed && self && snapshot.phase === 'active') viewed = snapshot.players.find((jet) => jet.team === self.team && jet.alive && jet.role === 'pilot') ?? snapshot.players.find((jet) => jet.team === self.team && jet.alive);
      const viewedObject = viewed ? jetObjects.get(viewed.id) : undefined;
      leadMarker.visible = false;
      if (viewed && viewedObject && viewed.role === 'pilot') {
        hasGunnerCamera = false;
        const pilotObject = viewedObject;
        // The camera rides the SMOOTHED jet, never the raw tick samples, and
        // trails its orientation slightly so manoeuvres sweep instead of
        // snapping. It banks with the jet, so the horizon tilts in a turn and
        // turns over in a loop, as it would from a chase plane.
        if (!hasPilotCamera) cameraRig.copy(pilotObject.quaternion);
        else cameraRig.slerp(pilotObject.quaternion, damp(8, frameDelta));
        forward.set(0, 0, 1).applyQuaternion(cameraRig);
        cameraUp.set(0, 1, 0).applyQuaternion(cameraRig);
        desiredCamera.copy(pilotObject.position).addScaledVector(forward, -36).addScaledVector(cameraUp, 14);
        if (!hasPilotCamera) { camera.position.copy(desiredCamera); hasPilotCamera = true; }
        else camera.position.lerp(desiredCamera, damp(20, frameDelta));
        lookTarget.copy(pilotObject.position).addScaledVector(forward, 24);
        camera.up.copy(cameraUp);
        camera.lookAt(lookTarget);
      } else if (viewed && viewedObject && viewed.role === 'ground') {
        hasPilotCamera = false;
        // Gunner's view: just above and behind the guns, looking where they point.
        const aim = viewed.id === selfId && localAim ? localAim : viewed;
        aimDirection.set(Math.sin(aim.yaw) * Math.cos(aim.pitch), Math.sin(aim.pitch), Math.cos(aim.yaw) * Math.cos(aim.pitch));
        flatAim.set(Math.sin(aim.yaw), 0, Math.cos(aim.yaw));
        desiredCamera.set(viewedObject.position.x, GROUND.gunHeight + 14 * FLIGHT_SCALE, viewedObject.position.z).addScaledVector(flatAim, -24 * FLIGHT_SCALE);
        if (!hasGunnerCamera) camera.position.copy(desiredCamera);
        else camera.position.lerp(desiredCamera, damp(16, frameDelta));
        hasGunnerCamera = true;
        lookTarget.copy(camera.position).addScaledVector(aimDirection, 1_000);
        camera.up.copy(worldUp);
        camera.lookAt(lookTarget);
        if (viewed.id === selfId && viewed.transit <= 0) {
          // Lead the closest enemy jet near the crosshair.
          let best = .8;
          let target: typeof viewed | undefined;
          for (const jet of snapshot.players) {
            if (!jet.alive || jet.team === viewed.team || jet.role !== 'pilot') continue;
            const object = jetObjects.get(jet.id);
            if (!object) continue;
            leadPoint.copy(object.position).sub(camera.position);
            const distance = leadPoint.length();
            if (distance > GROUND.flakSpeed * GROUND.flakLife) continue;
            const facing = leadPoint.dot(aimDirection) / Math.max(distance, 1);
            if (facing > best) { best = facing; target = jet; }
          }
          const targetObject = target ? jetObjects.get(target.id) : undefined;
          if (target && targetObject) {
            heading.set(Math.sin(target.yaw) * Math.cos(target.pitch), Math.sin(target.pitch), Math.cos(target.yaw) * Math.cos(target.pitch));
            leadPoint.copy(targetObject.position);
            for (let pass = 0; pass < 3; pass += 1) {
              const time = leadPoint.distanceTo(viewedObject.position) / GROUND.flakSpeed;
              leadPoint.copy(targetObject.position).addScaledVector(heading, target.speed * time);
            }
            leadMarker.position.copy(leadPoint);
            leadMarker.quaternion.copy(camera.quaternion);
            leadMarker.scale.setScalar(camera.position.distanceTo(leadPoint) * .022);
            leadMarker.visible = true;
          }
        }
      } else {
        hasPilotCamera = false;
        hasGunnerCamera = false;
        camera.up.copy(worldUp);
        desiredCamera.set(0, 78 * ARENA_SCALE, 268 * ARENA_SCALE);
        camera.position.lerp(desiredCamera, .025);
        camera.lookAt(0, 165 * ARENA_SCALE, -40 * ARENA_SCALE);
      }

      const shotIds = new Set(snapshot.projectiles.map((projectile) => projectile.id));
      for (const [shotId, object] of projectileObjects) {
        if (shotIds.has(shotId)) continue;
        // Where a shell or missile ends: flak bursts in a black puff, missiles in a fireball.
        const kind = object.userData.kind as ProjectileKind;
        const { x, y, z } = object.position;
        const near = camera.position.distanceTo(object.position) < 2_600 * S / 3;
        if (kind === 'flak') {
          for (let puff = 0; puff < 6; puff += 1) burstSmoke.emit(x + (Math.random() - .5) * 8 * S, y + (Math.random() - .5) * 8 * S, z + (Math.random() - .5) * 8 * S, (Math.random() - .5) * 30 * S, (Math.random() - .5) * 30 * S, (Math.random() - .5) * 30 * S, 1.4 + Math.random() * .8, .07, .07, .08, .85);
          fireField.emit(x, y, z, 0, 0, 0, .12, 1, .7, .3, 1);
          if (near) sfx.flak();
        } else if (kind === 'missile' || kind === 'sam') {
          for (let puff = 0; puff < 10; puff += 1) fireField.emit(x, y, z, (Math.random() - .5) * 120 * S, (Math.random() - .5) * 120 * S, (Math.random() - .5) * 120 * S, .4 + Math.random() * .3, 1, .55 + Math.random() * .3, .15, 1);
          for (let puff = 0; puff < 8; puff += 1) burstSmoke.emit(x, y, z, (Math.random() - .5) * 50 * S, (Math.random() - .5) * 50 * S, (Math.random() - .5) * 50 * S, 2 + Math.random(), .18, .17, .17, .8);
          sparksAt(x, y, z, 20, 110 * S);
          if (near) sfx.explosion(false);
        }
        scene.remove(object); projectileObjects.delete(shotId); shotTracks.delete(shotId);
      }
      for (const shot of snapshot.projectiles) {
        let object = projectileObjects.get(shot.id);
        if (!object) {
          object = makeShot(shot.kind, shot.team);
          object.userData.kind = shot.kind;
          object.userData.bornAt = now;
          scene.add(object); projectileObjects.set(shot.id, object);
          const mine = shot.ownerId === selfId;
          if (shot.kind === 'cannon') {
            let flash = muzzleFlashes.get(shot.ownerId);
            if (!flash) { flash = { mesh: new THREE.Mesh(muzzleFlashGeometry, muzzleFlashMaterial), until: 0 }; scene.add(flash.mesh); muzzleFlashes.set(shot.ownerId, flash); }
            flash.until = now + 55;
            if (mine) sfx.cannon();
          } else if (shot.kind === 'missile' || shot.kind === 'sam') {
            if (mine || camera.position.distanceTo(object.position.set(shot.x, shot.y, shot.z)) < 1_400 * S) sfx.missileLaunch();
          } else if (mine) sfx.cannon();
          if (shot.kind === 'flak') {
            const gun = jetObjects.get(shot.ownerId);
            if (gun?.userData.kind === 'ground') flashGroundUnit(gun, now);
            else if (shot.ownerId.startsWith('tower:')) towerObjects.get(shot.ownerId.slice(6))?.fired(shot.yaw, shot.pitch, now);
          }
        }
        const shotTrack = sample(shotTracks, shot.id, shot.x, shot.y, shot.z, shot.yaw, shot.pitch, shot.speed ?? PROJECTILE_SPEED[shot.kind], now);
        extrapolate(shotTrack, now, predicted);
        object.position.copy(predicted);
        object.rotation.set(-shot.pitch, shot.yaw, 0, 'YXZ');
        if (shot.kind === 'missile' || shot.kind === 'sam') {
          // The motor lights once the missile is clear of the rail: flame, glow and a smoke trail.
          const lit = now - (object.userData.bornAt as number) > 220;
          const flame = object.userData.flame as THREE.Mesh; const glow = object.userData.glow as THREE.Mesh;
          flame.visible = lit; glow.visible = lit;
          // Smoke starts a beat after ignition, once the missile is clear of the chase camera.
          const smoking = now - (object.userData.bornAt as number) > 420;
          if (lit) {
            flame.scale.set(1, 1, .8 + Math.random() * .5);
            tail.set(0, 0, -5 * S).applyEuler(object.rotation).add(object.position);
            const puffs = Math.max(1, Math.round(frameDelta * 70));
            for (let puff = 0; smoking && puff < puffs; puff += 1) {
              missileSmoke.emit(tail.x, tail.y, tail.z, (Math.random() - .5) * 12 * S, (Math.random() - .5) * 12 * S, (Math.random() - .5) * 12 * S, 1.6 + Math.random() * 1, .82, .83, .85, .32);
            }
          }
        }
      }
    }
    for (const [jetId, flash] of muzzleFlashes) {
      const jet = jetObjects.get(jetId);
      flash.mesh.visible = Boolean(jet?.visible) && now < flash.until;
      if (!jet || !flash.mesh.visible) continue;
      nosePoint.set(0, -.4 * S, 13 * S).applyQuaternion(jet.quaternion).add(jet.position);
      flash.mesh.position.copy(nosePoint);
      flash.mesh.scale.setScalar(.7 + Math.random() * .6);
    }
    jetSmoke.update(frameDelta); fireField.update(frameDelta); towerSmoke.update(frameDelta); sparkField.update(frameDelta);
    missileSmoke.update(frameDelta); burstSmoke.update(frameDelta);
    // HUD markers: teammates, detected enemies, towers, and missiles coming for you.
    markerFrame += 1;
    if (sceneInitialized && snapshot && snapshot.phase !== 'complete') {
      const width = host.clientWidth; const height = host.clientHeight;
      const selfId = readSelfId();
      const self = snapshot.players.find((jet) => jet.id === selfId);
      const myTeam = self?.team;
      const viewId = self?.alive ? selfId : readViewId?.() ?? null;
      if (myTeam) {
        for (const jet of snapshot.players) {
          if (!jet.alive || jet.id === viewId) continue;
          const friendly = jet.team === myTeam;
          if (!friendly && !jet.spotted) continue;
          const object = jetObjects.get(jet.id);
          if (!object) continue;
          const lift = jet.role === 'ground' ? 26 * FLIGHT_SCALE : 9 * FLIGHT_SCALE;
          const locked = self?.targetId === jet.id;
          placeMarker(jet.id, object.position.x, object.position.y + lift, object.position.z, jet.name, `${jet.role === 'ground' ? 'GUN · ' : ''}${distanceLabel(object.position.x, object.position.y, object.position.z)}`,
            `${friendly ? 'friend' : 'enemy'} ${jet.team} ${locked ? 'locked' : ''}`, width, height);
        }
        for (const tower of snapshot.towers) {
          if (tower.hp <= 0) continue;
          const health = Math.ceil(tower.hp / tower.maxHp * 100);
          const locked = self?.targetId === `tower:${tower.id}`;
          // Marked at mid-height: the whole tower is the target, not its top.
          placeMarker(tower.id, tower.x, TOWER.height * .55, tower.z, `${tower.label} ${health}%`, `${tower.shielded ? 'SHIELDED' : ''}${tower.barrier > 0 ? ' · BARRIER' : ''}`,
            `tower ${tower.team === myTeam ? 'friend' : 'enemy'} ${tower.team} ${health < TOWER.critical * 100 ? 'critical' : ''} ${locked ? 'locked' : ''}`, width, height);
        }
        for (const shot of snapshot.projectiles) {
          if (shot.targetId !== selfId || (shot.kind !== 'missile' && shot.kind !== 'sam')) continue;
          const object = projectileObjects.get(shot.id);
          if (object) placeMarker(shot.id, object.position.x, object.position.y, object.position.z, 'MISSILE', distanceLabel(object.position.x, object.position.y, object.position.z), 'missile', width, height);
        }
      }
    }
    for (const [id, marker] of markers) {
      if (marker.seen === markerFrame) continue;
      marker.element.remove();
      markers.delete(id);
    }
    // Re-bake sky reflections every 20s; the sky changes slowly.
    if (sceneInitialized && now - lastEnvironmentAt > 20_000) { lastEnvironmentAt = now; refreshEnvironment(); }
    const mood = stadium?.mood?.() ?? 0;
    bloom.strength = .42 + mood * .28;
    finalPass.material.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    composer.render(frameDelta);
  };
  // Mount and paint the canvas before building the detailed stadium scene.
  animation = requestAnimationFrame(animate);
  initializationFrame = requestAnimationFrame(initializeScene);

  return () => {
    cancelAnimationFrame(animation);
    cancelAnimationFrame(initializationFrame);
    resizeObserver.disconnect();
    for (const impact of activeImpacts) impact.dispose();
    for (const object of baseObjects.values()) (object.userData.coreTexture as THREE.Texture | undefined)?.dispose();
    for (const tower of towerObjects.values()) tower.dispose();
    stationSet?.dispose();
    jetSmoke.dispose(); fireField.dispose(); towerSmoke.dispose(); sparkField.dispose();
    markerLayer.remove();
    for (const look of shotParts.values()) { look.geometry.dispose(); look.material.dispose(); }
    for (const flash of muzzleFlashes.values()) scene.remove(flash.mesh);
    muzzleFlashGeometry.dispose(); muzzleFlashMaterial.dispose();
    missileSmoke.dispose(); burstSmoke.dispose();
    // Release the stadium's own canvases and particle buffers before the sweep.
    stadium?.dispose();
    for (const object of [...jetObjects.values(), ...baseObjects.values(), ...projectileObjects.values(), ...previewJets.map(({ jet }) => jet)]) scene.remove(object);
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    pmremGenerator.dispose();
    bloom.dispose();
    composer.dispose();
    renderer.dispose();
    Object.values(surfaceMaps ?? {}).forEach((maps) => { maps.color.dispose(); maps.roughness.dispose(); maps.bump.dispose(); });
    environmentMap?.dispose();
    renderer.domElement.remove();
  };
}
