/** Pure, deterministic geometry. Coordinates and matrices have no DOM dependency. */
export const MIN_POINTS = 3000;
export const MAX_POINTS = 200000;
export const PITCH_LIMIT = 0.92;
export const ROSE_CENTER_Y = -0.38;

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PETALS_PER_LAYER = [3, 5, 7, 9, 11];

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function smoothstep(low, high, value) {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}

function hash01(value) {
  let n = value | 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function radicalInverse(value) {
  let n = value >>> 0;
  n = ((n >>> 1) & 0x55555555) | ((n & 0x55555555) << 1);
  n = ((n >>> 2) & 0x33333333) | ((n & 0x33333333) << 2);
  n = ((n >>> 4) & 0x0f0f0f0f) | ((n & 0x0f0f0f0f) << 4);
  n = ((n >>> 8) & 0x00ff00ff) | ((n & 0x00ff00ff) << 8);
  n = (n >>> 16) | (n << 16);
  return (n >>> 0) / 4294967296;
}

/** Fixed limits keep the specimen upright, including for non-finite input. */
export function clampPitch(value) {
  return clamp(finiteNumber(value, 0), -PITCH_LIMIT, PITCH_LIMIT);
}

/** Column-major 3×3 Rodrigues rotation; accepts 'x', 'y', 'z' or an axis vector. */
export function rotationMatrix(axis, angle) {
  let x = 0;
  let y = 0;
  let z = 0;
  if (typeof axis === 'string') {
    if (axis.toLowerCase() === 'x') x = 1;
    else if (axis.toLowerCase() === 'z') z = 1;
    else y = 1;
  } else if (axis && axis.length >= 3) {
    x = finiteNumber(axis[0], 0);
    y = finiteNumber(axis[1], 0);
    z = finiteNumber(axis[2], 0);
    const length = Math.hypot(x, y, z);
    if (length > 0 && Number.isFinite(length)) {
      x /= length;
      y /= length;
      z /= length;
    } else {
      x = 0;
      y = 1;
      z = 0;
    }
  } else y = 1;
  const a = finiteNumber(angle, 0);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  return new Float64Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,
  ]);
}

/** Writes Rx(pitch) × Ry(yaw) into a reusable buffer for the animation loop. */
export function writeRotation(pitch, yaw, out) {
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  out[0] = cy;
  out[1] = sx * sy;
  out[2] = -cx * sy;
  out[3] = 0;
  out[4] = cx;
  out[5] = sx;
  out[6] = sy;
  out[7] = -sx * cy;
  out[8] = cx * cy;
  return out;
}

/**
 * A petal is a polar sheet P(u,v) = (r cos θ, h, r sin θ).
 * u spans the petal's angular width; v is its height parameter.
 * Angular twist and a rolled lip give each sheet curvature in all three axes.
 */
function petalSurface(layer, petal, u, v, out, offset) {
  const spread = layer / 4;
  const n = PETALS_PER_LAYER[layer];
  const baseRadius = 0.075 + layer * 0.07;
  const radius = 0.27 + layer * 0.325;
  const height = 1.82 - layer * 0.075;
  const opening = Math.pow(Math.sin(v * Math.PI * 0.5), 1.12);
  const curl = smoothstep(0.72, 1, v);
  const theta = petal * TAU / n + layer * GOLDEN_ANGLE
    + u * (Math.PI / n) * 1.19 * opening
    - (0.5 + 0.12 * spread) * (1 - v) + 0.09 * Math.sin(v * Math.PI);
  const belly = Math.pow(Math.sin(v * Math.PI * (0.5 + 0.18 * spread)), 0.92);
  const r = baseRadius + (radius - baseRadius) * belly * (1 - 0.12 * u * u)
    + 0.095 * spread * Math.sin(v * Math.PI) + (0.026 + 0.17 * spread) * curl;
  const y = 0.4 + height * v - (0.12 + 0.19 * spread) * u * u * v * v * v
    - (0.025 + 0.16 * spread) * curl * curl
    + 0.028 * Math.sin(theta * 3 + layer) * v * v;
  out[offset] = r * Math.cos(theta);
  out[offset + 1] = y;
  out[offset + 2] = r * Math.sin(theta);
}

function stemCenter(t, out, offset) {
  out[offset] = 0.09 * Math.sin(t * 4.3) - 0.026;
  out[offset + 1] = -3.22 + 3.72 * t;
  out[offset + 2] = 0.085 * Math.sin(t * 4.7 + 0.3);
}

function leafSurface(leaf, u, v, out, offset) {
  const angle = leaf === 0 ? 3.02 : -0.29;
  const length = leaf === 0 ? 1.48 : 1.27;
  const baseT = leaf === 0 ? 0.53 : 0.29;
  const baseX = 0.09 * Math.sin(baseT * 4.3) - 0.026;
  const baseY = -3.22 + 3.72 * baseT;
  const baseZ = 0.085 * Math.sin(baseT * 4.7 + 0.3);
  const width = 0.49 * Math.pow(Math.max(0, Math.sin(Math.PI * v)), 0.84)
    * (1 + 0.045 * Math.sin(v * Math.PI * 19));
  const twist = -0.35 + v * 0.76 + leaf * 0.2;
  const across = u * width;
  const along = length * v;
  out[offset] = baseX + Math.cos(angle) * along - Math.sin(angle) * across * Math.cos(twist);
  out[offset + 1] = baseY + 0.66 * v + 0.1 * Math.sin(v * Math.PI)
    + 0.17 * (1 - Math.abs(u)) * Math.sin(v * Math.PI) + across * Math.sin(twist);
  out[offset + 2] = baseZ + Math.sin(angle) * along + Math.cos(angle) * across * Math.cos(twist);
}

function sepalSurface(sepal, u, v, out, offset) {
  const theta = sepal * TAU / 5 + u * 0.24 * Math.sin(v * Math.PI);
  const radius = 0.1 + 0.67 * v;
  out[offset] = Math.cos(theta) * radius;
  out[offset + 1] = 0.48 - 0.34 * v + 0.11 * Math.sin(v * Math.PI) - 0.065 * u * u;
  out[offset + 2] = Math.sin(theta) * radius;
}

function writeNormal(samples, normals, offset) {
  const ux = samples[3] - samples[0];
  const uy = samples[4] - samples[1];
  const uz = samples[5] - samples[2];
  const vx = samples[6] - samples[0];
  const vy = samples[7] - samples[1];
  const vz = samples[8] - samples[2];
  const x = vy * uz - vz * uy;
  const y = vz * ux - vx * uz;
  const z = vx * uy - vy * ux;
  const inverse = 1 / (Math.hypot(x, y, z) || 1);
  normals[offset] = x * inverse;
  normals[offset + 1] = y * inverse;
  normals[offset + 2] = z * inverse;
}

/**
 * count (or points): 3000…200000; seed: deterministic variation.
 * The optional normals are surface derivatives, used for lighting, not textures.
 * A deterministic shuffle makes any prefix a complete, lower-density specimen.
 */
export function buildRosePoints(options = {}) {
  const requested = finiteNumber(options?.count ?? options?.points ?? options?.pointCount, 24000);
  const count = clamp(Math.round(requested), MIN_POINTS, MAX_POINTS);
  const seed = finiteNumber(options?.seed, 17) >>> 0;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const samples = new Float64Array(9);
  const blossomCount = Math.floor(count * 0.79);
  const stemCount = Math.floor(count * 0.064);
  const leafCount = Math.floor(count * 0.116);
  const sepalCount = count - blossomCount - stemCount - leafCount;
  const weights = new Float64Array(5);
  let totalWeight = 0;
  for (let layer = 0; layer < 5; layer++) {
    weights[layer] = (0.27 + layer * 0.325) * (1.82 - layer * 0.075);
    totalWeight += weights[layer];
  }
  let cursor = 0;
  for (let layer = 0; layer < 5; layer++) {
    const layerCount = layer === 4 ? blossomCount - cursor : Math.floor(blossomCount * weights[layer] / totalWeight);
    const petalCount = PETALS_PER_LAYER[layer];
    let layerWritten = 0;
    for (let petal = 0; petal < petalCount; petal++) {
      const amount = petal === petalCount - 1 ? layerCount - layerWritten : Math.floor(layerCount / petalCount);
      const shift = hash01(seed + layer * 49 + petal * 13);
      for (let i = 0; i < amount; i++) {
        let u = 2 * (i + 0.5) / amount - 1;
        let v = Math.sqrt((radicalInverse(i + 1) + shift) % 1);
        if (i % 13 === 0) v = 0.988 + 0.008 * hash01(i + petal);
        if (i % 29 === 0) u = i % 2 ? 0.993 : -0.993;
        const offset = cursor * 3;
        petalSurface(layer, petal, u, v, positions, offset);
        petalSurface(layer, petal, u, v, samples, 0);
        petalSurface(layer, petal, u + 0.001, v, samples, 3);
        petalSurface(layer, petal, u, v + 0.001, samples, 6);
        writeNormal(samples, normals, offset);
        const rim = smoothstep(0.5, 1, v);
        const variation = 0.85 + 0.15 * hash01(cursor + seed);
        const pink = rim * 0.78 + layer * 0.045;
        colors[offset] = (0.69 + 0.3 * rim) * variation;
        colors[offset + 1] = (0.04 + 0.35 * pink) * variation;
        colors[offset + 2] = (0.115 + 0.34 * pink) * variation;
        cursor++;
      }
      layerWritten += amount;
    }
  }
  for (let i = 0; i < stemCount; i++) {
    const t = (i + 0.5) / stemCount;
    const angle = TAU * radicalInverse(i + 1);
    const radius = 0.047 + 0.015 * t;
    const offset = cursor * 3;
    stemCenter(t, positions, offset);
    positions[offset] += radius * Math.cos(angle);
    positions[offset + 2] += radius * Math.sin(angle);
    normals[offset] = Math.cos(angle);
    normals[offset + 1] = -0.045 * Math.cos(angle);
    normals[offset + 2] = Math.sin(angle);
    colors[offset] = 0.15 + 0.07 * t;
    colors[offset + 1] = 0.51 + 0.3 * t;
    colors[offset + 2] = 0.095 + 0.08 * t;
    cursor++;
  }
  for (let i = 0; i < leafCount; i++) {
    const leaf = i % 2;
    const j = Math.floor(i / 2);
    const amount = Math.ceil(leafCount / 2);
    const v = (j + 0.5) / amount;
    let u = 2 * radicalInverse(j + 1 + leaf * 37) - 1;
    if (j % 9 === 0) u = 0;
    if (j % 17 === 0) u = j % 2 ? 0.987 : -0.987;
    const offset = cursor * 3;
    leafSurface(leaf, u, v, positions, offset);
    leafSurface(leaf, u, v, samples, 0);
    leafSurface(leaf, u + 0.001, v, samples, 3);
    leafSurface(leaf, u, Math.min(0.99999, v + 0.001), samples, 6);
    writeNormal(samples, normals, offset);
    const vein = Math.pow(1 - Math.abs(u), 12);
    const light = 0.76 + 0.17 * hash01(i + seed) + 0.13 * vein;
    colors[offset] = (0.15 + 0.1 * vein + 0.035 * v) * light;
    colors[offset + 1] = Math.min(1, (0.61 + 0.29 * vein + 0.05 * v) * light);
    colors[offset + 2] = (0.1 + 0.08 * vein) * light;
    cursor++;
  }
  for (let i = 0; i < sepalCount; i++) {
    const sepal = i % 5;
    const u = 2 * radicalInverse(i + 1) - 1;
    const v = (Math.floor(i / 5) + 0.5) / Math.ceil(sepalCount / 5);
    const offset = cursor * 3;
    sepalSurface(sepal, u, v, positions, offset);
    sepalSurface(sepal, u, v, samples, 0);
    sepalSurface(sepal, u + 0.001, v, samples, 3);
    sepalSurface(sepal, u, v + 0.001, samples, 6);
    writeNormal(samples, normals, offset);
    colors[offset] = 0.15 + 0.06 * v;
    colors[offset + 1] = 0.38 + 0.23 * v;
    colors[offset + 2] = 0.09 + 0.06 * v;
    cursor++;
  }
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(hash01(i + seed * 97) * (i + 1));
    for (let component = 0; component < 3; component++) {
      const a = i * 3 + component;
      const b = j * 3 + component;
      let swap = positions[a]; positions[a] = positions[b]; positions[b] = swap;
      swap = colors[a]; colors[a] = colors[b]; colors[b] = swap;
      swap = normals[a]; normals[a] = normals[b]; normals[b] = swap;
    }
  }
  return { positions, colors, normals, count };
}
