// ============================================================
// renderer/three/splat-loader.ts — 高斯泼溅加载
// 使用 Spark 的 SplatMesh 渲染 .ply/.spz/.splat 文件
// ============================================================

import { SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import type { SceneManager } from './scene';
import type { ViewerSettings } from '../../shared/types';
import {
  DEFAULT_MAX_SCREEN_SPACE_SPLAT_SIZE,
  DEFAULT_POINT_CLOUD_MODE,
  DEFAULT_SPLAT_ALPHA_REMOVAL_THRESHOLD,
  DEFAULT_SPLAT_SCALE,
} from '../../shared/constants';

const LOAD_TIMEOUT_MS = 30_000;

type RenderSettings = Pick<
  ViewerSettings,
  'splatAlphaRemovalThreshold' | 'splatScale' | 'maxScreenSpaceSplatSize' | 'pointCloudMode'
>;

export interface SplatCalibrationSettings {
  modelScale: number;
  modelOffsetX: number;
  modelOffsetY: number;
  modelOffsetZ: number;
  modelRotationX: number;
  modelRotationY: number;
  modelRotationZ: number;
  splatOpacity: number;
  maxSh: number;
  maxPixelRadius: number;
  minPixelRadius: number;
  minAlpha: number;
  falloff: number;
  focalAdjustment: number;
}

const MAX_POSITION_SAMPLES = 20_000;

export class SplatLoader {
  private mesh: SplatMesh | null = null;
  private sceneManager: SceneManager;
  private currentPlyPath: string | null = null;
  private preparedObjectUrl: string | null = null;
  private positionSamples: Float32Array | null = null;
  private settings: RenderSettings = {
    splatAlphaRemovalThreshold: DEFAULT_SPLAT_ALPHA_REMOVAL_THRESHOLD,
    splatScale: DEFAULT_SPLAT_SCALE,
    maxScreenSpaceSplatSize: DEFAULT_MAX_SCREEN_SPACE_SPLAT_SIZE,
    pointCloudMode: DEFAULT_POINT_CLOUD_MODE,
  };

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
  }

  async load(plyPath: string, settings?: Partial<RenderSettings>): Promise<void> {
    this.unload();
    this.currentPlyPath = plyPath;
    this.settings = { ...this.settings, ...settings };
    const loadUrl = await this.prepareLoadUrl(plyPath);

    const scene = this.sceneManager.getScene();
    this.mesh = new SplatMesh({
      url: loadUrl,
      fileName: plyPath.split(/[\\/]/).pop(),
      editable: false,
      raycastable: true,
      minRaycastOpacity: 0.05,
      enableLod: false,
    });
    this.mesh.quaternion.set(1, 0, 0, 0);
    scene.add(this.mesh);

    try {
      await this.withTimeout(
        this.mesh.initialized,
        LOAD_TIMEOUT_MS,
        `加载高斯模型超时，请检查 WebAssembly/CSP、GPU/WebGL 或 PLY 文件: ${plyPath}`
      );
      this.applyLiveSettings(this.settings);
    } catch (error) {
      this.unload();
      throw error;
    }
  }

  getViewer(): SplatMesh | null {
    return this.mesh;
  }

  getPositionSamples(): Float32Array | null {
    return this.positionSamples;
  }

  applyCalibration(settings: SplatCalibrationSettings): void {
    const spark = this.sceneManager.getSparkRenderer();
    spark.maxPixelRadius = settings.maxPixelRadius;
    spark.minPixelRadius = settings.minPixelRadius;
    spark.minAlpha = settings.minAlpha;
    spark.falloff = settings.falloff;
    spark.focalAdjustment = settings.focalAdjustment;
    spark.setDirty();

    if (!this.mesh) return;
    this.mesh.position.set(settings.modelOffsetX, settings.modelOffsetY, settings.modelOffsetZ);
    this.mesh.rotation.set(
      THREE.MathUtils.degToRad(settings.modelRotationX),
      THREE.MathUtils.degToRad(settings.modelRotationY),
      THREE.MathUtils.degToRad(settings.modelRotationZ)
    );
    this.mesh.scale.setScalar(settings.modelScale);
    this.mesh.opacity = settings.splatOpacity;
    this.mesh.maxSh = settings.maxSh;
    this.mesh.updateGenerator();
  }

  unload(): void {
    if (this.mesh) {
      this.sceneManager.getScene().remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    if (this.preparedObjectUrl) {
      URL.revokeObjectURL(this.preparedObjectUrl);
      this.preparedObjectUrl = null;
    }
    this.positionSamples = null;
  }

  async updateSettings(settings: Partial<RenderSettings>): Promise<void> {
    this.settings = { ...this.settings, ...settings };
    this.applyLiveSettings(this.settings);
  }

  private applyLiveSettings(settings: RenderSettings): void {
    const spark = this.sceneManager.getSparkRenderer();
    spark.maxPixelRadius = settings.pointCloudMode ? 1.5 : settings.maxScreenSpaceSplatSize;
    spark.minPixelRadius = settings.pointCloudMode ? 1.25 : 0;
    spark.minAlpha = Math.max(0.5 / 255, settings.splatAlphaRemovalThreshold / 255);
    spark.setDirty();

    if (!this.mesh) return;
    this.mesh.scale.setScalar(settings.splatScale);
    this.mesh.opacity = settings.pointCloudMode ? 0.8 : 1;
    this.mesh.maxSh = 3;
    this.mesh.updateGenerator();
  }

  private async prepareLoadUrl(plyPath: string): Promise<string> {
    const response = await fetch(plyPath, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`无法读取高斯模型文件 (${response.status} ${response.statusText}): ${plyPath}`);
    }
    const fileBytes = new Uint8Array(await response.arrayBuffer());
    const sanitized = this.stripPlyToVertexElement(fileBytes);
    this.positionSamples = this.extractPositionSamples(sanitized ?? fileBytes);
    if (!sanitized) {
      return plyPath;
    }

    const blobBytes = new ArrayBuffer(sanitized.byteLength);
    new Uint8Array(blobBytes).set(sanitized);
    this.preparedObjectUrl = URL.createObjectURL(new Blob([blobBytes], { type: 'application/octet-stream' }));
    return this.preparedObjectUrl;
  }

  private extractPositionSamples(fileBytes: Uint8Array): Float32Array | null {
    const preview = new TextDecoder().decode(fileBytes.slice(0, Math.min(fileBytes.length, 65_536)));
    const headerEnd = preview.indexOf('end_header\n');
    if (headerEnd < 0) return null;

    const header = preview.slice(0, headerEnd + 'end_header\n'.length);
    if (!header.startsWith('ply\n') || !header.includes('format binary_little_endian 1.0')) {
      return null;
    }

    const lines = header.trimEnd().split(/\r?\n/);
    let vertexCount = 0;
    let inVertex = false;
    let vertexStride = 0;
    const offsets: Partial<Record<'x' | 'y' | 'z', { offset: number; type: string }>> = {};

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'element') {
        inVertex = parts[1] === 'vertex';
        if (inVertex) vertexCount = Number(parts[2]);
        continue;
      }
      if (parts[0] === 'property' && inVertex) {
        if (parts[1] === 'list') return null;
        const size = this.plyScalarSize(parts[1]);
        if (!size) return null;
        if (parts[2] === 'x' || parts[2] === 'y' || parts[2] === 'z') {
          offsets[parts[2]] = { offset: vertexStride, type: parts[1] };
        }
        vertexStride += size;
      }
    }

    if (!offsets.x || !offsets.y || !offsets.z || vertexCount <= 0 || vertexStride <= 0) {
      return null;
    }

    const dataOffset = new TextEncoder().encode(header).length;
    const step = Math.max(1, Math.floor(vertexCount / MAX_POSITION_SAMPLES));
    const sampleCount = Math.ceil(vertexCount / step);
    const samples = new Float32Array(sampleCount * 3);
    const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    let sampleIndex = 0;

    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += step) {
      const base = dataOffset + vertexIndex * vertexStride;
      samples[sampleIndex++] = this.readPlyScalar(view, base + offsets.x.offset, offsets.x.type);
      samples[sampleIndex++] = this.readPlyScalar(view, base + offsets.y.offset, offsets.y.type);
      samples[sampleIndex++] = this.readPlyScalar(view, base + offsets.z.offset, offsets.z.type);
    }
    return samples;
  }

  private readPlyScalar(view: DataView, offset: number, type: string): number {
    switch (type) {
      case 'float':
      case 'float32':
        return view.getFloat32(offset, true);
      case 'double':
      case 'float64':
        return view.getFloat64(offset, true);
      case 'char':
      case 'int8':
        return view.getInt8(offset);
      case 'uchar':
      case 'uint8':
        return view.getUint8(offset);
      case 'short':
      case 'int16':
        return view.getInt16(offset, true);
      case 'ushort':
      case 'uint16':
        return view.getUint16(offset, true);
      case 'int':
      case 'int32':
        return view.getInt32(offset, true);
      case 'uint':
      case 'uint32':
        return view.getUint32(offset, true);
      default:
        return 0;
    }
  }

  private stripPlyToVertexElement(fileBytes: Uint8Array): Uint8Array | null {
    const preview = new TextDecoder().decode(fileBytes.slice(0, Math.min(fileBytes.length, 65_536)));
    const headerEnd = preview.indexOf('end_header\n');
    if (headerEnd < 0) return null;

    const header = preview.slice(0, headerEnd + 'end_header\n'.length);
    if (!header.startsWith('ply\n') || !header.includes('format binary_little_endian 1.0')) {
      return null;
    }

    const lines = header.trimEnd().split(/\r?\n/);
    const vertexLines: string[] = [];
    let vertexCount = 0;
    let inVertex = false;
    let vertexStride = 0;
    let hasExtraElements = false;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'element') {
        inVertex = parts[1] === 'vertex';
        if (inVertex) {
          vertexCount = Number(parts[2]);
          vertexLines.push(line);
        } else if (parts[1] !== undefined) {
          hasExtraElements = true;
        }
        continue;
      }

      if (parts[0] === 'property' && inVertex) {
        if (parts[1] === 'list') return null;
        const size = this.plyScalarSize(parts[1]);
        if (!size) return null;
        vertexStride += size;
        vertexLines.push(line);
      }
    }

    if (!hasExtraElements || !Number.isFinite(vertexCount) || vertexCount <= 0 || vertexStride <= 0) {
      return null;
    }

    const dataOffset = new TextEncoder().encode(header).length;
    const vertexBytes = vertexCount * vertexStride;
    if (dataOffset + vertexBytes > fileBytes.length) return null;

    const strippedHeader = `${[
      'ply',
      'format binary_little_endian 1.0',
      'comment stripped to vertex-only by sharp-viewer for Spark compatibility',
      ...vertexLines,
      'end_header',
    ].join('\n')}\n`;
    const strippedHeaderBytes = new TextEncoder().encode(strippedHeader);
    const output = new Uint8Array(strippedHeaderBytes.length + vertexBytes);
    output.set(strippedHeaderBytes, 0);
    output.set(fileBytes.slice(dataOffset, dataOffset + vertexBytes), strippedHeaderBytes.length);
    return output;
  }

  private plyScalarSize(type: string): number {
    switch (type) {
      case 'char':
      case 'uchar':
      case 'int8':
      case 'uint8':
        return 1;
      case 'short':
      case 'ushort':
      case 'int16':
      case 'uint16':
        return 2;
      case 'int':
      case 'uint':
      case 'float':
      case 'int32':
      case 'uint32':
      case 'float32':
        return 4;
      case 'double':
      case 'float64':
        return 8;
      default:
        return 0;
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeoutId: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    });
  }
}
