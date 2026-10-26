// ============================================================
// renderer/state/types.ts — 状态类型定义
// ============================================================

/** 事件名称常量 */
export const Events = {
  IMAGE_SELECTED: 'image:selected',
  REFERENCE_IMAGE_READY: 'reference:image-ready',
  INFERENCE_START: 'inference:start',
  INFERENCE_COMPLETE: 'inference:complete',
  INFERENCE_ERROR: 'inference:error',
  MODEL_DOWNLOAD_PROGRESS: 'model:download-progress',
  CAPTURE_REQUESTED: 'capture:requested',
  CAPTURE_COMPLETE: 'capture:complete',
  UPLOAD_REQUESTED: 'upload:requested',
  RETURN_TO_UPLOAD: 'upload:return',
  RETURN_TO_VIEWER: 'viewer:return',
  RECONSTRUCTION_START: 'reconstruction:start',
  RECONSTRUCTION_COMPARE_START: 'reconstruction:compare-start',
  RECONSTRUCTION_COMPARE_END: 'reconstruction:compare-end',
  RECONSTRUCTION_SAVE: 'reconstruction:save',
  EXTERNAL_API_RESULT: 'external:api-result',
  EXTERNAL_API_ERROR: 'external:api-error',
  APP_ERROR: 'app:error',
} as const;
