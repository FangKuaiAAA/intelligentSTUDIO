import * as fs from 'fs';
import * as exifr from 'exifr';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import {
  DEFAULT_FOCAL_MM,
  FILM_35MM_DIAGONAL_MM,
  INPUT_IMAGE_SIZE,
} from '../shared/constants';

export interface PreparedImage {
  tensor: ort.Tensor;
  width: number;
  height: number;
  focalPx: number;
  focalSource: string;
}

const SUPPORTED_FORMATS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp']);

function getExtension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? '';
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === 'object') {
    const rational = value as { numerator?: unknown; denominator?: unknown };
    if (
      typeof rational.numerator === 'number' &&
      typeof rational.denominator === 'number' &&
      rational.denominator !== 0
    ) {
      return rational.numerator / rational.denominator;
    }
  }
  return undefined;
}

function focalMmToPx(width: number, height: number, focalMm: number): number {
  return (focalMm * Math.hypot(width, height)) / FILM_35MM_DIAGONAL_MM;
}

async function estimateFocalPx(
  imagePath: string,
  width: number,
  height: number,
  override?: number,
): Promise<{ focalPx: number; source: string }> {
  if (override && Number.isFinite(override) && override > 0) {
    return { focalPx: override, source: 'manual' };
  }

  // 与原项目一致：固定 30mm 等效焦距。
  // 读 EXIF 会让同一场景因相机型号得到不同的米制尺度，反投影后几何随之偏移，
  // 表现为空间被拉伸或压扁。
  return {
    focalPx: focalMmToPx(width, height, DEFAULT_FOCAL_MM),
    source: 'default-30mm',
  };
}

export async function prepareImage(
  imagePath: string,
  focalPxOverride?: number,
): Promise<PreparedImage> {
  const ext = getExtension(imagePath);
  if (!SUPPORTED_FORMATS.has(ext)) {
    throw new Error(`Unsupported image format .${ext}`);
  }

  const buffer = await fs.promises.readFile(imagePath);
  const metadata = await sharp(buffer).rotate().metadata();
  const width = metadata.width ?? INPUT_IMAGE_SIZE;
  const height = metadata.height ?? INPUT_IMAGE_SIZE;
  const focal = await estimateFocalPx(imagePath, width, height, focalPxOverride);

  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(INPUT_IMAGE_SIZE, INPUT_IMAGE_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

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
    tensor: new ort.Tensor('float32', nchw, [1, 3, INPUT_IMAGE_SIZE, INPUT_IMAGE_SIZE]),
    width,
    height,
    focalPx: focal.focalPx,
    focalSource: focal.source,
  };
}
