import * as THREE from 'three';

/**
 * A pooled particle field: one Points draw for every particle of a kind
 * (damage smoke, fire, sparks), whatever emits it. Particles live in world
 * space, drift with their velocity, rise or fall, and fade over their life.
 * Everything is written in place, so emitting every frame allocates nothing.
 */
export type ParticleField = {
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, r: number, g: number, b: number, a: number): void;
  update(dt: number): void;
  dispose(): void;
};

let puff: THREE.CanvasTexture | null = null;
let puffUsers = 0;
function puffTexture() {
  if (!puff) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context) {
      const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(.45, 'rgba(255,255,255,.55)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 64, 64);
    }
    puff = new THREE.CanvasTexture(canvas);
  }
  puffUsers += 1;
  return puff;
}

export function createParticleField(scene: THREE.Scene, options: { capacity: number; size: number; additive?: boolean; rise?: number; drag?: number }): ParticleField {
  const { capacity, size } = options;
  const rise = options.rise ?? 0;
  const drag = options.drag ?? .4;
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 4);
  const velocities = new Float32Array(capacity * 3);
  const ages = new Float32Array(capacity);
  const lives = new Float32Array(capacity);
  const alphas = new Float32Array(capacity);
  let next = 0;
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colorAttribute = new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('color', colorAttribute);
  // Particles roam the whole stadium: never cull the field as a whole.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const material = new THREE.PointsMaterial({
    size, map: puffTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true,
    blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: !options.additive,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;
  scene.add(points);
  let live = 0;
  return {
    emit(x, y, z, vx, vy, vz, life, r, g, b, a) {
      const index = next; next = (next + 1) % capacity;
      positions[index * 3] = x; positions[index * 3 + 1] = y; positions[index * 3 + 2] = z;
      velocities[index * 3] = vx; velocities[index * 3 + 1] = vy; velocities[index * 3 + 2] = vz;
      colors[index * 4] = r; colors[index * 4 + 1] = g; colors[index * 4 + 2] = b; colors[index * 4 + 3] = a;
      ages[index] = 0; lives[index] = life; alphas[index] = a;
      live = capacity;
    },
    update(dt) {
      if (!live) return;
      const slow = Math.exp(-drag * dt);
      let any = 0;
      for (let index = 0; index < capacity; index += 1) {
        if (lives[index] <= 0) continue;
        ages[index] += dt;
        const left = 1 - ages[index] / lives[index];
        if (left <= 0) { lives[index] = 0; colors[index * 4 + 3] = 0; continue; }
        any += 1;
        velocities[index * 3] *= slow; velocities[index * 3 + 2] *= slow;
        velocities[index * 3 + 1] = velocities[index * 3 + 1] * slow + rise * dt;
        positions[index * 3] += velocities[index * 3] * dt;
        positions[index * 3 + 1] += velocities[index * 3 + 1] * dt;
        positions[index * 3 + 2] += velocities[index * 3 + 2] * dt;
        // Fade in fast, out slowly.
        colors[index * 4 + 3] = alphas[index] * Math.min(1, ages[index] * 8) * left;
      }
      live = any;
      positionAttribute.needsUpdate = true;
      colorAttribute.needsUpdate = true;
    },
    dispose() {
      scene.remove(points);
      geometry.dispose();
      material.dispose();
      puffUsers -= 1;
      if (puffUsers <= 0 && puff) { puff.dispose(); puff = null; }
    },
  };
}
