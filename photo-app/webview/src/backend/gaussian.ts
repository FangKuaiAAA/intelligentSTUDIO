import type { QualityPreset } from '../shared/types';
import {
  DEFAULT_MAX_GAUSSIANS_BALANCED,
  DEFAULT_MAX_GAUSSIANS_HIGH,
  DEFAULT_OPACITY_THRESHOLD,
} from '../shared/constants';

// 三轴尺度的最大比例。模型偶尔输出某一轴趋近 0 的极扁高斯，反投影后
// 在屏幕上退化成放射状星芒伪影；正常表面结构的三轴比 p99 约为 6.8，
// 因此把上限收到 12 只会影响极端的退化样本。
const MAX_SCALE_ANISOTROPY = 12;

export interface GaussianBuffers {
  count: number;
  meanVectors: Float32Array;
  singularValues: Float32Array;
  quaternions: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
}

export interface PruneResult {
  pruned: GaussianBuffers;
  totalCount: number;
}

function copyTriplets(source: Float32Array, indices: number[]): Float32Array {
  const out = new Float32Array(indices.length * 3);
  let dst = 0;
  for (const index of indices) {
    const src = index * 3;
    out[dst++] = source[src];
    out[dst++] = source[src + 1];
    out[dst++] = source[src + 2];
  }
  return out;
}

function copyQuads(source: Float32Array, indices: number[]): Float32Array {
  const out = new Float32Array(indices.length * 4);
  let dst = 0;
  for (const index of indices) {
    const src = index * 4;
    out[dst++] = source[src];
    out[dst++] = source[src + 1];
    out[dst++] = source[src + 2];
    out[dst++] = source[src + 3];
  }
  return out;
}

function copySingles(source: Float32Array, indices: number[]): Float32Array {
  const out = new Float32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = source[indices[i]];
  return out;
}

export function maxGaussiansForPreset(preset: QualityPreset = 'balanced'): number {
  if (preset === 'high') return DEFAULT_MAX_GAUSSIANS_HIGH;
  if (preset === 'full') return 0;
  return DEFAULT_MAX_GAUSSIANS_BALANCED;
}

export function pruneGaussians(
  meanVectors: Float32Array,
  singularValues: Float32Array,
  quaternions: Float32Array,
  colors: Float32Array,
  opacities: Float32Array,
  preset: QualityPreset = 'balanced',
  options: { opacityThreshold?: number; maxGaussians?: number } = {},
): PruneResult {
  const totalCount = opacities.length;
  const threshold = Number.isFinite(options.opacityThreshold)
    ? Math.max(0, Math.min(1, options.opacityThreshold!))
    : DEFAULT_OPACITY_THRESHOLD;
  const maxGaussians = Number.isFinite(options.maxGaussians)
    ? Math.max(0, Math.floor(options.maxGaussians!))
    : maxGaussiansForPreset(preset);
  if (threshold <= 0 && maxGaussians === 0) {
    return {
      totalCount,
      pruned: {
        count: totalCount,
        meanVectors,
        singularValues,
        quaternions,
        colors,
        opacities,
      },
    };
  }

  const selected: number[] = [];

  for (let i = 0; i < totalCount; i++) {
    if (opacities[i] >= threshold) selected.push(i);
  }
  if (selected.length === 0) {
    for (let i = 0; i < totalCount; i++) selected.push(i);
  }
  if (maxGaussians > 0 && selected.length > maxGaussians) {
    selected.sort((a, b) => opacities[b] - opacities[a]);
    selected.length = maxGaussians;
    selected.sort((a, b) => a - b);
  }

  return {
    totalCount,
    pruned: {
      count: selected.length,
      meanVectors: copyTriplets(meanVectors, selected),
      singularValues: copyTriplets(singularValues, selected),
      quaternions: copyQuads(quaternions, selected),
      colors: copyTriplets(colors, selected),
      opacities: copySingles(opacities, selected),
    },
  };
}

function quaternionToRotationMatrix(
  qw: number,
  qx: number,
  qy: number,
  qz: number,
): [number, number, number, number, number, number, number, number, number] {
  const norm = Math.hypot(qw, qx, qy, qz) || 1;
  const w = qw / norm;
  const x = qx / norm;
  const y = qy / norm;
  const z = qz / norm;
  const ww = w * w;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  return [
    ww + xx - yy - zz, 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), ww - xx + yy - zz, 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), ww - xx - yy + zz,
  ];
}

function jacobiRotate(matrix: Float64Array, vectors: Float64Array, p: number, q: number): void {
  const pp = p * 3 + p;
  const qq = q * 3 + q;
  const pq = p * 3 + q;
  const apq = matrix[pq];
  if (Math.abs(apq) < 1e-18) return;
  const app = matrix[pp];
  const aqq = matrix[qq];
  const tau = (aqq - app) / (2 * apq);
  const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau));
  const c = 1 / Math.sqrt(1 + t * t);
  const s = t * c;

  for (let k = 0; k < 3; k++) {
    if (k === p || k === q) continue;
    const kp = k * 3 + p;
    const pk = p * 3 + k;
    const kq = k * 3 + q;
    const qk = q * 3 + k;
    const mkp = matrix[kp];
    const mkq = matrix[kq];
    matrix[kp] = c * mkp - s * mkq;
    matrix[pk] = matrix[kp];
    matrix[kq] = s * mkp + c * mkq;
    matrix[qk] = matrix[kq];
  }

  matrix[pp] = c * c * app - 2 * s * c * apq + s * s * aqq;
  matrix[qq] = s * s * app + 2 * s * c * apq + c * c * aqq;
  matrix[pq] = 0;
  matrix[q * 3 + p] = 0;

  for (let k = 0; k < 3; k++) {
    const kp = k * 3 + p;
    const kq = k * 3 + q;
    const vkp = vectors[kp];
    const vkq = vectors[kq];
    vectors[kp] = c * vkp - s * vkq;
    vectors[kq] = s * vkp + c * vkq;
  }
}

function eigenSymmetric3x3(matrix: Float64Array, vectors: Float64Array): void {
  vectors.fill(0);
  vectors[0] = 1;
  vectors[4] = 1;
  vectors[8] = 1;
  for (let sweep = 0; sweep < 8; sweep++) {
    if (Math.abs(matrix[1]) + Math.abs(matrix[2]) + Math.abs(matrix[5]) < 1e-14) break;
    jacobiRotate(matrix, vectors, 0, 1);
    jacobiRotate(matrix, vectors, 0, 2);
    jacobiRotate(matrix, vectors, 1, 2);
  }
}

function swapEigen(vectors: Float64Array, eigenvalues: Float64Array, a: number, b: number): void {
  const value = eigenvalues[a];
  eigenvalues[a] = eigenvalues[b];
  eigenvalues[b] = value;
  for (let row = 0; row < 3; row++) {
    const ia = row * 3 + a;
    const ib = row * 3 + b;
    const temp = vectors[ia];
    vectors[ia] = vectors[ib];
    vectors[ib] = temp;
  }
}

function sortEigenpairs(eigenvalues: Float64Array, vectors: Float64Array): void {
  if (eigenvalues[0] < eigenvalues[1]) swapEigen(vectors, eigenvalues, 0, 1);
  if (eigenvalues[1] < eigenvalues[2]) swapEigen(vectors, eigenvalues, 1, 2);
  if (eigenvalues[0] < eigenvalues[1]) swapEigen(vectors, eigenvalues, 0, 1);
}

function ensureProperRotation(vectors: Float64Array): void {
  const det =
    vectors[0] * (vectors[4] * vectors[8] - vectors[5] * vectors[7]) -
    vectors[1] * (vectors[3] * vectors[8] - vectors[5] * vectors[6]) +
    vectors[2] * (vectors[3] * vectors[7] - vectors[4] * vectors[6]);
  if (det < 0) {
    vectors[2] *= -1;
    vectors[5] *= -1;
    vectors[8] *= -1;
  }
}

function quaternionFromRotationMatrix(r: Float64Array): [number, number, number, number] {
  const trace = r[0] + r[4] + r[8];
  let qw: number;
  let qx: number;
  let qy: number;
  let qz: number;
  if (trace > 0) {
    const s = 2 * Math.sqrt(Math.max(1e-12, trace + 1));
    qw = 0.25 * s; qx = (r[7] - r[5]) / s; qy = (r[2] - r[6]) / s; qz = (r[3] - r[1]) / s;
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + r[0] - r[4] - r[8]));
    qw = (r[7] - r[5]) / s; qx = 0.25 * s; qy = (r[1] + r[3]) / s; qz = (r[2] + r[6]) / s;
  } else if (r[4] > r[8]) {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + r[4] - r[0] - r[8]));
    qw = (r[2] - r[6]) / s; qx = (r[1] + r[3]) / s; qy = 0.25 * s; qz = (r[5] + r[7]) / s;
  } else {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + r[8] - r[0] - r[4]));
    qw = (r[3] - r[1]) / s; qx = (r[2] + r[6]) / s; qy = (r[5] + r[7]) / s; qz = 0.25 * s;
  }
  const norm = Math.hypot(qw, qx, qy, qz) || 1;
  return [qw / norm, qx / norm, qy / norm, qz / norm];
}

export function unprojectGaussiansInPlace(gaussians: GaussianBuffers, scaleX: number, scaleY: number): void {
  const matrix = new Float64Array(9);
  const vectors = new Float64Array(9);
  const eigenvalues = new Float64Array(3);

  for (let i = 0; i < gaussians.count; i++) {
    const idx3 = i * 3;
    const idx4 = i * 4;
    gaussians.meanVectors[idx3] *= scaleX;
    gaussians.meanVectors[idx3 + 1] *= scaleY;

    const r = quaternionToRotationMatrix(
      gaussians.quaternions[idx4],
      gaussians.quaternions[idx4 + 1],
      gaussians.quaternions[idx4 + 2],
      gaussians.quaternions[idx4 + 3],
    );
    const v0 = gaussians.singularValues[idx3] ** 2;
    const v1 = gaussians.singularValues[idx3 + 1] ** 2;
    const v2 = gaussians.singularValues[idx3 + 2] ** 2;
    const c00 = r[0] * r[0] * v0 + r[1] * r[1] * v1 + r[2] * r[2] * v2;
    const c01 = r[0] * r[3] * v0 + r[1] * r[4] * v1 + r[2] * r[5] * v2;
    const c02 = r[0] * r[6] * v0 + r[1] * r[7] * v1 + r[2] * r[8] * v2;
    const c11 = r[3] * r[3] * v0 + r[4] * r[4] * v1 + r[5] * r[5] * v2;
    const c12 = r[3] * r[6] * v0 + r[4] * r[7] * v1 + r[5] * r[8] * v2;
    const c22 = r[6] * r[6] * v0 + r[7] * r[7] * v1 + r[8] * r[8] * v2;

    matrix[0] = c00 * scaleX * scaleX;
    matrix[1] = c01 * scaleX * scaleY;
    matrix[2] = c02 * scaleX;
    matrix[3] = matrix[1];
    matrix[4] = c11 * scaleY * scaleY;
    matrix[5] = c12 * scaleY;
    matrix[6] = matrix[2];
    matrix[7] = matrix[5];
    matrix[8] = c22;

    eigenSymmetric3x3(matrix, vectors);
    eigenvalues[0] = matrix[0];
    eigenvalues[1] = matrix[4];
    eigenvalues[2] = matrix[8];
    sortEigenpairs(eigenvalues, vectors);
    ensureProperRotation(vectors);

    // 把最小特征值抬到最大值的 1/(12²)，保证三轴尺度比不超过 12:1。
    // 极端扁平的样本会退化成屏幕上的星芒，这里从源头压住。
    const maxEigen = Math.max(eigenvalues[0], eigenvalues[1], eigenvalues[2]);
    const minEigen = Math.max(maxEigen / (MAX_SCALE_ANISOTROPY * MAX_SCALE_ANISOTROPY), 1e-12);

    gaussians.singularValues[idx3] = Math.sqrt(Math.max(eigenvalues[0], minEigen));
    gaussians.singularValues[idx3 + 1] = Math.sqrt(Math.max(eigenvalues[1], minEigen));
    gaussians.singularValues[idx3 + 2] = Math.sqrt(Math.max(eigenvalues[2], minEigen));
    const [qw, qx, qy, qz] = quaternionFromRotationMatrix(vectors);
    gaussians.quaternions[idx4] = qw;
    gaussians.quaternions[idx4 + 1] = qx;
    gaussians.quaternions[idx4 + 2] = qy;
    gaussians.quaternions[idx4 + 3] = qz;
  }
}
