import * as THREE from 'three';
import type { JetModel, Team } from '@/lib/protocol';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mergeStaticMeshes, TEAM_COLORS } from '@/lib/arena-kit';

/**
 * Fighter jets: livery-textured airframes with canted twin tails, a gold
 * canopy, layered afterburners, blinking navigation lights and wingtip vapour
 * trails. The nose points down +Z; the airframe is ~28 units long.
 */

/* ------------------------------------------------------------------ */
/* Livery                                                             */
/* ------------------------------------------------------------------ */

const liveryCache = new Map<string, THREE.CanvasTexture>();

/**
 * Splinter camouflage, panel lines, rivets, a team band, roundels and a
 * tail number. Laid out for the lathe fuselage: u runs around the body,
 * v runs tail (0) to nose (1).
 */
function livery(team: Team, model: JetModel) {
  const key = `${team}:${model}`;
  const cached = liveryCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (context) {
    const [base, dark, light] = team === 'azure'
      ? ['#5d6c78', '#465460', '#74838e']
      : ['#6c5f62', '#53474a', '#837679'];
    context.fillStyle = base;
    context.fillRect(0, 0, 1024, 512);
    // Splinter camo: hard-edged polygons in two tones.
    let seed = model === 'swift' ? 11 : 29;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let patch = 0; patch < 46; patch += 1) {
      context.fillStyle = patch % 2 ? dark : light;
      context.beginPath();
      const x = random() * 1024; const y = random() * 512;
      context.moveTo(x, y);
      for (let corner = 0; corner < 4; corner += 1) context.lineTo(x + (random() - .3) * 220, y + (random() - .5) * 120);
      context.closePath();
      context.fill();
    }
    // Panel lines with a faint highlight, plus rivet rows.
    context.lineWidth = 1.4;
    for (let row = 0; row < 9; row += 1) {
      const y = 20 + row * 56 + (row % 2) * 9;
      context.strokeStyle = 'rgba(10,14,18,.5)';
      context.beginPath(); context.moveTo(0, y); context.lineTo(1024, y); context.stroke();
      context.strokeStyle = 'rgba(255,255,255,.08)';
      context.beginPath(); context.moveTo(0, y + 1.5); context.lineTo(1024, y + 1.5); context.stroke();
      for (let column = 0; column < 14; column += 1) {
        const x = column * 74 + (row % 3) * 21;
        context.strokeStyle = 'rgba(10,14,18,.45)';
        context.beginPath(); context.moveTo(x, y); context.lineTo(x, y + 56); context.stroke();
      }
      context.fillStyle = 'rgba(20,24,28,.5)';
      for (let rivet = 0; rivet < 1024; rivet += 9) context.fillRect(rivet, y + 4, 1.6, 1.6);
    }
    // Team band just behind the cockpit and a darker radome.
    const accent = team === 'azure' ? '#2aa7e3' : '#e2364c';
    context.fillStyle = accent;
    context.fillRect(0, 186, 1024, 16);
    context.fillStyle = 'rgba(240,240,236,.85)';
    context.fillRect(0, 204, 1024, 4);
    context.fillStyle = '#2b3036';
    context.fillRect(0, 0, 1024, 30);
    // Roundels on both flanks.
    for (const u of [256, 768]) {
      context.fillStyle = '#e8e8e2';
      context.beginPath(); context.arc(u, 330, 34, 0, Math.PI * 2); context.fill();
      context.fillStyle = accent;
      context.beginPath(); context.arc(u, 330, 25, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#1b1f24';
      context.beginPath(); context.arc(u, 330, 10, 0, Math.PI * 2); context.fill();
      context.fillStyle = 'rgba(232,232,226,.9)';
      context.font = '700 30px Rajdhani, Arial, sans-serif';
      context.fillText(team === 'azure' ? 'AZ-07' : 'EM-41', u - 40, 130);
    }
    // Exhaust staining near the tail.
    const soot = context.createLinearGradient(0, 512, 0, 400);
    soot.addColorStop(0, 'rgba(18,16,14,.75)');
    soot.addColorStop(1, 'rgba(18,16,14,0)');
    context.fillStyle = soot;
    context.fillRect(0, 400, 1024, 112);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  liveryCache.set(key, texture);
  return texture;
}

/* ------------------------------------------------------------------ */
/* Airframe                                                           */
/* ------------------------------------------------------------------ */

/** Both engines' plumes, one mesh per layer, so a jet's exhaust costs four draws. */
type Flame = { group: THREE.Group; core: THREE.Mesh; mid: THREE.Mesh; haze: THREE.Mesh; diamonds: THREE.Mesh; glow: THREE.MeshBasicMaterial };
type Trail = { line: THREE.Line; tip: THREE.Vector3; positions: Float32Array; colors: Float32Array; strength: Float32Array; primed: boolean };
const TRAIL_POINTS = 48;

export type JetVisual = {
  flames: Flame[];
  strobe: THREE.Mesh;
  beacon: THREE.Mesh;
  navLights: THREE.Mesh[];
  trails: Trail[];
  model: JetModel;
};

function extrude(shape: THREE.Shape, depth: number, bevel: number) {
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSegments: 2, bevelSize: bevel, bevelThickness: bevel });
}

export function makeJet(team: Team, model: JetModel) {
  const group = new THREE.Group();
  const heavy = model === 'bastion';
  const skin = livery(team, model);
  // Extrusions get planar UVs in shape units, so they sample a tiled copy.
  const panelSkin = skin.clone();
  panelSkin.repeat.set(.045, .06);
  panelSkin.needsUpdate = true;

  const body = new THREE.MeshStandardMaterial({ map: skin, roughness: .52, metalness: .42 });
  const panels = new THREE.MeshStandardMaterial({ map: panelSkin, roughness: .55, metalness: .4, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: '#1a1f24', roughness: .4, metalness: .6 });
  const metal = new THREE.MeshStandardMaterial({ color: '#8e979e', roughness: .28, metalness: .9 });
  const accentColor = TEAM_COLORS[team];
  const accent = new THREE.MeshStandardMaterial({ color: accentColor, roughness: .4, metalness: .3, emissive: accentColor, emissiveIntensity: .15 });
  const canopyGlass = new THREE.MeshPhysicalMaterial({
    color: '#c9a75a', roughness: .06, metalness: .85, clearcoat: 1, clearcoatRoughness: .04, transparent: true, opacity: .82,
  });

  // Fuselage: a lathe, flattened into an elliptical, blended cross-section.
  const profile = [
    [0, -14], [.95, -13.2], [1.55, -11], [1.85, -7], [2.05, -2], [2.0, 2.5],
    [1.72, 6.5], [1.3, 9.5], [.86, 12], [.42, 14.2], [0, 15.6],
  ].map(([radius, height]) => new THREE.Vector2(radius, height));
  const fuselage = new THREE.Mesh(new THREE.LatheGeometry(profile, 28), body);
  fuselage.rotation.x = Math.PI / 2;
  fuselage.scale.set(heavy ? 1.42 : 1.3, 1, .78);
  group.add(fuselage);

  // Chines: sharp edges running down the nose that blend into the wing.
  for (const side of [-1, 1]) {
    const chine = new THREE.Shape();
    chine.moveTo(0, 14); chine.lineTo(side * 2.5, 4); chine.lineTo(side * 3.6, -1); chine.lineTo(0, -1); chine.closePath();
    const mesh = new THREE.Mesh(extrude(chine, .12, .04), panels);
    mesh.rotation.x = Math.PI / 2; mesh.position.y = .05;
    group.add(mesh);
  }

  // Canopy: tinted bubble with a frame bow and the pilot's helmet inside.
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2), canopyGlass);
  canopy.scale.set(.92, .95, 3.7);
  canopy.position.set(0, 1.12, 5.2);
  group.add(canopy);
  const bow = new THREE.Mesh(new THREE.TorusGeometry(.95, .07, 6, 20, Math.PI), dark);
  bow.position.set(0, 1.12, 4.2); bow.scale.set(.96, 1, 1);
  group.add(bow);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(.42, 12, 10), new THREE.MeshStandardMaterial({ color: '#d8d8d2', roughness: .45 }));
  helmet.position.set(0, 1.45, 4.6);
  group.add(helmet);

  // Swept wings with control-surface hinge lines.
  const span = heavy ? 17 : 14;
  const wing = new THREE.Shape();
  wing.moveTo(-1.8, 6.4); wing.lineTo(-span, -3.2); wing.lineTo(-span + .5, -5.1);
  wing.lineTo(-4.8, -5.2); wing.lineTo(-3.4, -8.6); wing.lineTo(3.4, -8.6); wing.lineTo(4.8, -5.2);
  wing.lineTo(span - .5, -5.1); wing.lineTo(span, -3.2); wing.lineTo(1.8, 6.4); wing.closePath();
  const wings = new THREE.Mesh(extrude(wing, .34, .16), panels);
  wings.rotation.x = Math.PI / 2; wings.position.y = .25;
  group.add(wings);
  for (const side of [-1, 1]) {
    const flap = new THREE.Mesh(new THREE.BoxGeometry(span - 5.8, .05, .08), dark);
    flap.position.set(side * (span / 2 + 2.4), .48, -4.5);
    flap.rotation.y = side * -.12;
    group.add(flap);
    const tipRail = new THREE.Mesh(new THREE.CylinderGeometry(.16, .16, 3.4, 8), metal);
    tipRail.rotation.x = Math.PI / 2; tipRail.position.set(side * (span - .2), .3, -3.9);
    group.add(tipRail);
  }

  // Stabilators.
  const tail = new THREE.Shape();
  tail.moveTo(-1.4, -7.2); tail.lineTo(-6.6, -11.4); tail.lineTo(-6.1, -12.8);
  tail.lineTo(-1.6, -12.2); tail.lineTo(1.6, -12.2); tail.lineTo(6.1, -12.8); tail.lineTo(6.6, -11.4); tail.lineTo(1.4, -7.2); tail.closePath();
  const stabilators = new THREE.Mesh(extrude(tail, .26, .1), panels);
  stabilators.rotation.x = Math.PI / 2; stabilators.position.y = .02;
  group.add(stabilators);

  // Twin vertical tails, canted outward.
  for (const side of [-1, 1]) {
    const fin = new THREE.Shape();
    fin.moveTo(0, 0); fin.lineTo(1.4, 5.4); fin.lineTo(3.0, 5.4); fin.lineTo(4.6, 1.2); fin.lineTo(4.2, 0); fin.closePath();
    const mesh = new THREE.Mesh(extrude(fin, .22, .08), panels);
    mesh.rotation.set(0, -Math.PI / 2, 0);
    const holder = new THREE.Group();
    holder.position.set(side * 1.6, .8, -11.6);
    holder.rotation.z = side * -.42;
    holder.add(mesh);
    group.add(holder);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(.3, .3, 1.9), accent);
    cap.position.set(0, 5.4, 2.2);
    holder.add(cap);
  }

  // Intakes either side of the cockpit.
  for (const side of [-1, 1]) {
    const intake = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.6, 6.4), body);
    intake.position.set(side * 2.05, -.15, 1.2);
    intake.rotation.y = side * -.06;
    group.add(intake);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.35, .3), dark);
    mouth.position.set(side * 2.1, -.15, 4.45);
    group.add(mouth);
  }

  // Engines: nozzle petals with a hot inner ring, and a layered afterburner.
  const flames: Flame[] = [];
  const flameColor = team === 'azure' ? '#5fd6ff' : '#ff6a3d';
  const engines = [-1.12, 1.12];
  const glow = new THREE.MeshBasicMaterial({ color: '#ffb36b', toneMapped: false });
  for (const x of engines) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(.92, 1.12, 2.4, 16, 1, true), metal);
    nozzle.rotation.x = Math.PI / 2; nozzle.position.set(x, -.12, -14.4);
    group.add(nozzle);
    for (let petal = 0; petal < 12; petal += 1) {
      const angle = (petal / 12) * Math.PI * 2;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(.14, .06, 2.3), dark);
      strip.position.set(x + Math.cos(angle) * 1.0, -.12 + Math.sin(angle) * 1.0, -14.4);
      strip.rotation.z = angle;
      group.add(strip);
    }
    const hotRing = new THREE.Mesh(new THREE.TorusGeometry(.72, .14, 8, 20), glow);
    hotRing.position.set(x, -.12, -15.2);
    group.add(hotRing);
  }

  // Plume layers: each is one geometry holding both engines' cones. The group
  // sits at the nozzle exit so scaling z lengthens every plume together.
  const flame = new THREE.Group();
  flame.position.set(0, -.12, -15.6);
  group.add(flame);
  const additive = (color: string, opacity: number) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const twin = (make: () => THREE.BufferGeometry) => mergeGeometries(engines.map((x) => make().translate(x, 0, 0)), false)!;
  // Base at the nozzle (z = 0), tip trailing back down -Z.
  const cone = (radius: number, length: number) => () => new THREE.ConeGeometry(radius, length, 14, 1, true).translate(0, length / 2, 0).rotateX(-Math.PI / 2);
  const layer = (geometry: THREE.BufferGeometry, material: THREE.Material) => { const mesh = new THREE.Mesh(geometry, material); flame.add(mesh); return mesh; };
  const core = layer(twin(cone(.62, 3.2)), additive('#fff4d6', .95));
  const mid = layer(twin(cone(.82, 6.8)), additive(flameColor, .55));
  const haze = layer(twin(cone(1.05, 10)), additive(flameColor, .18));
  // Shock diamonds: four per engine, baked into one mesh.
  const diamondParts: THREE.BufferGeometry[] = [];
  for (const x of engines) for (let shock = 0; shock < 4; shock += 1) {
    const size = 1 - shock * .16;
    diamondParts.push(new THREE.SphereGeometry(.34 * size, 8, 6).scale(1, 1, 1.9).translate(x, 0, -1.6 - shock * 1.5));
  }
  const diamonds = layer(mergeGeometries(diamondParts, false)!, additive('#fff0c0', .7));
  flames.push({ group: flame, core, mid, haze, diamonds, glow });

  // Weapons on pylons.
  const ordnance = new THREE.MeshStandardMaterial({ color: '#dfe3e5', roughness: .35, metalness: .5 });
  const stations = heavy ? [6.4, 11.4] : [6.4];
  for (const side of [-1, 1]) for (const offset of stations) {
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(.5, .7, 3.6), dark);
    pylon.position.set(side * offset, -.35, -1.4);
    group.add(pylon);
    const missile = new THREE.Mesh(new THREE.CylinderGeometry(.32, .32, 5, 10), ordnance);
    missile.rotation.x = Math.PI / 2; missile.position.set(side * offset, -1, -.6);
    group.add(missile);
    const seeker = new THREE.Mesh(new THREE.ConeGeometry(.32, 1.2, 10), ordnance);
    seeker.rotation.x = Math.PI / 2; seeker.position.set(side * offset, -1, 2.5);
    group.add(seeker);
    const finRing = new THREE.Mesh(new THREE.BoxGeometry(1.4, .06, .7), dark);
    finRing.position.set(side * offset, -1, -2.8);
    group.add(finRing);
  }

  // Spine antennas and the gun port.
  for (const z of [-2, -6.5]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(.06, .6, .9), dark);
    blade.position.set(0, 1.5, z);
    group.add(blade);
  }
  const gun = new THREE.Mesh(new THREE.CylinderGeometry(.12, .16, 1.6, 8), dark);
  gun.rotation.x = Math.PI / 2; gun.position.set(1.1, .7, 8.8);
  group.add(gun);

  // Navigation lights: port red, starboard green, tail strobe, belly beacon.
  const navLights: THREE.Mesh[] = [];
  const lamp = (color: string, radius: number, position: [number, number, number]) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    mesh.position.set(...position);
    group.add(mesh);
    return mesh;
  };
  // Nose points down +Z, so +X is the port (left) wingtip: red to port, green to starboard.
  navLights.push(lamp('#ff2a36', .3, [span, .3, -3.2]), lamp('#2bff8a', .3, [-span, .3, -3.2]));
  const strobe = lamp('#ffffff', .26, [0, .5, -14.2]);
  const beacon = lamp('#ff3030', .28, [0, -1.3, -3]);

  // Vapour trails from both wingtips, drawn in world space by updateJet.
  const trails: Trail[] = [-1, 1].map((side) => {
    const positions = new Float32Array(TRAIL_POINTS * 3);
    const colors = new Float32Array(TRAIL_POINTS * 4);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    line.frustumCulled = false;
    return { line, tip: new THREE.Vector3(side * (span + .3), .3, -3.6), positions, colors, strength: new Float32Array(TRAIL_POINTS), primed: false };
  });

  group.traverse((object) => {
    if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; }
  });
  for (const flame of flames) flame.group.traverse((object) => { object.castShadow = false; });

  // Collapse the static airframe to a handful of draws; keep animated parts.
  mergeStaticMeshes(group, [...flames.map((flame) => flame.group), strobe, beacon], new Set([glow]));

  const visual: JetVisual = { flames, strobe, beacon, navLights, trails, model };
  group.userData.visual = visual;
  group.userData.model = model;
  group.rotation.order = 'YXZ';
  return group;
}

/* ------------------------------------------------------------------ */
/* Per-frame animation                                                */
/* ------------------------------------------------------------------ */

const tipWorld = new THREE.Vector3();

/** Trails live in world space, so they are attached to the scene separately. */
export function attachTrails(jet: THREE.Group, scene: THREE.Scene) {
  const visual = jet.userData.visual as JetVisual | undefined;
  visual?.trails.forEach((trail) => scene.add(trail.line));
}

export function detachTrails(jet: THREE.Group) {
  const visual = jet.userData.visual as JetVisual | undefined;
  visual?.trails.forEach((trail) => {
    trail.line.removeFromParent();
    trail.line.geometry.dispose();
    (trail.line.material as THREE.Material).dispose();
  });
}

/** Visual state only: the flight model owns throttle, afterburner and G. */
export function updateJet(jet: THREE.Group, state: { alive: boolean; throttle: number; burner: boolean; gLoad: number }, dt: number, now: number) {
  const visual = jet.userData.visual as JetVisual | undefined;
  if (!visual) return;
  // Plume follows the throttle lever; the afterburner lights the full plume
  // and shock diamonds.
  const throttle = THREE.MathUtils.clamp(state.throttle ?? .75, 0, 1);
  const boost = state.burner ? 1 : 0;

  // Afterburner: grows and brightens with throttle, shock diamonds on boost.
  for (let index = 0; index < visual.flames.length; index += 1) {
    const flame = visual.flames[index];
    const flicker = .9 + Math.sin(now * .045 + index * 2.1) * .06 + Math.sin(now * .11 + index) * .04;
    const length = (.45 + throttle * .55 + boost * .7) * flicker;
    flame.group.visible = state.alive;
    flame.core.scale.set(1, 1, .7 + throttle * .5);
    flame.mid.scale.set(1, 1, length);
    flame.haze.scale.set(1, 1, length * (1 + boost * .4));
    (flame.mid.material as THREE.MeshBasicMaterial).opacity = .25 + throttle * .3 + boost * .25;
    (flame.haze.material as THREE.MeshBasicMaterial).opacity = .06 + throttle * .1 + boost * .14;
    flame.diamonds.visible = boost > .05 || throttle > .85;
    flame.diamonds.scale.set(1, 1, (.6 + boost * .6) * flicker * 1.6);
    flame.glow.color.setRGB(1, .55 + throttle * .3, .3 + throttle * .3);
  }

  // Lights: steady nav lights, double-flash strobe, rotating-style beacon.
  const strobeCycle = (now % 1_400) / 1_400;
  visual.strobe.visible = strobeCycle < .05 || (strobeCycle > .12 && strobeCycle < .17);
  visual.beacon.visible = (now % 1_000) < 520;

  // Wingtip vapour: appears at speed and in hard banks, fades along its length.
  // Wingtip vapour is condensation in the low-pressure vortex of a hard pull,
  // so it appears with G — from about 3G, full by 7G.
  const pull = THREE.MathUtils.clamp(((state.gLoad ?? 1) - 3) / 4, 0, 1);
  jet.updateMatrixWorld();
  for (const trail of visual.trails) {
    tipWorld.copy(trail.tip).applyMatrix4(jet.matrixWorld);
    if (!trail.primed) {
      for (let point = 0; point < TRAIL_POINTS; point += 1) {
        trail.positions[point * 3] = tipWorld.x;
        trail.positions[point * 3 + 1] = tipWorld.y;
        trail.positions[point * 3 + 2] = tipWorld.z;
      }
      trail.primed = true;
    }
    trail.positions.copyWithin(3, 0, (TRAIL_POINTS - 1) * 3);
    trail.strength.copyWithin(1, 0, TRAIL_POINTS - 1);
    trail.positions[0] = tipWorld.x; trail.positions[1] = tipWorld.y; trail.positions[2] = tipWorld.z;
    trail.strength[0] = state.alive ? pull : 0;
    // Written in place: this runs for every trail point of every jet each
    // frame, and temporary arrays here cause visible GC stutter.
    for (let point = 0; point < TRAIL_POINTS; point += 1) {
      const offset = point * 4;
      trail.colors[offset] = .92;
      trail.colors[offset + 1] = .96;
      trail.colors[offset + 2] = 1;
      trail.colors[offset + 3] = trail.strength[point] * (1 - point / TRAIL_POINTS) * .7;
    }
    trail.line.geometry.attributes.position.needsUpdate = true;
    trail.line.geometry.attributes.color.needsUpdate = true;
  }
}
