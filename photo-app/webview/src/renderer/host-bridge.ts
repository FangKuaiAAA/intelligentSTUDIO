// ============================================================
// renderer/host-bridge.ts — 把原 Electron IPC 换成 WebView2 消息桥
// 宿主（WinUI）负责：提供当前照片、跑 SHARP 估计、返回 PLY、执行补全
// ============================================================

import type {
  AppError,
  ImageMetadata,
  InferenceResult,
  InferenceStartRequest,
  InferenceStatus,
} from '../shared/types';

interface HostImage {
  url: string;
  width: number;
  height: number;
}

interface PendingInference {
  resolve: (result: InferenceResult | AppError) => void;
  reject: (error: Error) => void;
}

const pendingInference = new Map<string, PendingInference>();
const pendingReconstruct = new Map<string, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>();
const statusHandlers = new Set<(status: InferenceStatus) => void>();
const imageHandlers = new Set<(image: HostImage) => void>();

let currentImage: HostImage | null = null;
let lastImageData: string | null = null;
let sequence = 0;

const webview = (window as unknown as {
  chrome?: {
    webview?: {
      postMessage: (message: unknown) => void;
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) => void;
    };
  };
}).chrome?.webview;

function post(message: unknown): void {
  webview?.postMessage(message);
}

function base64ToBlobUrl(base64: string, mime: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

webview?.addEventListener('message', (event) => {
  const message = event.data as Record<string, unknown> | null;
  if (!message || typeof message.type !== 'string') return;

  switch (message.type) {
    case 'image': {
      const data = String(message.data ?? '');
      // 宿主可能在导航兜底与 ready 时各发一次，同一张图只处理一次
      if (!data || data === lastImageData) break;
      lastImageData = data;

      const url = base64ToBlobUrl(data, 'image/png');
      currentImage = {
        url,
        width: Number(message.width ?? 0),
        height: Number(message.height ?? 0),
      };
      imageHandlers.forEach((handler) => handler(currentImage!));
      break;
    }

    case 'infer-status': {
      const status = message.status as InferenceStatus;
      statusHandlers.forEach((handler) => handler(status));
      break;
    }

    case 'infer-result': {
      const taskId = String(message.taskId ?? '');
      const entry = pendingInference.get(taskId);
      if (!entry) return;
      pendingInference.delete(taskId);

      if (message.error) {
        entry.resolve({
          code: 'INFERENCE_FAILED',
          message: '三维重建失败',
          detail: String(message.error),
        } as AppError);
        return;
      }

      // 宿主把 PLY 写在虚拟主机上，直接给 URL；没有 URL 时退回内存 Blob
      const plyUrl = message.plyUrl
        ? String(message.plyUrl)
        : base64ToBlobUrl(String(message.ply ?? ''), 'application/octet-stream');
      entry.resolve({
        taskId,
        plyUrl,
        plyPath: `memory://${taskId}.ply`,
        backend: (message.backend as InferenceResult['backend']) ?? 'dml',
        durationMs: Number(message.durationMs ?? 0),
        selectedGaussians: Number(message.count ?? 0),
        totalGaussians: Number(message.count ?? 0),
        image: {
          width: Number(message.width ?? currentImage?.width ?? 0),
          height: Number(message.height ?? currentImage?.height ?? 0),
          focalPx: Number(message.focalPx ?? 0),
          focalSource: String(message.focalSource ?? 'model'),
        },
      });
      break;
    }

    case 'reconstruct-result': {
      const id = String(message.id ?? '');
      const entry = pendingReconstruct.get(id);
      if (!entry) return;
      pendingReconstruct.delete(id);

      if (message.error) {
        entry.reject(new Error(String(message.error)));
        return;
      }

      const bytes = (() => {
        const binary = atob(String(message.image ?? ''));
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      })();
      entry.resolve(new Blob([bytes], { type: 'image/png' }));
      break;
    }
  }
});

/** 宿主推送照片后触发；页面启动即注册，保证第一张图不丢。 */
export function onHostImage(handler: (image: HostImage) => void): () => void {
  imageHandlers.add(handler);
  if (currentImage) handler(currentImage);
  return () => imageHandlers.delete(handler);
}

/** 让宿主用本地 API 补全缺失区域，返回补全后的 PNG。 */
export function requestReconstruction(imageBlob: Blob, maskBlob: Blob | null): Promise<Blob> {
  const id = `r${++sequence}`;
  return new Promise((resolve, reject) => {
    pendingReconstruct.set(id, { resolve, reject });

    void (async () => {
      const image = await blobToBase64(imageBlob);
      const mask = maskBlob ? await blobToBase64(maskBlob) : null;
      post({ type: 'reconstruct', id, image, mask });
    })();

    window.setTimeout(() => {
      if (!pendingReconstruct.has(id)) return;
      pendingReconstruct.delete(id);
      reject(new Error('补全超时。'));
    }, 240_000);
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(buffer.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** 把结果交给宿主写入编辑会话，不再触发浏览器下载。 */
export async function saveToHost(blob: Blob): Promise<void> {
  const image = await blobToBase64(blob);
  post({ type: 'save', image });
}

const noop = async (): Promise<void> => undefined;

(window as unknown as { electronAPI: unknown }).electronAPI = {
  startInference: (request: InferenceStartRequest): Promise<InferenceResult | AppError> => {
    const taskId = `t${++sequence}`;
    return new Promise((resolve, reject) => {
      pendingInference.set(taskId, { resolve, reject });
      post({ type: 'infer', taskId, request });
    });
  },

  cancelInference: async (taskId?: string): Promise<void> => {
    post({ type: 'infer-cancel', taskId });
  },

  onInferenceStatus: (callback: (status: InferenceStatus) => void): (() => void) => {
    statusHandlers.add(callback);
    return () => statusHandlers.delete(callback);
  },

  getRuntimeCapabilities: async () => ({
    platform: 'win32',
    arch: 'x64',
    preferredProviders: ['dml', 'cpu'],
    supportedProviders: ['dml', 'cpu'],
    nodeVersion: '',
    onnxRuntimeVersion: '',
  }),

  getModelStatus: async () => ({ downloaded: true, path: '' }),

  openImage: async () => ({ canceled: true, filePaths: [] }),

  registerLocalFile: async (filePath: string) => filePath,

  getImageMetadata: async (): Promise<ImageMetadata> => ({
    width: currentImage?.width ?? 0,
    height: currentImage?.height ?? 0,
  }),

  getPathForFile: (): string => '',

  copyImageToClipboard: (): void => {},

  getAppVersion: async () => '1.0.0',

  getWindowState: async () => ({ isMaximized: false }),

  setWindowMode: noop,

  windowControl: noop,

  onWindowStateChange: (): (() => void) => () => undefined,

  reconstruct: requestReconstruction,
};

// 宿主可能在页面脚本执行前尚未挂好监听，ready 重试几次确保送达
let announced = false;

function announceReady(): void {
  if (announced || !webview) return;
  announced = true;
  post({ type: 'ready' });
  [300, 900, 1800].forEach((delay) => window.setTimeout(() => post({ type: 'ready' }), delay));
}

if (document.readyState === 'complete') announceReady();
else window.addEventListener('load', announceReady);
