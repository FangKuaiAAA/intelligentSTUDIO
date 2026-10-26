// ============================================================
// renderer/three/scene.ts — 场景初始化
// 创建 Three.js 的 Renderer、Scene、Camera
// ============================================================

import * as THREE from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';
import { EdgeFillPass } from './edge-fill-pass';
import {
  DEFAULT_CAMERA_POSITION,
  DEFAULT_CAMERA_LOOK_AT,
  DEFAULT_CAMERA_UP,
  DEFAULT_MAX_SCREEN_SPACE_SPLAT_SIZE,
  RECONSTRUCTION_REPAIR_MASK_COLOR,
  DEFAULT_VIEWER_BACKGROUND,
  DEFAULT_VIEWER_FOV,
} from '../../shared/constants';
import type { EdgeFillRenderMode } from './edge-fill-pass';

export class SceneManager {
  private renderer: THREE.WebGLRenderer;
  private sparkRenderer: SparkRenderer;
  private edgeFillPass: EdgeFillPass;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private frameCallbacks = new Set<() => void>();
  private drawingBufferSize = new THREE.Vector2();
  private edgeFillRenderMode: EdgeFillRenderMode = 'blur-fill';

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(DEFAULT_VIEWER_BACKGROUND, 1);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.sparkRenderer = new SparkRenderer({
      renderer: this.renderer,
      maxPixelRadius: DEFAULT_MAX_SCREEN_SPACE_SPLAT_SIZE,
      sortRadial: false,
      minSortIntervalMs: 16,
      enableLod: false,
      minAlpha: 0.5 / 255,
      falloff: 1,
      focalAdjustment: 1,
    });
    this.edgeFillPass = new EdgeFillPass(this.renderer, DEFAULT_VIEWER_BACKGROUND);
    this.edgeFillPass.setRepairMaskColor(RECONSTRUCTION_REPAIR_MASK_COLOR);
    this.syncPostProcessSize();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(DEFAULT_VIEWER_BACKGROUND);
    this.scene.add(this.sparkRenderer);

    this.camera = new THREE.PerspectiveCamera(
      DEFAULT_VIEWER_FOV,
      container.clientWidth / container.clientHeight,
      0.01,
      100000
    );

    this.camera.position.set(...DEFAULT_CAMERA_POSITION);
    this.camera.up.set(...DEFAULT_CAMERA_UP);
    this.camera.lookAt(...DEFAULT_CAMERA_LOOK_AT);

    this.startRenderLoop();
  }

  private startRenderLoop(): void {
    const animate = (): void => {
      requestAnimationFrame(animate);
      this.frameCallbacks.forEach((callback) => callback());
      this.renderCurrentFrame();
    };
    animate();
  }

  addFrameCallback(callback: () => void): () => void {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setCanvasClipRect(rect: { left: number; top: number; width: number; height: number } | null): void {
    const canvas = this.renderer.domElement;
    if (!rect) {
      canvas.style.clipPath = '';
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.max(0, bounds.width - rect.left - rect.width);
    const bottom = Math.max(0, bounds.height - rect.top - rect.height);
    canvas.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  getSparkRenderer(): SparkRenderer {
    return this.sparkRenderer;
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.syncPostProcessSize();
  }

  setBackground(color: string): void {
    this.scene.background = new THREE.Color(color);
    this.renderer.setClearColor(color, 1);
    this.edgeFillPass.setBackground(color);
  }

  setEdgeFillRenderMode(mode: EdgeFillRenderMode): void {
    this.edgeFillRenderMode = mode;
  }

  renderCurrentFrame(mode = this.edgeFillRenderMode): void {
    this.edgeFillPass.render(this.scene, this.camera, this.sparkRenderer, mode);
  }

  setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.frameCallbacks.clear();
    this.scene.remove(this.sparkRenderer);
    this.edgeFillPass.dispose();
    this.sparkRenderer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private syncPostProcessSize(): void {
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    this.edgeFillPass.setSize(this.drawingBufferSize.x, this.drawingBufferSize.y);
  }
}
