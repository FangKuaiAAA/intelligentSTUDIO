// ============================================================
// renderer/three/types.ts — 3D 相关类型
// ============================================================

export interface PlyLoadOptions {
  splatAlphaRemovalThreshold?: number;
  showLoadingUI?: boolean;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}