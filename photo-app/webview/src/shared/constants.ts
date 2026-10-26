// ============================================================
// shared/constants.ts — 常量定义（路径、端口、参数默认值）
// ============================================================

// ---- 模型 ----
// 托管的 SHARP ONNX 模型（来自 bring-shrubbery/ml-sharp-web）
// .onnx 文件只包含计算图，实际权重在 .onnx.data 中，两者必须放在同一目录
export const MODEL_URL = 'https://ml-sharp.quassum.com/sharp_web_predictor.onnx';
export const MODEL_DATA_URL = 'https://ml-sharp.quassum.com/sharp_web_predictor.onnx.data';
export const ONNX_MODEL_FILENAME = 'sharp_web_predictor.onnx';
export const ONNX_DATA_FILENAME = 'sharp_web_predictor.onnx.data';
export const EXPECTED_MODEL_SHA256 = '';

// ---- 推理 ----
export const INPUT_IMAGE_SIZE = 1536;
export const PATCH_SIZE = 384;
export const NUM_PATCHES = 25;

// ---- 路径 ----
export const MODEL_CACHE_DIR = 'models';
export const OUTPUT_DIR = 'output';

// ---- 3D 渲染 ----
export const DEFAULT_CAMERA_POSITION: [number, number, number] = [0, 0, 0];
export const DEFAULT_CAMERA_LOOK_AT: [number, number, number] = [0, 0, -1];
export const DEFAULT_CAMERA_UP: [number, number, number] = [0, 1, 0];

// ---- 外部 API ----
export const DEFAULT_EXTERNAL_API_TIMEOUT = 30000;
export const RECONSTRUCTION_USE_REPAIR_MASK_CAPTURE = true;
export const RECONSTRUCTION_REPAIR_MASK_COLOR = '#ff00ff';
export const RECONSTRUCTION_CAPTURE_MIME_TYPE = 'image/jpeg';
export const RECONSTRUCTION_CAPTURE_QUALITY = 0.9;

// ---- 推理质量 ----
export const DEFAULT_OPACITY_THRESHOLD = 0;
export const DEFAULT_MAX_GAUSSIANS_BALANCED = 200000;
export const DEFAULT_MAX_GAUSSIANS_HIGH = 500000;
// 不透明度低于 5/255 的高斯基本是背景噪声，保留会在画面里形成雾状碎片
export const DEFAULT_SPLAT_ALPHA_REMOVAL_THRESHOLD = 5;
export const DEFAULT_SPLAT_SCALE = 1;
// 单个高斯最多覆盖 32 像素：原值 512 会让靠近相机的点膨胀成大块色斑
export const DEFAULT_MAX_SCREEN_SPACE_SPLAT_SIZE = 32;
export const DEFAULT_POINT_CLOUD_MODE = false;
export const DEFAULT_VIEWER_BACKGROUND = '#2b2928';
export const DEFAULT_VIEWER_FOV = 75;
export const DEFAULT_FOCAL_MM = 30;
export const FILM_35MM_DIAGONAL_MM = 43.266615305567875;
