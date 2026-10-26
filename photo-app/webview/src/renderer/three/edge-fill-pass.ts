// ============================================================
// renderer/three/edge-fill-pass.ts — 实时边缘补洞后处理
// 通过 alpha 覆盖率把 splat 边缘颜色向空洞传播，并模糊合成回屏幕
// ============================================================

import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { SparkRenderer } from '@sparkjsdev/spark';

// 这组值是此前验证过能压住放射状星芒的配置：
// 空洞判定改为 9 点平均（不再放大点云边缘的单点毛刺），
// 同时收紧填充半径与传播距离，避免把几十像素外的颜色沿固定方向拉成条纹。
// 代价是填充覆盖变小，画面整体会比原项目略暗。
const FILL_RESOLUTION_SCALE = 0.5;
const ALPHA_THRESHOLD = 0.02;
const SEED_ALPHA_THRESHOLD = 0.35;
const SEED_INSET_PX = 12;
const EDGE_ERODE_PX = 1;
const EDGE_FEATHER_PX = 20;
const EDGE_KEEP_ALPHA = 0.28;
const PROPAGATION_DECAY = 0.86;
const FILL_MIN_CONFIDENCE = 0.04;
const FILL_FULL_CONFIDENCE = 0.22;
const NEAR_BLUR_PX = 4;
const FAR_BLUR_PX = 24;
const PROPAGATION_STEPS_PX = [48, 32, 20, 12, 8, 4, 2, 1, 1];

export type EdgeFillRenderMode = 'blur-fill' | 'repair-mask';

export class EdgeFillPass {
  private renderer: THREE.WebGLRenderer;
  private sceneTarget: THREE.WebGLRenderTarget;
  private fillTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private seedMaterial: THREE.ShaderMaterial;
  private propagateMaterial: THREE.ShaderMaterial;
  private compositeMaterial: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private renderSize = new THREE.Vector2(1, 1);
  private fillSize = new THREE.Vector2(1, 1);
  private backgroundColor = new THREE.Color();
  private repairMaskColor = new THREE.Color(0xff00ff);
  private scratchColor = new THREE.Color();

  constructor(renderer: THREE.WebGLRenderer, backgroundColor: string) {
    this.renderer = renderer;
    this.backgroundColor.set(backgroundColor);
    this.sceneTarget = this.createTarget(1, 1, 'EdgeFill.scene');
    this.fillTargets = [
      this.createTarget(1, 1, 'EdgeFill.fillA'),
      this.createTarget(1, 1, 'EdgeFill.fillB'),
    ];
    this.seedMaterial = this.createSeedMaterial();
    this.propagateMaterial = this.createPropagateMaterial();
    this.compositeMaterial = this.createCompositeMaterial();
    this.quad = new FullScreenQuad(this.seedMaterial);
  }

  setSize(width: number, height: number): void {
    const targetWidth = Math.max(1, Math.floor(width));
    const targetHeight = Math.max(1, Math.floor(height));
    if (this.renderSize.x === targetWidth && this.renderSize.y === targetHeight) return;

    this.renderSize.set(targetWidth, targetHeight);
    this.fillSize.set(
      Math.max(1, Math.floor(targetWidth * FILL_RESOLUTION_SCALE)),
      Math.max(1, Math.floor(targetHeight * FILL_RESOLUTION_SCALE))
    );
    this.sceneTarget.setSize(targetWidth, targetHeight);
    this.fillTargets[0].setSize(this.fillSize.x, this.fillSize.y);
    this.fillTargets[1].setSize(this.fillSize.x, this.fillSize.y);

    this.seedMaterial.uniforms.uAlphaThreshold.value = ALPHA_THRESHOLD;
    this.seedMaterial.uniforms.uSceneTexelSize.value.set(1 / targetWidth, 1 / targetHeight);
    this.propagateMaterial.uniforms.uFillTexelSize.value.set(1 / this.fillSize.x, 1 / this.fillSize.y);
    this.compositeMaterial.uniforms.uSceneTexelSize.value.set(1 / targetWidth, 1 / targetHeight);
    this.compositeMaterial.uniforms.uFillTexelSize.value.set(1 / this.fillSize.x, 1 / this.fillSize.y);
  }

  setBackground(color: string): void {
    this.backgroundColor.set(color);
    this.compositeMaterial.uniforms.uBackgroundColor.value.copy(this.backgroundColor);
  }

  setRepairMaskColor(color: string): void {
    this.repairMaskColor.set(color);
    this.compositeMaterial.uniforms.uRepairMaskColor.value.copy(this.repairMaskColor);
  }

  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    sparkRenderer: SparkRenderer,
    mode: EdgeFillRenderMode = 'blur-fill'
  ): void {
    this.renderSceneToTransparentTarget(scene, camera, sparkRenderer);

    let readTarget = this.seedFillTarget();
    let writeTarget = this.fillTargets[1];

    for (const stepPx of PROPAGATION_STEPS_PX) {
      this.propagateMaterial.uniforms.uInputTexture.value = readTarget.texture;
      this.propagateMaterial.uniforms.uStepPx.value = stepPx;
      this.renderFullscreen(this.propagateMaterial, writeTarget);
      [readTarget, writeTarget] = [writeTarget, readTarget];
    }

    this.compositeMaterial.uniforms.uSceneTexture.value = this.sceneTarget.texture;
    this.compositeMaterial.uniforms.uFillTexture.value = readTarget.texture;
    this.compositeMaterial.uniforms.uBackgroundColor.value.copy(this.backgroundColor);
    this.compositeMaterial.uniforms.uRepairMaskColor.value.copy(this.repairMaskColor);
    this.compositeMaterial.uniforms.uRepairMaskMode.value = mode === 'repair-mask' ? 1 : 0;
    this.renderFullscreen(this.compositeMaterial, null);
  }

  dispose(): void {
    this.sceneTarget.dispose();
    this.fillTargets[0].dispose();
    this.fillTargets[1].dispose();
    this.seedMaterial.dispose();
    this.propagateMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
  }

  private renderSceneToTransparentTarget(
    scene: THREE.Scene,
    camera: THREE.Camera,
    sparkRenderer: SparkRenderer
  ): void {
    const previousTarget = this.renderer.getRenderTarget();
    const previousBackground = scene.background;
    const previousAutoClear = this.renderer.autoClear;
    const previousClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.scratchColor);

    try {
      scene.background = null;
      this.renderer.autoClear = true;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setRenderTarget(this.sceneTarget);
      this.renderer.clear(true, true, true);
      sparkRenderer.render(scene, camera);
    } finally {
      scene.background = previousBackground;
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setClearColor(this.scratchColor, previousClearAlpha);
      this.renderer.setRenderTarget(previousTarget);
    }
  }

  private seedFillTarget(): THREE.WebGLRenderTarget {
    this.seedMaterial.uniforms.uSceneTexture.value = this.sceneTarget.texture;
    this.seedMaterial.uniforms.uAlphaThreshold.value = ALPHA_THRESHOLD;
    this.seedMaterial.uniforms.uSeedAlphaThreshold.value = SEED_ALPHA_THRESHOLD;
    this.seedMaterial.uniforms.uSeedInsetPx.value = SEED_INSET_PX;
    this.renderFullscreen(this.seedMaterial, this.fillTargets[0]);
    return this.fillTargets[0];
  }

  private renderFullscreen(
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null
  ): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, true, true);
    this.quad.render(this.renderer);
  }

  private createTarget(width: number, height: number, name: string): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    target.texture.name = name;
    return target;
  }

  private createSeedMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name: 'EdgeFillSeedMaterial',
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSceneTexture: { value: null },
        uSceneTexelSize: { value: new THREE.Vector2(1, 1) },
        uAlphaThreshold: { value: ALPHA_THRESHOLD },
        uSeedAlphaThreshold: { value: SEED_ALPHA_THRESHOLD },
        uSeedInsetPx: { value: SEED_INSET_PX },
      },
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: SEED_FRAGMENT_SHADER,
    });
  }

  private createPropagateMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name: 'EdgeFillPropagateMaterial',
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uInputTexture: { value: null },
        uFillTexelSize: { value: new THREE.Vector2(1, 1) },
        uStepPx: { value: 1 },
        uPropagationDecay: { value: PROPAGATION_DECAY },
      },
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: PROPAGATE_FRAGMENT_SHADER,
    });
  }

  private createCompositeMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name: 'EdgeFillCompositeMaterial',
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSceneTexture: { value: null },
        uFillTexture: { value: null },
        uSceneTexelSize: { value: new THREE.Vector2(1, 1) },
        uFillTexelSize: { value: new THREE.Vector2(1, 1) },
        uBackgroundColor: { value: this.backgroundColor.clone() },
        uAlphaThreshold: { value: ALPHA_THRESHOLD },
        uSeedAlphaThreshold: { value: SEED_ALPHA_THRESHOLD },
        uEdgeErodePx: { value: EDGE_ERODE_PX },
        uEdgeFeatherPx: { value: EDGE_FEATHER_PX },
        uEdgeKeepAlpha: { value: EDGE_KEEP_ALPHA },
        uFillMinConfidence: { value: FILL_MIN_CONFIDENCE },
        uFillFullConfidence: { value: FILL_FULL_CONFIDENCE },
        uNearBlurPx: { value: NEAR_BLUR_PX },
        uFarBlurPx: { value: FAR_BLUR_PX },
        uRepairMaskMode: { value: 0 },
        uRepairMaskColor: { value: this.repairMaskColor.clone() },
      },
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: COMPOSITE_FRAGMENT_SHADER,
    });
  }
}

const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SEED_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uSceneTexture;
uniform vec2 uSceneTexelSize;
uniform float uAlphaThreshold;
uniform float uSeedAlphaThreshold;
uniform float uSeedInsetPx;

varying vec2 vUv;

vec3 unpremultiply(vec4 color) {
  return color.a > 0.0001 ? color.rgb / color.a : vec3(0.0);
}

vec4 readScene(vec2 direction, float radiusPx) {
  vec2 uv = clamp(vUv + direction * uSceneTexelSize * radiusPx, uSceneTexelSize * 0.5, vec2(1.0) - uSceneTexelSize * 0.5);
  return texture2D(uSceneTexture, uv);
}

float minAlphaRing(float radiusPx) {
  float alpha = texture2D(uSceneTexture, vUv).a;
  alpha = min(alpha, readScene(vec2( 1.0,  0.0), radiusPx).a);
  alpha = min(alpha, readScene(vec2(-1.0,  0.0), radiusPx).a);
  alpha = min(alpha, readScene(vec2( 0.0,  1.0), radiusPx).a);
  alpha = min(alpha, readScene(vec2( 0.0, -1.0), radiusPx).a);
  alpha = min(alpha, readScene(vec2( 0.7071,  0.7071), radiusPx).a);
  alpha = min(alpha, readScene(vec2(-0.7071,  0.7071), radiusPx).a);
  alpha = min(alpha, readScene(vec2( 0.7071, -0.7071), radiusPx).a);
  alpha = min(alpha, readScene(vec2(-0.7071, -0.7071), radiusPx).a);
  return alpha;
}

float minAlphaDisk(float radiusPx) {
  float radius = max(1.0, radiusPx);
  float alpha = texture2D(uSceneTexture, vUv).a;
  alpha = min(alpha, minAlphaRing(1.0));
  alpha = min(alpha, minAlphaRing(max(1.0, radius * 0.18)));
  alpha = min(alpha, minAlphaRing(max(2.0, radius * 0.35)));
  alpha = min(alpha, minAlphaRing(max(4.0, radius * 0.55)));
  alpha = min(alpha, minAlphaRing(max(6.0, radius * 0.75)));
  alpha = min(alpha, minAlphaRing(radius));
  return alpha;
}

void selectBest(inout vec4 bestColor, vec4 sampleColor) {
  if (sampleColor.a > bestColor.a) {
    bestColor = sampleColor;
  }
}

void main() {
  vec4 scene = texture2D(uSceneTexture, vUv);
  vec4 bestColor = scene;
  float nearRadius = max(1.0, uSeedInsetPx * 0.5);

  selectBest(bestColor, readScene(vec2( 1.0,  0.0), nearRadius));
  selectBest(bestColor, readScene(vec2(-1.0,  0.0), nearRadius));
  selectBest(bestColor, readScene(vec2( 0.0,  1.0), nearRadius));
  selectBest(bestColor, readScene(vec2( 0.0, -1.0), nearRadius));
  selectBest(bestColor, readScene(vec2( 0.7071,  0.7071), nearRadius));
  selectBest(bestColor, readScene(vec2(-0.7071,  0.7071), nearRadius));
  selectBest(bestColor, readScene(vec2( 0.7071, -0.7071), nearRadius));
  selectBest(bestColor, readScene(vec2(-0.7071, -0.7071), nearRadius));

  selectBest(bestColor, readScene(vec2( 1.0,  0.0), uSeedInsetPx));
  selectBest(bestColor, readScene(vec2(-1.0,  0.0), uSeedInsetPx));
  selectBest(bestColor, readScene(vec2( 0.0,  1.0), uSeedInsetPx));
  selectBest(bestColor, readScene(vec2( 0.0, -1.0), uSeedInsetPx));
  selectBest(bestColor, readScene(vec2( 0.7071,  0.7071), uSeedInsetPx));
  selectBest(bestColor, readScene(vec2(-0.7071,  0.7071), uSeedInsetPx));
  selectBest(bestColor, readScene(vec2( 0.7071, -0.7071), uSeedInsetPx));
  selectBest(bestColor, readScene(vec2(-0.7071, -0.7071), uSeedInsetPx));

  float erodedAlpha = minAlphaDisk(uSeedInsetPx);
  float coverage = smoothstep(uSeedAlphaThreshold, uSeedAlphaThreshold * 1.4, erodedAlpha);
  gl_FragColor = vec4(unpremultiply(bestColor), coverage);
}
`;

const PROPAGATE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uInputTexture;
uniform vec2 uFillTexelSize;
uniform float uStepPx;
uniform float uPropagationDecay;

varying vec2 vUv;

vec4 readFill(vec2 offset) {
  vec2 uv = clamp(vUv + offset * uFillTexelSize * uStepPx, uFillTexelSize * 0.5, vec2(1.0) - uFillTexelSize * 0.5);
  return texture2D(uInputTexture, uv);
}

void accumulate(inout vec3 rgbSum, inout float weightSum, inout float maxConfidence, vec4 sampleColor) {
  float weight = smoothstep(0.001, 0.12, sampleColor.a);
  rgbSum += sampleColor.rgb * weight;
  weightSum += weight;
  maxConfidence = max(maxConfidence, sampleColor.a);
}

void main() {
  vec4 center = texture2D(uInputTexture, vUv);
  vec3 rgbSum = center.rgb * center.a * 0.5;
  float weightSum = center.a * 0.5;
  float maxConfidence = center.a;

  accumulate(rgbSum, weightSum, maxConfidence, readFill(vec2( 1.0,  0.0)));
  accumulate(rgbSum, weightSum, maxConfidence, readFill(vec2(-1.0,  0.0)));
  accumulate(rgbSum, weightSum, maxConfidence, readFill(vec2( 0.0,  1.0)));
  accumulate(rgbSum, weightSum, maxConfidence, readFill(vec2( 0.0, -1.0)));
  accumulate(rgbSum, weightSum, maxConfidence, readFill(vec2( 0.7071,  0.7071)));
  accumulate(rgbSum, weightSum, maxConfidence, readFill(vec2(-0.7071,  0.7071)));
  accumulate(rgbSum, weightSum, maxConfidence, readFill(vec2( 0.7071, -0.7071)));
  accumulate(rgbSum, weightSum, maxConfidence, readFill(vec2(-0.7071, -0.7071)));

  if (weightSum <= 0.0001) {
    gl_FragColor = center;
    return;
  }

  gl_FragColor = vec4(rgbSum / weightSum, maxConfidence * uPropagationDecay);
}
`;

const COMPOSITE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uSceneTexture;
uniform sampler2D uFillTexture;
uniform vec2 uSceneTexelSize;
uniform vec2 uFillTexelSize;
uniform vec3 uBackgroundColor;
uniform float uAlphaThreshold;
uniform float uSeedAlphaThreshold;
uniform float uEdgeErodePx;
uniform float uEdgeFeatherPx;
uniform float uEdgeKeepAlpha;
uniform float uFillMinConfidence;
uniform float uFillFullConfidence;
uniform float uNearBlurPx;
uniform float uFarBlurPx;
uniform int uRepairMaskMode;
uniform vec3 uRepairMaskColor;

varying vec2 vUv;

float readSceneAlpha(vec2 direction, float radiusPx) {
  vec2 uv = clamp(vUv + direction * uSceneTexelSize * radiusPx, uSceneTexelSize * 0.5, vec2(1.0) - uSceneTexelSize * 0.5);
  return texture2D(uSceneTexture, uv).a;
}

// 用 9 点平均而不是取最小。点云边缘的 alpha 本身参差，取最小会让
// 任意一处毛刺把整片区域判成空洞，进而触发大范围颜色拉伸，形成放射状星芒。
float averageSceneAlphaRing(float radiusPx) {
  float alpha = texture2D(uSceneTexture, vUv).a;
  alpha += readSceneAlpha(vec2( 1.0,  0.0), radiusPx);
  alpha += readSceneAlpha(vec2(-1.0,  0.0), radiusPx);
  alpha += readSceneAlpha(vec2( 0.0,  1.0), radiusPx);
  alpha += readSceneAlpha(vec2( 0.0, -1.0), radiusPx);
  alpha += readSceneAlpha(vec2( 0.7071,  0.7071), radiusPx);
  alpha += readSceneAlpha(vec2(-0.7071,  0.7071), radiusPx);
  alpha += readSceneAlpha(vec2( 0.7071, -0.7071), radiusPx);
  alpha += readSceneAlpha(vec2(-0.7071, -0.7071), radiusPx);
  return alpha / 9.0;
}

float outsideAt(float radiusPx) {
  float solid = smoothstep(uAlphaThreshold, uEdgeKeepAlpha, averageSceneAlphaRing(radiusPx));
  return 1.0 - solid;
}

void updateOutsideDistance(inout float distancePx, float radiusPx, float maxDistancePx) {
  float outside = outsideAt(radiusPx);
  distancePx = min(distancePx, mix(maxDistancePx, radiusPx, outside));
}

float outsideDistanceEstimate(float maxDistancePx) {
  float distancePx = maxDistancePx;
  updateOutsideDistance(distancePx, 1.0, maxDistancePx);
  updateOutsideDistance(distancePx, 2.0, maxDistancePx);
  updateOutsideDistance(distancePx, 4.0, maxDistancePx);
  updateOutsideDistance(distancePx, 8.0, maxDistancePx);
  updateOutsideDistance(distancePx, 12.0, maxDistancePx);
  updateOutsideDistance(distancePx, 18.0, maxDistancePx);
  updateOutsideDistance(distancePx, 24.0, maxDistancePx);
  updateOutsideDistance(distancePx, 32.0, maxDistancePx);
  updateOutsideDistance(distancePx, 44.0, maxDistancePx);
  updateOutsideDistance(distancePx, 60.0, maxDistancePx);
  updateOutsideDistance(distancePx, 80.0, maxDistancePx);
  updateOutsideDistance(distancePx, uEdgeErodePx, maxDistancePx);
  updateOutsideDistance(distancePx, uEdgeErodePx + uEdgeFeatherPx * 0.5, maxDistancePx);
  updateOutsideDistance(distancePx, uEdgeErodePx + uEdgeFeatherPx, maxDistancePx);
  return distancePx;
}

float erodedSceneKeep() {
  float feather = max(1.0, uEdgeFeatherPx);
  float maxDistancePx = max(96.0, uEdgeErodePx + feather + 8.0);
  float distancePx = outsideDistanceEstimate(maxDistancePx);
  return smoothstep(uEdgeErodePx, uEdgeErodePx + feather, distancePx);
}

vec4 readFill(vec2 direction, float radiusPx) {
  vec2 uv = clamp(vUv + direction * uFillTexelSize * radiusPx, uFillTexelSize * 0.5, vec2(1.0) - uFillTexelSize * 0.5);
  return texture2D(uFillTexture, uv);
}

void accumulateFill(inout vec3 rgbSum, inout float weightSum, vec4 sampleColor, float weightScale) {
  float weight = smoothstep(0.001, 0.12, sampleColor.a) * weightScale;
  rgbSum += sampleColor.rgb * weight;
  weightSum += weight;
}

vec3 blurredFill(vec4 center) {
  float farFactor = 1.0 - smoothstep(uFillMinConfidence, 0.85, center.a);
  float radius = mix(uNearBlurPx, uFarBlurPx, farFactor);
  vec3 rgbSum = center.rgb * max(center.a, 0.001) * 2.0;
  float weightSum = max(center.a, 0.001) * 2.0;

  accumulateFill(rgbSum, weightSum, readFill(vec2( 1.0,  0.0), radius), 1.0);
  accumulateFill(rgbSum, weightSum, readFill(vec2(-1.0,  0.0), radius), 1.0);
  accumulateFill(rgbSum, weightSum, readFill(vec2( 0.0,  1.0), radius), 1.0);
  accumulateFill(rgbSum, weightSum, readFill(vec2( 0.0, -1.0), radius), 1.0);
  accumulateFill(rgbSum, weightSum, readFill(vec2( 0.7071,  0.7071), radius), 0.72);
  accumulateFill(rgbSum, weightSum, readFill(vec2(-0.7071,  0.7071), radius), 0.72);
  accumulateFill(rgbSum, weightSum, readFill(vec2( 0.7071, -0.7071), radius), 0.72);
  accumulateFill(rgbSum, weightSum, readFill(vec2(-0.7071, -0.7071), radius), 0.72);

  float innerRadius = max(1.0, radius * 0.45);
  accumulateFill(rgbSum, weightSum, readFill(vec2( 1.0,  0.0), innerRadius), 1.2);
  accumulateFill(rgbSum, weightSum, readFill(vec2(-1.0,  0.0), innerRadius), 1.2);
  accumulateFill(rgbSum, weightSum, readFill(vec2( 0.0,  1.0), innerRadius), 1.2);
  accumulateFill(rgbSum, weightSum, readFill(vec2( 0.0, -1.0), innerRadius), 1.2);

  return rgbSum / max(weightSum, 0.0001);
}

// SparkRenderer 的 encodeLinear 默认为 false，sceneTarget 里是线性值；
// 而自定义 ShaderMaterial 不会被 three.js 自动追加 colorspace_fragment，
// 直接输出线性值会让屏幕按 sRGB 解释，整幅画面系统性偏暗（暗部尤甚）。
// 这里手动做一次 linear → sRGB 编码。
vec3 linearToSrgb(vec3 rgb) {
  vec3 clamped = max(rgb, vec3(0.0));
  vec3 lo = clamped * 12.92;
  vec3 hi = 1.055 * pow(clamped, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), clamped));
}

void main() {
  vec4 scene = texture2D(uSceneTexture, vUv);
  vec4 fill = texture2D(uFillTexture, vUv);
  float sceneKeep = erodedSceneKeep();
  float hole = 1.0 - sceneKeep;
  float fillMask = hole * smoothstep(uFillMinConfidence, uFillFullConfidence, fill.a);
  vec3 fillRgb = blurredFill(fill);
  vec3 behind = mix(uBackgroundColor, fillRgb, fillMask);

  float effectiveAlpha = scene.a * sceneKeep;
  vec3 sceneRgb = scene.a > 0.0001 ? scene.rgb / scene.a : fillRgb;
  float detailKeep = smoothstep(0.72, 0.98, sceneKeep);
  vec3 edgeCleanRgb = mix(fillRgb, sceneRgb, detailKeep);
  vec3 color = edgeCleanRgb * effectiveAlpha + (1.0 - effectiveAlpha) * behind;
  if (uRepairMaskMode == 1) {
    float rawCoverage = smoothstep(uAlphaThreshold, uEdgeKeepAlpha, scene.a);
    float sparseCoverageMask = (1.0 - rawCoverage) * smoothstep(0.001, uFillFullConfidence, fill.a);
    float strongHoleMask = smoothstep(uFillMinConfidence, uFillFullConfidence, fill.a) * (1.0 - smoothstep(uAlphaThreshold, uSeedAlphaThreshold, scene.a));
    float repairMask = clamp(max(sparseCoverageMask * 0.72, strongHoleMask), 0.0, 1.0);
    color = mix(color, uRepairMaskColor, repairMask);
  }
  gl_FragColor = vec4(linearToSrgb(color), 1.0);
}
`;
