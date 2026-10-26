// ============================================================
// shared/types.ts — 跨进程协议与共享类型
// ============================================================

export type BackendProvider = 'webgpu' | 'dml' | 'cuda' | 'coreml' | 'cpu';
export type QualityPreset = 'balanced' | 'high' | 'full';

export type InferenceStage =
  | 'queued'
  | 'loading-model'
  | 'preprocessing'
  | 'running-inference'
  | 'postprocessing'
  | 'writing-ply'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface InferenceStartRequest {
  imagePath: string;
  qualityPreset?: QualityPreset;
  opacityThreshold?: number;
  maxGaussians?: number;
  focalPxOverride?: number;
}

export interface InferenceStatus {
  taskId: string;
  stage: InferenceStage;
  progress?: number;
  message?: string;
  backend?: BackendProvider;
}

export interface InferenceImageInfo {
  width: number;
  height: number;
  focalPx: number;
  focalSource: string;
}

export interface InferenceResult {
  taskId: string;
  plyUrl: string;
  referenceImageUrl?: string;
  plyPath: string;
  backend: BackendProvider;
  durationMs: number;
  selectedGaussians: number;
  totalGaussians: number;
  image: InferenceImageInfo;
}

export interface RuntimeCapabilities {
  platform: string;
  arch: string;
  preferredProviders: BackendProvider[];
  supportedProviders: BackendProvider[];
  nodeVersion: string;
  onnxRuntimeVersion: string;
}

export interface ModelStatus {
  modelPath: string;
  dataPath: string;
  modelExists: boolean;
  dataExists: boolean;
  ready: boolean;
  modelSize: number;
  dataSize: number;
}

export interface BackendRunConfig {
  modelPath: string;
  outputDir: string;
  preferredProviders: BackendProvider[];
}

export type BackendRequest =
  | {
      type: 'run';
      taskId: string;
      payload: InferenceStartRequest;
      config: BackendRunConfig;
    }
  | {
      type: 'cancel';
      taskId?: string;
    }
  | {
      type: 'capabilities';
      requestId: string;
      config: BackendRunConfig;
    };

export type BackendResponse =
  | {
      type: 'status';
      status: InferenceStatus;
    }
  | {
      type: 'result';
      taskId: string;
      result: Omit<InferenceResult, 'plyUrl'>;
    }
  | {
      type: 'error';
      taskId: string;
      error: string;
    }
  | {
      type: 'capabilities';
      requestId: string;
      capabilities: RuntimeCapabilities;
    };

export type ErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_VALIDATION_FAILED'
  | 'INFERENCE_FAILED'
  | 'PREPROCESS_FAILED'
  | 'POSTPROCESS_FAILED'
  | 'PLY_GENERATION_FAILED'
  | 'FILE_READ_ERROR'
  | 'FILE_WRITE_ERROR'
  | 'UNSUPPORTED_IMAGE_FORMAT'
  | 'EXTERNAL_API_ERROR'
  | 'UNKNOWN_ERROR';

export interface AppError {
  code: ErrorCode;
  message: string;
  detail: string;
}

export type AppPhase =
  | 'idle'
  | 'uploading'
  | 'inferring'
  | 'ready'
  | 'capturing'
  | 'processing';

export interface AppState {
  phase: AppPhase;
  inputImagePath: string | null;
  plyPath: string | null;
  error: AppError | null;
}

export interface ExternalApiConfig {
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  fieldName: string;
}

export type ReconstructionProvider = 'kie';
export type ReconstructionModel = 'gpt-image-2' | 'seedream-5-lite' | 'nano-banana-2';
export type ReconstructionInputMode = 'single' | 'dual';
export type ReconstructionResolution = '2K' | '4K';
export type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

export interface WindowState {
  isMaximized: boolean;
}

export interface ViewerSettings {
  qualityPreset: QualityPreset;
  opacityThreshold: number;
  maxGaussians: number;
  focalPxOverride: number | null;
  splatAlphaRemovalThreshold: number;
  splatScale: number;
  maxScreenSpaceSplatSize: number;
  pointCloudMode: boolean;
  backgroundColor: string;
  fov: number;
  reconstructionProvider: ReconstructionProvider;
  reconstructionModel: ReconstructionModel;
  reconstructionInputMode: ReconstructionInputMode;
  kieApiKey: string;
  reconstructionResolution: ReconstructionResolution;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface OpenDialogReturnValue {
  canceled: boolean;
  filePaths: string[];
  referenceImageUrl?: string;
}

export interface ImageMetadata {
  width: number;
  height: number;
}

export interface PlatformInfo {
  os: string;
  arch: string;
  availableBackend: BackendProvider;
  executionProviders: BackendProvider[];
}

export type WindowMode = 'compact' | 'viewer';

export interface ViewerWindowLayout {
  imageWidth: number;
  imageHeight: number;
}
