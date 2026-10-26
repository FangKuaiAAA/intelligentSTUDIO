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
} from '../../shared/types';

export const inferenceAPI = {
  start: (request: InferenceStartRequest): Promise<InferenceResult | AppError> =>
    window.electronAPI.startInference(request),
  cancel: (taskId?: string): Promise<void> =>
    window.electronAPI.cancelInference(taskId),
  onStatus: (cb: (status: InferenceStatus) => void): (() => void) =>
    window.electronAPI.onInferenceStatus(cb),
};

export const runtimeAPI = {
  getCapabilities: (): Promise<RuntimeCapabilities> =>
    window.electronAPI.getRuntimeCapabilities(),
};

export const modelAPI = {
  getStatus: (): Promise<ModelStatus> =>
    window.electronAPI.getModelStatus(),
};

export const fileAPI = {
  openImage: (): Promise<OpenDialogReturnValue> =>
    window.electronAPI.openImage(),
  registerLocalFile: (filePath: string): Promise<string> =>
    window.electronAPI.registerLocalFile(filePath),
  getImageMetadata: (filePath: string): Promise<ImageMetadata> =>
    window.electronAPI.getImageMetadata(filePath),
  getPathForFile: (file: File): string =>
    window.electronAPI.getPathForFile(file),
  copyImageToClipboard: (imageBytes: Uint8Array | ArrayBuffer): void =>
    window.electronAPI.copyImageToClipboard(imageBytes),
};

export const appAPI = {
  getVersion: (): Promise<string> =>
    window.electronAPI.getAppVersion(),
  getWindowState: (): Promise<WindowState> =>
    window.electronAPI.getWindowState(),
  setWindowMode: (payload: WindowMode | { mode: WindowMode; layout?: ViewerWindowLayout }): Promise<void> =>
    window.electronAPI.setWindowMode(payload),
  windowControl: (action: WindowControlAction): Promise<void> =>
    window.electronAPI.windowControl(action),
  onWindowStateChange: (cb: (state: WindowState) => void): (() => void) =>
    window.electronAPI.onWindowStateChange(cb),
};
