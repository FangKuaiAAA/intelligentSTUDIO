// ============================================================
// renderer/ui/image-generate-fx.ts
// 轻量等待态图片波浪扰动 + 柔焦模糊
// ============================================================

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = (aPosition + 1.0) * 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const BLUR_TEXTURE_SCALE = 0.12;
const BLUR_TEXTURE_MAX_EDGE = 320;
const BLUR_TEXTURE_RADIUS_PX = 14;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uStrength;

in vec2 vUv;
out vec4 fragColor;

vec2 waveOffset(vec2 uv, float time, float strength) {
  float waveX = sin((uv.y * 14.0) + time * 1.8);
  float waveY = sin((uv.x * 9.0) - time * 1.25);
  float cross = sin(((uv.x + uv.y) * 10.0) + time * 0.9);
  return vec2(
    (waveX + cross * 0.45) * 0.010 * strength,
    waveY * 0.006 * strength
  );
}

void main() {
  vec2 offset = waveOffset(vUv, uTime, uStrength);
  vec2 blurUv = clamp(vUv + offset * 1.35, vec2(0.0), vec2(1.0));

  vec3 blurred = texture(uTexture, blurUv).rgb;

  float pulse = 0.5 + 0.5 * sin(uTime * 0.7);
  vec3 finalColor = blurred * (1.0 + 0.018 * pulse);

  fragColor = vec4(finalColor, 1.0);
}
`;

type UniformLocations = {
  uTexture: WebGLUniformLocation;
  uTime: WebGLUniformLocation;
  uStrength: WebGLUniformLocation;
};

export class ImageGenerateFxRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: UniformLocations | null = null;
  private blurTexture: WebGLTexture | null = null;
  private rafId: number | null = null;
  private startTime = 0;
  private sourceUrl: string | null = null;
  private sourceImage: HTMLImageElement | null = null;
  private preparedWidth = 0;
  private preparedHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.init();
  }

  async setSourceUrl(url: string): Promise<void> {
    if (this.sourceUrl === url && this.blurTexture) return;
    this.sourceUrl = url;
    const image = await this.loadImage(url);
    this.sourceImage = image;
    this.preparedWidth = 0;
    this.preparedHeight = 0;
    this.resize();
    this.prepareSourceTextures();
  }

  /**
   * 判断指定 url 的源图是否已加载且纹理已准备就绪。
   * 用于 EffectsUI 在显示前判断是否可跳过 stop+clear，保留 canvas 已有内容。
   */
  hasSource(url: string): boolean {
    return this.sourceUrl === url && this.blurTexture !== null;
  }

  start(): void {
    if (this.rafId !== null) return;
    this.startTime = performance.now();
    const tick = (time: number): void => {
      this.rafId = requestAnimationFrame(tick);
      this.render(time);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  clear(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  resize(): void {
    const width = Math.max(1, Math.round(this.canvas.clientWidth * window.devicePixelRatio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * window.devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl?.viewport(0, 0, width, height);
  }

  dispose(): void {
    this.stop();
    const gl = this.gl;
    if (!gl) return;
    if (this.blurTexture) gl.deleteTexture(this.blurTexture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.blurTexture = null;
    this.vao = null;
    this.program = null;
    this.uniforms = null;
  }

  private init(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    if (!gl) {
      console.warn('WebGL2 不可用，图片扰动效果无法启用');
      return;
    }
    this.gl = gl;
    this.program = this.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
    this.uniforms = this.readUniforms(this.program);

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.uTexture, 0);
    gl.uniform1f(this.uniforms.uStrength, 1);
  }

  private render(time: number): void {
    const gl = this.gl;
    if (!gl || !this.program || !this.uniforms || !this.vao || !this.blurTexture) return;

    this.resize();
    this.prepareSourceTextures();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.blurTexture);

    const elapsed = (time - this.startTime) * 0.001;
    gl.uniform1f(this.uniforms.uTime, elapsed);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private uploadBlurTexture(source: TexImageSource): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.blurTexture) gl.deleteTexture(this.blurTexture);

    const texture = gl.createTexture();
    if (!texture) throw new Error('无法创建 WebGL 纹理');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    this.blurTexture = texture;
  }

  private prepareSourceTextures(): void {
    if (!this.sourceImage || !this.gl || this.canvas.width <= 1 || this.canvas.height <= 1) return;
    if (this.preparedWidth === this.canvas.width && this.preparedHeight === this.canvas.height) return;

    const colorCanvas = this.createCoveredImageCanvas(this.sourceImage, this.canvas.width, this.canvas.height);
    const blurCanvas = this.createBlurredImageCanvas(colorCanvas);
    this.uploadBlurTexture(blurCanvas);
    this.preparedWidth = this.canvas.width;
    this.preparedHeight = this.canvas.height;
  }

  private createCoveredImageCanvas(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建图片预处理画布');

    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    const x = (width - drawWidth) * 0.5;
    const y = (height - drawHeight) * 0.5;
    ctx.drawImage(image, x, y, drawWidth, drawHeight);
    return canvas;
  }

  private createBlurredImageCanvas(image: HTMLCanvasElement): HTMLCanvasElement {
    const blurred = document.createElement('canvas');
    const maxEdge = Math.max(image.width, image.height);
    const textureScale = Math.min(BLUR_TEXTURE_SCALE, BLUR_TEXTURE_MAX_EDGE / maxEdge);
    blurred.width = Math.max(1, Math.round(image.width * textureScale));
    blurred.height = Math.max(1, Math.round(image.height * textureScale));
    const blurCtx = blurred.getContext('2d');
    if (!blurCtx) throw new Error('无法创建 blur 画布');

    blurCtx.clearRect(0, 0, blurred.width, blurred.height);
    blurCtx.imageSmoothingEnabled = true;
    blurCtx.imageSmoothingQuality = 'low';
    blurCtx.filter = `blur(${BLUR_TEXTURE_RADIUS_PX}px) saturate(1.02) brightness(1.03)`;
    blurCtx.drawImage(image, 0, 0, blurred.width, blurred.height);
    blurCtx.filter = 'none';
    return blurred;
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片扰动源加载失败'));
      image.src = url;
    });
  }

  private createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl!;
    const vertex = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragment = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error('无法创建 WebGL program');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`图片扰动 shader link 失败: ${info}`);
    }
    return program;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl!;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('无法创建 WebGL shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`图片扰动 shader compile 失败: ${info}`);
    }
    return shader;
  }

  private readUniforms(program: WebGLProgram): UniformLocations {
    const gl = this.gl!;
    const get = (name: keyof UniformLocations): WebGLUniformLocation => {
      const location = gl.getUniformLocation(program, name);
      if (location === null) throw new Error(`缺少 uniform: ${name}`);
      return location;
    };
    return {
      uTexture: get('uTexture'),
      uTime: get('uTime'),
      uStrength: get('uStrength'),
    };
  }
}
