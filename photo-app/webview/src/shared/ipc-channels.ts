// ============================================================
// shared/ipc-channels.ts — IPC channel 名称常量
// ============================================================

export const IPC_INFERENCE_START = 'inference:start';
export const IPC_INFERENCE_CANCEL = 'inference:cancel';
export const IPC_INFERENCE_STATUS = 'inference:status';

export const IPC_RUNTIME_GET_CAPABILITIES = 'runtime:get-capabilities';
export const IPC_MODEL_GET_STATUS = 'model:get-status';

export const IPC_FILE_OPEN_IMAGE = 'file:open-image';
export const IPC_FILE_REGISTER_LOCAL = 'file:register-local';
export const IPC_FILE_GET_IMAGE_METADATA = 'file:get-image-metadata';

export const IPC_APP_GET_VERSION = 'app:get-version';
export const IPC_APP_QUIT = 'app:quit';
export const IPC_APP_SET_WINDOW_MODE = 'app:set-window-mode';
export const IPC_APP_WINDOW_CONTROL = 'app:window-control';
export const IPC_APP_GET_WINDOW_STATE = 'app:get-window-state';
export const IPC_APP_WINDOW_STATE_CHANGED = 'app:window-state-changed';
