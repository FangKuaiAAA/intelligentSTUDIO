// ============================================================
// renderer/three/controls.ts — 相机控制
// 封装 OrbitControls 相机控制器
// ============================================================

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';
import type { Camera, Object3D, WebGLRenderer } from 'three';
import {
  DEFAULT_CAMERA_POSITION,
  DEFAULT_CAMERA_LOOK_AT,
  DEFAULT_CAMERA_UP,
} from '../../shared/constants';
import type { CameraState } from './types';

export class CameraController {
  private controls: OrbitControls;
  private camera: Camera;
  private renderer: WebGLRenderer;
  private homeState: CameraState | null = null;
  private raycastTargets: Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private rotatePivot: THREE.Vector3 | null = null;
  private rotateVelocity = new THREE.Vector2();
  private lastPointer: { x: number; y: number; pointerId: number } | null = null;
  private readonly rotateSensitivity = 0.005;
  private readonly rotateStopThreshold = 0.01;
  private preventContextMenu = (event: MouseEvent): void => event.preventDefault();
  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    this.rotatePivot = this.pickPivot(event) ?? this.controls.target.clone();
    this.rotateVelocity.set(0, 0);
    this.lastPointer = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.addEventListener('pointercancel', this.handlePointerUp);
  };
  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.rotatePivot || !this.lastPointer || event.pointerId !== this.lastPointer.pointerId) return;
    event.preventDefault();

    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer.x = event.clientX;
    this.lastPointer.y = event.clientY;
    if (dx === 0 && dy === 0) return;

    this.rotateVelocity.x += dx;
    this.rotateVelocity.y += dy;
  };
  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.lastPointer || event.pointerId !== this.lastPointer.pointerId) return;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.handlePointerUp);
    this.lastPointer = null;
  };

  constructor(camera: Camera, renderer: WebGLRenderer) {
    this.camera = camera;
    this.renderer = renderer;
    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.target.set(...DEFAULT_CAMERA_LOOK_AT);
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown, { capture: true });
    this.renderer.domElement.addEventListener('contextmenu', this.preventContextMenu);
    this.saveHomeState();
  }

  setRaycastTargets(targets: Object3D[]): void {
    this.raycastTargets = targets;
  }

  private pickPivot(event: PointerEvent): THREE.Vector3 | null {
    if (this.raycastTargets.length === 0) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const [hit] = this.raycaster.intersectObjects(this.raycastTargets, true);
    return hit?.point.clone() ?? null;
  }

  private rotateAroundPivot(deltaX: number, deltaY: number, pivot: THREE.Vector3): void {
    const camera = this.controls.object;
    const upAxis = new THREE.Vector3(...DEFAULT_CAMERA_UP).normalize();
    const viewOffset = camera.position.clone().sub(pivot);
    const rightAxis = new THREE.Vector3().crossVectors(upAxis, viewOffset).normalize();
    if (rightAxis.lengthSq() < 1e-8) return;
    const yaw = new THREE.Quaternion().setFromAxisAngle(upAxis, -deltaX * this.rotateSensitivity);
    const pitchAmount = this.clampPitchDelta(viewOffset, upAxis, -deltaY * this.rotateSensitivity);
    const pitch = new THREE.Quaternion().setFromAxisAngle(rightAxis, pitchAmount);
    const rotation = yaw.multiply(pitch);

    camera.position.copy(viewOffset.applyQuaternion(rotation).add(pivot));
    this.controls.target.sub(pivot).applyQuaternion(rotation).add(pivot);
    camera.up.set(...DEFAULT_CAMERA_UP);
    this.controls.update();
  }

  private updatePivotRotation(): void {
    if (!this.rotatePivot) {
      this.rotateVelocity.set(0, 0);
      return;
    }

    const damping = this.controls.dampingFactor;
    if (this.rotateVelocity.lengthSq() <= this.rotateStopThreshold * this.rotateStopThreshold) {
      this.rotateVelocity.set(0, 0);
      if (!this.lastPointer) this.rotatePivot = null;
      return;
    }

    this.rotateAroundPivot(
      this.rotateVelocity.x * damping,
      this.rotateVelocity.y * damping,
      this.rotatePivot
    );
    this.rotateVelocity.multiplyScalar(1 - damping);
  }

  private stopPivotRotation(): void {
    this.rotatePivot = null;
    this.rotateVelocity.set(0, 0);
  }

  private clampPitchDelta(viewOffset: THREE.Vector3, upAxis: THREE.Vector3, requestedDelta: number): number {
    const polar = Math.acos(THREE.MathUtils.clamp(viewOffset.clone().normalize().dot(upAxis), -1, 1));
    const minPolar = 0.01;
    const maxPolar = Math.PI - 0.01;
    return THREE.MathUtils.clamp(requestedDelta, minPolar - polar, maxPolar - polar);
  }

  reset(): void {
    this.stopPivotRotation();
    const state = this.homeState;
    this.controls.object.position.set(...(state?.position ?? DEFAULT_CAMERA_POSITION));
    this.controls.object.up.set(...DEFAULT_CAMERA_UP);
    this.controls.target.set(...(state?.target ?? DEFAULT_CAMERA_LOOK_AT));
    (this.controls.object as any).zoom = state?.zoom ?? 1;
    this.updateCameraProjection();
    this.controls.update();
  }

  frameSourceCamera(options?: { imageWidth?: number; imageHeight?: number; focalPx?: number }): void {
    this.stopPivotRotation();
    const perspectiveCamera = this.controls.object as THREE.PerspectiveCamera;
    if (perspectiveCamera.isPerspectiveCamera && options?.imageHeight && options.focalPx) {
      const photoFov = THREE.MathUtils.radToDeg(2 * Math.atan(options.imageHeight / (2 * options.focalPx)));
      perspectiveCamera.fov = THREE.MathUtils.clamp(photoFov, 25, 100);
      perspectiveCamera.updateProjectionMatrix();
    }

    this.controls.object.position.set(...DEFAULT_CAMERA_POSITION);
    this.controls.object.up.set(...DEFAULT_CAMERA_UP);
    this.controls.target.set(...DEFAULT_CAMERA_LOOK_AT);
    this.updateCameraProjection();
    this.controls.update();
    this.saveHomeState();
  }

  applyCalibration(settings: {
    cameraPositionX: number;
    cameraPositionY: number;
    cameraPositionZ: number;
    cameraTargetX: number;
    cameraTargetY: number;
    cameraTargetZ: number;
    cameraFov: number;
  }): void {
    this.stopPivotRotation();
    const camera = this.controls.object as THREE.PerspectiveCamera;
    camera.position.set(settings.cameraPositionX, settings.cameraPositionY, settings.cameraPositionZ);
    if (camera.isPerspectiveCamera) {
      camera.fov = settings.cameraFov;
      camera.updateProjectionMatrix();
    }
    this.controls.target.set(settings.cameraTargetX, settings.cameraTargetY, settings.cameraTargetZ);
    this.controls.update();
  }

  getCalibration(): {
    cameraPositionX: number;
    cameraPositionY: number;
    cameraPositionZ: number;
    cameraTargetX: number;
    cameraTargetY: number;
    cameraTargetZ: number;
    cameraFov: number;
  } {
    const camera = this.controls.object as THREE.PerspectiveCamera;
    return {
      cameraPositionX: camera.position.x,
      cameraPositionY: camera.position.y,
      cameraPositionZ: camera.position.z,
      cameraTargetX: this.controls.target.x,
      cameraTargetY: this.controls.target.y,
      cameraTargetZ: this.controls.target.z,
      cameraFov: camera.isPerspectiveCamera ? camera.fov : 75,
    };
  }

  getCameraState(): CameraState {
    return {
      position: [
        this.controls.object.position.x,
        this.controls.object.position.y,
        this.controls.object.position.z,
      ],
      target: [
        this.controls.target.x,
        this.controls.target.y,
        this.controls.target.z,
      ],
      zoom: (this.controls.object as any).zoom || 1,
    };
  }

  setCameraState(state: CameraState): void {
    this.stopPivotRotation();
    this.controls.object.position.set(...state.position);
    this.controls.target.set(...state.target);
    (this.controls.object as any).zoom = state.zoom;
    this.controls.update();
  }

  update(): void {
    this.controls.update();
    this.updatePivotRotation();
  }

  private saveHomeState(): void {
    this.homeState = this.getCameraState();
  }

  private updateCameraProjection(): void {
    const camera = this.controls.object as THREE.PerspectiveCamera;
    if (camera.isPerspectiveCamera) {
      camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown, { capture: true });
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.handlePointerUp);
    this.renderer.domElement.removeEventListener('contextmenu', this.preventContextMenu);
    this.stopPivotRotation();
    this.controls.dispose();
  }
}
