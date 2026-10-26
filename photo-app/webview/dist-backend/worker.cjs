"use strict";
const path = require("path");
const readline = require("readline");
const ort = require("onnxruntime-node");
const fs = require("fs");
const sharp = require("sharp");
const os = require("os");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const readline__namespace = /* @__PURE__ */ _interopNamespaceDefault(readline);
const ort__namespace = /* @__PURE__ */ _interopNamespaceDefault(ort);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const os__namespace = /* @__PURE__ */ _interopNamespaceDefault(os);
const INPUT_IMAGE_SIZE = 1536;
const DEFAULT_OPACITY_THRESHOLD = 0;
const DEFAULT_MAX_GAUSSIANS_BALANCED = 2e5;
const DEFAULT_MAX_GAUSSIANS_HIGH = 5e5;
const DEFAULT_FOCAL_MM = 30;
const FILM_35MM_DIAGONAL_MM = 43.266615305567875;
const SUPPORTED_FORMATS = /* @__PURE__ */ new Set(["jpg", "jpeg", "png", "heic", "heif", "webp"]);
function getExtension(filePath) {
  return filePath.split(".").pop()?.toLowerCase() ?? "";
}
function focalMmToPx(width, height, focalMm) {
  return focalMm * Math.hypot(width, height) / FILM_35MM_DIAGONAL_MM;
}
async function estimateFocalPx(imagePath, width, height, override) {
  if (override && Number.isFinite(override) && override > 0) {
    return { focalPx: override, source: "manual" };
  }
  return {
    focalPx: focalMmToPx(width, height, DEFAULT_FOCAL_MM),
    source: "default-30mm"
  };
}
async function prepareImage(imagePath, focalPxOverride) {
  const ext = getExtension(imagePath);
  if (!SUPPORTED_FORMATS.has(ext)) {
    throw new Error(`Unsupported image format .${ext}`);
  }
  const buffer = await fs__namespace.promises.readFile(imagePath);
  const metadata = await sharp(buffer).rotate().metadata();
  const width = metadata.width ?? INPUT_IMAGE_SIZE;
  const height = metadata.height ?? INPUT_IMAGE_SIZE;
  const focal = await estimateFocalPx(imagePath, width, height, focalPxOverride);
  const { data, info } = await sharp(buffer).rotate().resize(INPUT_IMAGE_SIZE, INPUT_IMAGE_SIZE, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  const nchw = new Float32Array(3 * pixelCount);
  let pixelOffset = 0;
  for (let i = 0; i < pixelCount; i++) {
    nchw[i] = data[pixelOffset] / 255;
    nchw[pixelCount + i] = data[pixelOffset + 1] / 255;
    nchw[pixelCount * 2 + i] = data[pixelOffset + 2] / 255;
    pixelOffset += info.channels;
  }
  return {
    tensor: new ort__namespace.Tensor("float32", nchw, [1, 3, INPUT_IMAGE_SIZE, INPUT_IMAGE_SIZE]),
    width,
    height,
    focalPx: focal.focalPx,
    focalSource: focal.source
  };
}
const MAX_SCALE_ANISOTROPY = 12;
function copyTriplets(source, indices) {
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
function copyQuads(source, indices) {
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
function copySingles(source, indices) {
  const out = new Float32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = source[indices[i]];
  return out;
}
function maxGaussiansForPreset(preset = "balanced") {
  if (preset === "high") return DEFAULT_MAX_GAUSSIANS_HIGH;
  if (preset === "full") return 0;
  return DEFAULT_MAX_GAUSSIANS_BALANCED;
}
function pruneGaussians(meanVectors, singularValues, quaternions, colors, opacities, preset = "balanced", options = {}) {
  const totalCount = opacities.length;
  const threshold = Number.isFinite(options.opacityThreshold) ? Math.max(0, Math.min(1, options.opacityThreshold)) : DEFAULT_OPACITY_THRESHOLD;
  const maxGaussians = Number.isFinite(options.maxGaussians) ? Math.max(0, Math.floor(options.maxGaussians)) : maxGaussiansForPreset(preset);
  if (threshold <= 0 && maxGaussians === 0) {
    return {
      totalCount,
      pruned: {
        count: totalCount,
        meanVectors,
        singularValues,
        quaternions,
        colors,
        opacities
      }
    };
  }
  const selected = [];
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
      opacities: copySingles(opacities, selected)
    }
  };
}
function quaternionToRotationMatrix(qw, qx, qy, qz) {
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
    ww + xx - yy - zz,
    2 * (xy - wz),
    2 * (xz + wy),
    2 * (xy + wz),
    ww - xx + yy - zz,
    2 * (yz - wx),
    2 * (xz - wy),
    2 * (yz + wx),
    ww - xx - yy + zz
  ];
}
function jacobiRotate(matrix, vectors, p, q) {
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
function eigenSymmetric3x3(matrix, vectors) {
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
function swapEigen(vectors, eigenvalues, a, b) {
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
function sortEigenpairs(eigenvalues, vectors) {
  if (eigenvalues[0] < eigenvalues[1]) swapEigen(vectors, eigenvalues, 0, 1);
  if (eigenvalues[1] < eigenvalues[2]) swapEigen(vectors, eigenvalues, 1, 2);
  if (eigenvalues[0] < eigenvalues[1]) swapEigen(vectors, eigenvalues, 0, 1);
}
function ensureProperRotation(vectors) {
  const det = vectors[0] * (vectors[4] * vectors[8] - vectors[5] * vectors[7]) - vectors[1] * (vectors[3] * vectors[8] - vectors[5] * vectors[6]) + vectors[2] * (vectors[3] * vectors[7] - vectors[4] * vectors[6]);
  if (det < 0) {
    vectors[2] *= -1;
    vectors[5] *= -1;
    vectors[8] *= -1;
  }
}
function quaternionFromRotationMatrix(r) {
  const trace = r[0] + r[4] + r[8];
  let qw;
  let qx;
  let qy;
  let qz;
  if (trace > 0) {
    const s = 2 * Math.sqrt(Math.max(1e-12, trace + 1));
    qw = 0.25 * s;
    qx = (r[7] - r[5]) / s;
    qy = (r[2] - r[6]) / s;
    qz = (r[3] - r[1]) / s;
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + r[0] - r[4] - r[8]));
    qw = (r[7] - r[5]) / s;
    qx = 0.25 * s;
    qy = (r[1] + r[3]) / s;
    qz = (r[2] + r[6]) / s;
  } else if (r[4] > r[8]) {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + r[4] - r[0] - r[8]));
    qw = (r[2] - r[6]) / s;
    qx = (r[1] + r[3]) / s;
    qy = 0.25 * s;
    qz = (r[5] + r[7]) / s;
  } else {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + r[8] - r[0] - r[4]));
    qw = (r[3] - r[1]) / s;
    qx = (r[2] + r[6]) / s;
    qy = (r[5] + r[7]) / s;
    qz = 0.25 * s;
  }
  const norm = Math.hypot(qw, qx, qy, qz) || 1;
  return [qw / norm, qx / norm, qy / norm, qz / norm];
}
function unprojectGaussiansInPlace(gaussians, scaleX, scaleY) {
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
      gaussians.quaternions[idx4 + 3]
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
const SH_COEFF_DEG0 = Math.sqrt(1 / (4 * Math.PI));
const INV_SH_COEFF_DEG0 = 1 / SH_COEFF_DEG0;
function clamp01(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
function linearToSrgb(value) {
  const x = clamp01(value);
  return x <= 31308e-7 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}
function rgbToSh0(rgb) {
  return (rgb - 0.5) * INV_SH_COEFF_DEG0;
}
function safeLog(value, epsilon = 1e-8) {
  return Math.log(Math.max(value, epsilon));
}
function safeLogit(value, epsilon = 1e-6) {
  const x = Math.min(1 - epsilon, Math.max(epsilon, value));
  return Math.log(x / (1 - x));
}
function buildHeader(vertexCount) {
  return [
    "ply",
    "format binary_little_endian 1.0",
    "comment generated by sharp-viewer",
    `element vertex ${vertexCount}`,
    "property float x",
    "property float y",
    "property float z",
    "property float f_dc_0",
    "property float f_dc_1",
    "property float f_dc_2",
    "property float opacity",
    "property float scale_0",
    "property float scale_1",
    "property float scale_2",
    "property float rot_0",
    "property float rot_1",
    "property float rot_2",
    "property float rot_3",
    "end_header",
    ""
  ].join("\n");
}
function buildPlyBinary(input) {
  const { count, meanVectors, singularValues, quaternions, colors, opacities } = input;
  if (meanVectors.length !== count * 3) throw new Error("meanVectors length mismatch");
  if (singularValues.length !== count * 3) throw new Error("singularValues length mismatch");
  if (quaternions.length !== count * 4) throw new Error("quaternions length mismatch");
  if (colors.length !== count * 3) throw new Error("colors length mismatch");
  if (opacities.length !== count) throw new Error("opacities length mismatch");
  const header = Buffer.from(buildHeader(count), "utf8");
  const vertexBytes = count * 14 * 4;
  const output = Buffer.alloc(header.length + vertexBytes);
  header.copy(output, 0);
  let offset = header.length;
  const writeFloat = (value) => {
    output.writeFloatLE(value, offset);
    offset += 4;
  };
  for (let i = 0; i < count; i++) {
    const v3 = i * 3;
    const v4 = i * 4;
    const x = meanVectors[v3];
    const y = meanVectors[v3 + 1];
    const z = meanVectors[v3 + 2];
    writeFloat(x);
    writeFloat(y);
    writeFloat(z);
    writeFloat(rgbToSh0(linearToSrgb(colors[v3])));
    writeFloat(rgbToSh0(linearToSrgb(colors[v3 + 1])));
    writeFloat(rgbToSh0(linearToSrgb(colors[v3 + 2])));
    writeFloat(safeLogit(opacities[i]));
    writeFloat(safeLog(singularValues[v3]));
    writeFloat(safeLog(singularValues[v3 + 1]));
    writeFloat(safeLog(singularValues[v3 + 2]));
    writeFloat(quaternions[v4]);
    writeFloat(quaternions[v4 + 1]);
    writeFloat(quaternions[v4 + 2]);
    writeFloat(quaternions[v4 + 3]);
  }
  if (offset !== output.length) throw new Error(`PLY size mismatch (${offset} != ${output.length})`);
  return output;
}
async function writePlyFile(input, outputDir, taskId) {
  await fs__namespace.promises.mkdir(outputDir, { recursive: true });
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "");
  const plyPath = path__namespace.join(outputDir, `sharp_${safeTaskId}_${Date.now()}.ply`);
  await fs__namespace.promises.writeFile(plyPath, buildPlyBinary(input));
  return plyPath;
}
const PROVIDER_ALIASES = {
  dml: "dml",
  directml: "dml",
  webgpu: "webgpu",
  cuda: "cuda",
  coreml: "coreml",
  cpu: "cpu"
};
function normalizeProvider(name) {
  return PROVIDER_ALIASES[name.toLowerCase()] ?? null;
}
function getPreferredProviders() {
  const forced = process.env.SHARP_VIEWER_FORCE_BACKEND;
  if (forced) {
    const provider = normalizeProvider(forced);
    return provider && provider !== "cpu" ? [provider, "cpu"] : ["cpu"];
  }
  const platform = os__namespace.platform();
  if (platform === "win32") return ["webgpu", "cpu"];
  if (platform === "linux") return ["cuda", "webgpu", "cpu"];
  if (platform === "darwin") return ["coreml", "webgpu", "cpu"];
  return ["cpu"];
}
async function getSupportedProviders() {
  const backends = await ort__namespace.listSupportedBackends();
  const providers = backends.map((backend) => normalizeProvider(backend.name)).filter((backend) => backend !== null);
  return Array.from(new Set(providers));
}
async function resolveProviders(preferred) {
  const supported = await getSupportedProviders();
  const resolved = preferred.filter((provider) => supported.includes(provider));
  return resolved.includes("cpu") ? resolved : [...resolved, "cpu"];
}
function toOrtProvider(provider) {
  return provider === "dml" ? "dml" : provider;
}
async function getRuntimeCapabilities(preferredProviders = getPreferredProviders()) {
  const supportedProviders = await getSupportedProviders();
  return {
    platform: os__namespace.platform(),
    arch: os__namespace.arch(),
    preferredProviders,
    supportedProviders,
    nodeVersion: process.version,
    onnxRuntimeVersion: ort__namespace.env.versions?.node ?? ort__namespace.env.versions?.common ?? "unknown"
  };
}
let cachedSession = null;
let cachedProviderKey = "";
function tensorData(outputs, key) {
  const value = outputs[key];
  if (!value || !(value.data instanceof Float32Array)) {
    throw new Error(`Missing float32 output '${key}'. Available: ${Object.keys(outputs).join(", ")}`);
  }
  return value.data;
}
function assertNotCancelled(isCancelled) {
  if (isCancelled?.()) throw new Error("Inference cancelled");
}
async function releaseSession() {
  if (cachedSession) {
    await cachedSession.release();
    cachedSession = null;
    cachedProviderKey = "";
  }
}
async function getSession(modelPath, providers) {
  const providerKey = providers.join(",");
  if (cachedSession && cachedProviderKey === `${modelPath}|${providerKey}`) return cachedSession;
  await releaseSession();
  cachedSession = await ort__namespace.InferenceSession.create(modelPath, {
    graphOptimizationLevel: "all",
    executionProviders: providers.map(toOrtProvider)
  });
  cachedProviderKey = `${modelPath}|${providerKey}`;
  return cachedSession;
}
async function runOnProviders(modelPath, providers, imageTensor, disparityFactor) {
  const session = await getSession(modelPath, providers);
  const outputs = await session.run({
    image: imageTensor,
    disparity_factor: new ort__namespace.Tensor("float32", new Float32Array([disparityFactor]), [1])
  });
  return { outputs, backend: providers[0] ?? "cpu" };
}
async function runSharpInference({
  taskId,
  request,
  config,
  onStatus,
  isCancelled
}) {
  const startedAt = Date.now();
  const status = (stage, message, progress, backend2) => {
    onStatus?.({ taskId, stage, message, progress, backend: backend2 });
  };
  status("loading-model", "Loading ONNX Runtime backend...", 5);
  const providers = await resolveProviders(config.preferredProviders);
  const primaryProviders = providers.length > 0 ? providers : ["cpu"];
  assertNotCancelled(isCancelled);
  status("preprocessing", "Preparing image tensor...", 12, primaryProviders[0]);
  const image = await prepareImage(request.imagePath, request.focalPxOverride);
  assertNotCancelled(isCancelled);
  status("running-inference", `Running SHARP with ${primaryProviders[0].toUpperCase()}...`, 25, primaryProviders[0]);
  let outputs;
  let backend = primaryProviders[0];
  try {
    ({ outputs, backend } = await runOnProviders(
      config.modelPath,
      primaryProviders,
      image.tensor,
      image.focalPx / image.width
    ));
  } catch (error) {
    if (primaryProviders.length === 1 && primaryProviders[0] === "cpu") throw error;
    status("running-inference", `GPU failed, retrying on CPU: ${String(error)}`, 30, "cpu");
    await releaseSession();
    ({ outputs, backend } = await runOnProviders(
      config.modelPath,
      ["cpu"],
      image.tensor,
      image.focalPx / image.width
    ));
  }
  assertNotCancelled(isCancelled);
  status("postprocessing", "Filtering Gaussians...", 70, backend);
  const meanVectors = tensorData(outputs, "mean_vectors_ndc");
  const singularValues = tensorData(outputs, "singular_values_ndc");
  const quaternions = tensorData(outputs, "quaternions_ndc");
  const colors = tensorData(outputs, "colors");
  const opacities = tensorData(outputs, "opacities");
  const { pruned, totalCount } = pruneGaussians(
    meanVectors,
    singularValues,
    quaternions,
    colors,
    opacities,
    request.qualityPreset ?? "balanced",
    {
      opacityThreshold: request.opacityThreshold,
      maxGaussians: request.maxGaussians
    }
  );
  status("postprocessing", "Converting NDC Gaussians to metric space...", 80, backend);
  unprojectGaussiansInPlace(pruned, image.width / (2 * image.focalPx), image.height / (2 * image.focalPx));
  assertNotCancelled(isCancelled);
  status("writing-ply", "Writing Gaussian splat PLY...", 92, backend);
  const plyPath = await writePlyFile(
    {
      ...pruned,
      imageWidth: image.width,
      imageHeight: image.height,
      focalPx: image.focalPx
    },
    config.outputDir,
    taskId
  );
  return {
    taskId,
    plyPath,
    backend,
    durationMs: Date.now() - startedAt,
    selectedGaussians: pruned.count,
    totalGaussians: totalCount,
    image: {
      width: image.width,
      height: image.height,
      focalPx: image.focalPx,
      focalSource: image.focalSource
    }
  };
}
const parentPort = process.parentPort;
const cancelledTasks = /* @__PURE__ */ new Set();
function post(message) {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  process.stdout.write(`${JSON.stringify(message)}
`);
}
function listen(handler) {
  if (parentPort) {
    parentPort.on("message", (event) => {
      const message = unwrapMessage(event);
      if (message) handler(message);
    });
    return;
  }
  const reader = readline__namespace.createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      const message = JSON.parse(text);
      if (message && typeof message === "object" && "type" in message) handler(message);
    } catch {
      process.stderr.write(`bad message: ${text.slice(0, 120)}
`);
    }
  });
}
function unwrapMessage(messageEvent) {
  const maybeEvent = messageEvent;
  const message = maybeEvent.data ?? messageEvent;
  if (!message || typeof message !== "object" || !("type" in message)) return null;
  return message;
}
async function handleRun(message) {
  const { taskId, payload, config } = message;
  cancelledTasks.delete(taskId);
  post({ type: "status", status: { taskId, stage: "queued", message: "Queued", progress: 0 } });
  try {
    const result = await runSharpInference({
      taskId,
      request: payload,
      config,
      onStatus: (status) => post({ type: "status", status }),
      isCancelled: () => cancelledTasks.has(taskId)
    });
    if (cancelledTasks.has(taskId)) {
      post({ type: "status", status: { taskId, stage: "cancelled", message: "Cancelled" } });
      return;
    }
    post({ type: "status", status: { taskId, stage: "ready", message: "Ready", progress: 100, backend: result.backend } });
    post({ type: "result", taskId, result });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const stage = text.toLowerCase().includes("cancel") ? "cancelled" : "failed";
    post({ type: "status", status: { taskId, stage, message: text } });
    post({ type: "error", taskId, error: text });
  } finally {
    cancelledTasks.delete(taskId);
  }
}
async function handleCapabilities(message) {
  const capabilities = await getRuntimeCapabilities(message.config.preferredProviders);
  post({ type: "capabilities", requestId: message.requestId, capabilities });
}
listen((message) => {
  if (message.type === "cancel") {
    if (message.taskId) cancelledTasks.add(message.taskId);
    return;
  }
  if (message.type === "capabilities") {
    void handleCapabilities(message);
    return;
  }
  if (message.type === "run") {
    void handleRun(message);
  }
});
async function runSmoke() {
  const imagePath = path__namespace.resolve(process.argv[3] ?? "output/test-image.jpg");
  const root = path__namespace.resolve(__dirname, "..", "..");
  const result = await runSharpInference({
    taskId: "smoke",
    request: { imagePath, qualityPreset: "balanced" },
    config: {
      modelPath: path__namespace.join(root, "models", "sharp_web_predictor.onnx"),
      outputDir: path__namespace.join(root, "output"),
      preferredProviders: getPreferredProviders()
    },
    onStatus: (status) => console.log(JSON.stringify(status))
  });
  console.log(JSON.stringify(result, null, 2));
}
if (!parentPort && process.argv.includes("--smoke")) {
  runSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
