// ============================================================
// renderer/api/external.ts — 图像重构供应商适配层
// ============================================================

import type {
  ReconstructionInputMode,
  ReconstructionModel,
  ReconstructionProvider,
  ReconstructionResolution,
} from '../../shared/types';
import {
  RECONSTRUCTION_REPAIR_MASK_COLOR,
  RECONSTRUCTION_USE_REPAIR_MASK_CAPTURE,
} from '../../shared/constants';

const KIE_API_BASE_URL = 'https://api.kie.ai';
const KIE_FILE_BASE_URL = 'https://kieai.redpandaai.co';
const KIE_MAX_POLL_MS = 15 * 60 * 1000;
const REPAIR_MASK_PROMPT =
  `Bright magenta regions (${RECONSTRUCTION_REPAIR_MASK_COLOR}) are repair masks, not real scene content. Remove every mask-colored area completely and reconstruct those marked regions naturally. Treat marked areas as the highest-priority damage regions.`;

export const SINGLE_IMAGE_RECONSTRUCTION_PROMPT =
  [
    'This image is a target preview render from the current viewer. Use it as the output view. Keep its exact camera angle, perspective, crop, composition, object placement, scale, lighting feel, and scene layout.',
    ...(RECONSTRUCTION_USE_REPAIR_MASK_CAPTURE ? [REPAIR_MASK_PROMPT] : []),
    'Repair only abnormal artifacts caused by the 3D preview or rendering process: warped or melted shapes, smeared textures, noisy splat fragments, floating dots, holes, broken contours, ghosting, patchy opacity, jagged edges, translucent fragments, and distorted surface details.',
    'Pay special attention to Gaussian splat view-change artifacts: stretched or torn edges, shredded contours, fibrous pull-apart shapes, rubbery smearing, surface tearing, texture dragging, duplicated edge fragments, and details that look ripped apart when the viewpoint changes. Repair these areas into coherent natural surfaces and clean object boundaries.',
    'Do not treat normal photographic blur as damage. Preserve background bokeh, depth-of-field blur, motion blur, soft focus, and naturally low-detail areas unless they contain obvious rendering artifacts.',
    ...(RECONSTRUCTION_USE_REPAIR_MASK_CAPTURE
      ? ['Preserve natural photographic blur unless it is inside or directly connected to a bright magenta repair mask.']
      : []),
    'Only repair blur that looks like a rendering artifact: warped, stretched, dirty, duplicated, patchy, broken, or structurally inconsistent.',
    'Preserve all correct parts. Do not stylize, beautify, redesign, replace the background, add new objects, remove real objects, or invent unsupported details.',
    'When uncertain, preserve the image rather than creating new detail. Return a clean, realistic version of the same view with rendering artifacts repaired and the natural photographic character preserved.',
  ].join('\n\n');

export const DUAL_IMAGE_RECONSTRUCTION_PROMPT =
  [
    'Image 1 is the target preview render from the current viewer. Use Image 1 as the output view. Keep its exact camera angle, perspective, crop, composition, object placement, scale, lighting feel, and scene layout.',
    'Image 2 is the original uploaded photo. Use Image 2 only as a reference for the true appearance: colors, materials, textures, object boundaries, natural photographic blur, and missing or unclear details.',
    ...(RECONSTRUCTION_USE_REPAIR_MASK_CAPTURE ? [REPAIR_MASK_PROMPT] : []),
    'Repair only abnormal artifacts in Image 1 caused by the 3D preview or rendering process: warped or melted shapes, smeared textures, noisy splat fragments, floating dots, holes, broken contours, ghosting, patchy opacity, jagged edges, translucent fragments, and distorted surface details.',
    'Pay special attention to Gaussian splat view-change artifacts in Image 1: stretched or torn edges, shredded contours, fibrous pull-apart shapes, rubbery smearing, surface tearing, texture dragging, duplicated edge fragments, and details that look ripped apart when the viewpoint changes. Use Image 2 only to infer how those damaged surfaces, textures, and boundaries should look.',
    'Do not treat normal photographic blur as damage. Preserve background bokeh, depth-of-field blur, motion blur, soft focus, and naturally low-detail areas when they are consistent with Image 2.',
    ...(RECONSTRUCTION_USE_REPAIR_MASK_CAPTURE
      ? ['Preserve natural photographic blur unless it is inside or directly connected to a bright magenta repair mask. Use Image 2 to reconstruct marked areas with plausible original color, texture, boundary, and blur behavior.']
      : []),
    'Only repair blur that looks like a rendering artifact: warped, stretched, dirty, duplicated, patchy, broken, or inconsistent with the structure shown in Image 2.',
    'Preserve all correct parts of Image 1. Do not use the viewpoint of Image 2. Do not stylize, beautify, redesign, replace the background, add new objects, remove real objects, or invent unsupported details.',
    'When uncertain, preserve Image 1 rather than creating new detail. Return a clean, realistic version of Image 1 with rendering artifacts repaired and the natural photographic character preserved.',
  ].join('\n\n');

export const RECONSTRUCTION_PROMPT = DUAL_IMAGE_RECONSTRUCTION_PROMPT;

type KieAspectRatio =
  | 'auto'
  | '1:1'
  | '1:4'
  | '16:9'
  | '1:2'
  | '1:8'
  | '21:9'
  | '2:1'
  | '2:3'
  | '3:1'
  | '3:2'
  | '3:4'
  | '1:3'
  | '4:1'
  | '4:3'
  | '4:5'
  | '5:4'
  | '8:1'
  | '9:16'
  | '9:21';

type KieModelConfig = {
  id: ReconstructionModel;
  label: string;
  apiModel: string;
  supportedAspectRatios: KieAspectRatio[];
  buildInput: (input: {
    prompt: string;
    imageUrls: string[];
    aspectRatio: KieAspectRatio;
    resolution: ReconstructionResolution;
  }) => Record<string, unknown>;
};

type ReconstructionRequest = {
  provider: ReconstructionProvider;
  model: ReconstructionModel;
  inputMode: ReconstructionInputMode;
  apiKey: string;
  gaussianBlob: Blob;
  referenceBlob: Blob;
  /** repair-mask 截图：洋红区域表示缺失，需要重绘 */
  repairMask?: Blob | null;
  resolution: ReconstructionResolution;
};

type ProviderAdapter = {
  id: ReconstructionProvider;
  reconstruct: (request: ReconstructionRequest) => Promise<Blob>;
};

type KieUploadResponse = {
  code?: number;
  msg?: string;
  message?: string;
  success?: boolean;
  data?: {
    fileUrl?: string;
    downloadUrl?: string;
    url?: string;
  };
};

type KieCreateTaskResponse = {
  code?: number;
  msg?: string;
  message?: string;
  data?: {
    taskId?: string;
  };
};

type KieTaskResponse = {
  code?: number;
  msg?: string;
  message?: string;
  data?: {
    state?: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail';
    resultJson?: string;
    failMsg?: string;
    failCode?: string;
  };
};

const KIE_ASPECT_RATIOS: Array<{ value: Exclude<KieAspectRatio, 'auto'>; ratio: number }> = [
  { value: '1:1', ratio: 1 },
  { value: '1:4', ratio: 1 / 4 },
  { value: '16:9', ratio: 16 / 9 },
  { value: '1:2', ratio: 1 / 2 },
  { value: '1:8', ratio: 1 / 8 },
  { value: '21:9', ratio: 21 / 9 },
  { value: '2:1', ratio: 2 },
  { value: '2:3', ratio: 2 / 3 },
  { value: '3:1', ratio: 3 },
  { value: '3:2', ratio: 3 / 2 },
  { value: '3:4', ratio: 3 / 4 },
  { value: '1:3', ratio: 1 / 3 },
  { value: '4:1', ratio: 4 },
  { value: '4:3', ratio: 4 / 3 },
  { value: '4:5', ratio: 4 / 5 },
  { value: '5:4', ratio: 5 / 4 },
  { value: '8:1', ratio: 8 },
  { value: '9:16', ratio: 9 / 16 },
  { value: '9:21', ratio: 9 / 21 },
];

const KIE_MODEL_CONFIGS: Record<ReconstructionModel, KieModelConfig> = {
  'gpt-image-2': {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    apiModel: 'gpt-image-2-image-to-image',
    supportedAspectRatios: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'],
    buildInput: ({ prompt, imageUrls, aspectRatio, resolution }) => ({
      prompt,
      input_urls: imageUrls,
      aspect_ratio: aspectRatio,
      resolution,
    }),
  },
  'seedream-5-lite': {
    id: 'seedream-5-lite',
    label: 'Seedream 5.0 Lite',
    apiModel: 'seedream/5-lite-image-to-image',
    supportedAspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    buildInput: ({ prompt, imageUrls, aspectRatio, resolution }) => ({
      prompt,
      image_urls: imageUrls,
      aspect_ratio: aspectRatio === 'auto' ? '1:1' : aspectRatio,
      quality: resolution === '4K' ? 'high' : 'basic',
    }),
  },
  'nano-banana-2': {
    id: 'nano-banana-2',
    label: 'Nano Banana 2',
    apiModel: 'nano-banana-2',
    supportedAspectRatios: ['auto', '1:1', '1:4', '16:9', '1:8', '21:9', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16'],
    buildInput: ({ prompt, imageUrls, aspectRatio, resolution }) => ({
      prompt,
      aspect_ratio: aspectRatio,
      resolution,
      output_format: 'jpg',
      google_search: false,
      image_input: imageUrls,
    }),
  },
};

const kieAdapter: ProviderAdapter = {
  id: 'kie',
  reconstruct: reconstructWithKie,
};

const providers: Record<ReconstructionProvider, ProviderAdapter> = {
  kie: kieAdapter,
};

export async function runImageReconstruction(request: ReconstructionRequest): Promise<Blob> {
  // 嵌入 WinUI 后由宿主转发到本地图像接口（与图乐园共用同一份配置），
  // 保留原来的供应商适配器作为脱离宿主时的退路。
  const bridge = (window as unknown as {
    electronAPI?: { reconstruct?: (image: Blob, mask: Blob | null) => Promise<Blob> };
  }).electronAPI;

  if (typeof bridge?.reconstruct === 'function') {
    return bridge.reconstruct(request.gaussianBlob, request.repairMask ?? null);
  }

  const adapter = providers[request.provider];
  if (!adapter) {
    throw new Error(`暂不支持的重构供应商: ${request.provider}`);
  }
  return adapter.reconstruct(request);
}

async function reconstructWithKie(request: ReconstructionRequest): Promise<Blob> {
  const apiKey = request.apiKey.trim();
  if (!apiKey) {
    throw new Error('请先在设置里填写 KIE API Key');
  }

  const modelConfig = KIE_MODEL_CONFIGS[request.model] ?? KIE_MODEL_CONFIGS['gpt-image-2'];
  const gaussianInput = await normalizeUploadImage(request.gaussianBlob, 'sharp-viewer-gaussian.jpg');
  const aspectRatioPromise = pickClosestAspectRatio(gaussianInput.blob, modelConfig.supportedAspectRatios);
  const gaussianUrlPromise = uploadKieFile(gaussianInput.blob, gaussianInput.fileName, apiKey);
  const prompt =
    request.inputMode === 'dual' ? DUAL_IMAGE_RECONSTRUCTION_PROMPT : SINGLE_IMAGE_RECONSTRUCTION_PROMPT;

  const [gaussianUrl, aspectRatio] = await Promise.all([gaussianUrlPromise, aspectRatioPromise]);
  const imageUrls = [gaussianUrl];

  if (request.inputMode === 'dual') {
    const referenceInput = await normalizeUploadImage(request.referenceBlob, 'sharp-viewer-reference.png');
    imageUrls.push(await uploadKieFile(referenceInput.blob, referenceInput.fileName, apiKey));
  }

  const taskId = await createKieTask({
    apiKey,
    modelConfig,
    prompt,
    imageUrls,
    aspectRatio,
    resolution: request.resolution,
  });
  const resultUrl = await pollKieTask(taskId, apiKey);
  const response = await fetch(resultUrl);
  if (!response.ok) {
    throw new Error(`重构结果下载失败: ${response.status}`);
  }
  return response.blob();
}

async function normalizeUploadImage(blob: Blob, fallbackName: string): Promise<{ blob: Blob; fileName: string }> {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) {
    return {
      blob,
      fileName: fallbackName.replace(/\.png$/, blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/webp' ? '.webp' : '.png'),
    };
  }

  const converted = await convertImageBlob(blob, 'image/png');
  return {
    blob: converted,
    fileName: fallbackName,
  };
}

async function convertImageBlob(blob: Blob, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
  const image = await loadImageFromBlob(blob);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建图片转换画布');
  ctx.drawImage(image, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob((converted) => {
      if (converted) resolve(converted);
      else reject(new Error('图片格式转换失败'));
    }, type, 0.96);
  });
}

async function uploadKieFile(blob: Blob, fileName: string, apiKey: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', blob, fileName);
  formData.append('uploadPath', 'sharp-viewer/reconstruction');
  formData.append('fileName', `${Date.now()}-${fileName}`);

  const response = await fetch(`${KIE_FILE_BASE_URL}/api/file-stream-upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });
  const data = await readJson<KieUploadResponse>(response);
  const fileUrl = data.data?.fileUrl ?? data.data?.downloadUrl ?? data.data?.url;
  if (!response.ok || (data.code !== undefined && data.code !== 200) || !fileUrl) {
    throw new Error(data.msg ?? data.message ?? `KIE 文件上传失败: ${response.status}`);
  }
  return fileUrl;
}

async function createKieTask(input: {
  apiKey: string;
  modelConfig: KieModelConfig;
  prompt: string;
  imageUrls: string[];
  aspectRatio: KieAspectRatio;
  resolution: ReconstructionResolution;
}): Promise<string> {
  const requestBody = {
    model: input.modelConfig.apiModel,
    input: input.modelConfig.buildInput({
      prompt: input.prompt,
      imageUrls: input.imageUrls,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
    }),
  };
  console.info('[KIE createTask request]', JSON.stringify(requestBody, null, 2));

  const response = await fetch(`${KIE_API_BASE_URL}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  const data = await readJson<KieCreateTaskResponse>(response);
  const taskId = data.data?.taskId;
  if (!response.ok || data.code !== 200 || !taskId) {
    throw new Error(data.msg ?? data.message ?? `KIE 创建任务失败: ${response.status}`);
  }
  return taskId;
}

async function pollKieTask(taskId: string, apiKey: string): Promise<string> {
  const deadline = Date.now() + KIE_MAX_POLL_MS;
  let delayMs = 2500;

  while (Date.now() < deadline) {
    await sleep(delayMs);
    const response = await fetch(`${KIE_API_BASE_URL}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const data = await readJson<KieTaskResponse>(response);
    if (!response.ok || data.code !== 200) {
      throw new Error(data.msg ?? data.message ?? `KIE 查询任务失败: ${response.status}`);
    }

    const state = data.data?.state;
    if (state === 'success') {
      const resultUrl = parseKieResultUrl(data.data?.resultJson);
      if (!resultUrl) throw new Error('KIE 任务已完成，但没有返回图片 URL');
      return resultUrl;
    }

    if (state === 'fail') {
      throw new Error(data.data?.failMsg || data.data?.failCode || 'KIE 任务失败');
    }

    delayMs = Math.min(15000, Math.round(delayMs * 1.2));
  }

  throw new Error('KIE 任务超时，请稍后再试');
}

function parseKieResultUrl(resultJson: string | undefined): string | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as {
      resultUrls?: string[];
      resultUrl?: string;
      urls?: string[];
    };
    return parsed.resultUrls?.[0] ?? parsed.urls?.[0] ?? parsed.resultUrl ?? null;
  } catch {
    return null;
  }
}

async function pickClosestAspectRatio(blob: Blob, supportedAspectRatios: KieAspectRatio[]): Promise<KieAspectRatio> {
  const size = await getImageSize(blob);
  if (!size) return supportedAspectRatios.includes('auto') ? 'auto' : '1:1';
  const candidates = KIE_ASPECT_RATIOS.filter((candidate) => supportedAspectRatios.includes(candidate.value));
  if (candidates.length === 0) return supportedAspectRatios.includes('auto') ? 'auto' : '1:1';

  const ratio = size.width / size.height;
  let best = candidates[0];
  let bestScore = Infinity;

  for (const candidate of candidates) {
    const score = Math.abs(Math.log(ratio / candidate.ratio));
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best.value;
}

async function getImageSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      // Fall back to HTMLImageElement below.
    }
  }

  try {
    const image = await loadImageFromBlob(blob);
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return null;
  }
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    image.src = url;
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text || `API 返回非 JSON 响应: ${response.status}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
