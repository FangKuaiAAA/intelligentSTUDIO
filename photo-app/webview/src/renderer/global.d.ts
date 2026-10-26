import type {
  AppError,
  ImageMetadata,
  InferenceResult,
  InferenceStartRequest,
  InferenceStatus,
  ModelStatus,
  OpenDialogReturnValue,
  RuntimeCapabilities,
  ViewerWindowLayout,
  WindowControlAction,
  WindowState,
  WindowMode,
} from '../shared/types';

declare global {
  interface Window {
    electronAPI: {
      startInference: (request: InferenceStartRequest) => Promise<InferenceResult | AppError>;
      cancelInference: (taskId?: string) => Promise<void>;
      onInferenceStatus: (callback: (status: InferenceStatus) => void) => () => void;
      getRuntimeCapabilities: () => Promise<RuntimeCapabilities>;
      getModelStatus: () => Promise<ModelStatus>;
      openImage: () => Promise<OpenDialogReturnValue>;
      registerLocalFile: (filePath: string) => Promise<string>;
      getImageMetadata: (filePath: string) => Promise<ImageMetadata>;
      getPathForFile: (file: File) => string;
      copyImageToClipboard: (imageBytes: Uint8Array | ArrayBuffer) => void;
      getAppVersion: () => Promise<string>;
      getWindowState: () => Promise<WindowState>;
      setWindowMode: (payload: WindowMode | { mode: WindowMode; layout?: ViewerWindowLayout }) => Promise<void>;
      windowControl: (action: WindowControlAction) => Promise<void>;
      onWindowStateChange: (callback: (state: WindowState) => void) => () => void;
    };
  }
}

export {};
