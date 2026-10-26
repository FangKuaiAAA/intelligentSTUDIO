// ============================================================
// renderer/ui/upload.ts — 图片上传组件
// 支持三种上传方式：点击选择文件、拖拽文件到区域、从剪贴板粘贴
// ============================================================

import { appEvents } from '../state/events';
import { Events } from '../state/types';
import { fileAPI } from '../api/ipc';
import { Upload } from 'lucide';
import { renderLucideIcon } from './lucide';

export class UploadUI {
  private container: HTMLElement;
  private dropZone: HTMLElement;
  private fileInput: HTMLInputElement;
  private enabled = true;
  private loading = false;
  private objectUrl: string | null = null;

  constructor() {
    this.container = this.createContainer();
    this.dropZone = this.createDropZone();
    this.fileInput = this.createFileInput();
    this.container.appendChild(this.dropZone);
    this.bindEvents();
    this.mount();
  }

  private createContainer(): HTMLElement {
    const el = document.getElementById('upload-area');
    if (el) return el;
    const div = document.createElement('div');
    div.id = 'upload-area';
    return div;
  }

  private createDropZone(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'upload-dropzone';
    el.innerHTML = this.renderIdleContent();
    return el;
  }

  private renderIdleContent(): string {
    return `
      <div class="upload-icon" aria-hidden="true">
        ${renderLucideIcon('upload', Upload)}
      </div>
      <div class="upload-text">上传图片</div>
      <div class="upload-subtext">点击选择，或将图片拖入窗口</div>
      <div class="upload-meta">支持 JPG、PNG、HEIC、WEBP</div>
    `;
  }

  private renderLoadingContent(): string {
    return `
      <div class="upload-loader" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">
          <path d="M0 0h24v24H0z" fill="none" />
          <circle cx="4" cy="12" r="3" fill="currentColor">
            <animate id="SVGKiXXedfO" attributeName="cy" begin="0;SVGgLulOGrw.end+0.25s" calcMode="spline" dur="0.6s" keySplines=".33,.66,.66,1;.33,0,.66,.33" values="12;6;12" />
          </circle>
          <circle cx="12" cy="12" r="3" fill="currentColor">
            <animate attributeName="cy" begin="SVGKiXXedfO.begin+0.1s" calcMode="spline" dur="0.6s" keySplines=".33,.66,.66,1;.33,0,.66,.33" values="12;6;12" />
          </circle>
          <circle cx="20" cy="12" r="3" fill="currentColor">
            <animate id="SVGgLulOGrw" attributeName="cy" begin="SVGKiXXedfO.begin+0.2s" calcMode="spline" dur="0.6s" keySplines=".33,.66,.66,1;.33,0,.66,.33" values="12;6;12" />
          </circle>
        </svg>
      </div>
      <div class="upload-text">正在准备图片</div>
      <div class="upload-subtext">马上进入查看器</div>
      <div class="upload-meta">请稍候，不需要重复选择</div>
    `;
  }

  private createFileInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/heic,image/heif,image/webp';
    input.style.display = 'none';
    this.container.appendChild(input);
    return input;
  }

  private bindEvents(): void {
    this.dropZone.addEventListener('click', () => {
      if (!this.enabled) return;
      void this.openPicker();
    });

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) this.handleFile(file);
    });

    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropZone.classList.add('drag-over');
    });

    this.dropZone.addEventListener('dragleave', () => {
      this.dropZone.classList.remove('drag-over');
    });

    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file && this.enabled) this.handleFile(file);
    });

    document.addEventListener('paste', (e) => {
      if (!this.enabled) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) this.handleFile(file);
          break;
        }
      }
    });

    appEvents.on(Events.UPLOAD_REQUESTED, () => {
      void this.openPicker();
    });
  }

  async openPicker(): Promise<void> {
    this.setEnabled(true);
    try {
      const result = await fileAPI.openImage();
      const imagePath = result.filePaths[0];
      if (result.canceled || !imagePath) return;

      this.setLoading(true);
      this.setReferenceUrl(result.referenceImageUrl ?? imagePath);
      appEvents.emit(Events.IMAGE_SELECTED, { path: imagePath });
    } catch (err) {
      this.setLoading(false);
      appEvents.emit(Events.APP_ERROR, {
        code: 'FILE_READ_ERROR',
        message: '无法打开图片',
        detail: String(err),
      });
    }
  }

  private handleFile(file: File): void {
    const ext = file.name.split('.').pop()?.toLowerCase();
    const supported = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'];
    if (!ext || !supported.includes(ext)) {
      appEvents.emit(Events.APP_ERROR, {
        code: 'UNSUPPORTED_IMAGE_FORMAT',
        message: '不支持的图片格式，请使用 JPG/PNG/HEIC',
        detail: `文件扩展名: .${ext}`,
      });
      return;
    }

    try {
      this.setLoading(true);
      this.setReferenceObjectUrl(file);
      const imagePath = fileAPI.getPathForFile(file);
      if (imagePath) {
        appEvents.emit(Events.IMAGE_SELECTED, { path: imagePath, file });
      } else {
        this.setLoading(false);
        appEvents.emit(Events.APP_ERROR, {
          code: 'FILE_READ_ERROR',
          message: '无法读取文件路径',
          detail: '文件路径不可用',
        });
      }
    } catch (err) {
      this.setLoading(false);
      appEvents.emit(Events.APP_ERROR, {
        code: 'FILE_READ_ERROR',
        message: '无法读取文件路径',
        detail: String(err),
      });
    }
  }

  onFileSelected(cb: (payload: string | { path: string; file?: File }) => void): void {
    appEvents.on(Events.IMAGE_SELECTED, cb);
  }

  private setReferenceObjectUrl(file: File): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.setReferenceUrl(this.objectUrl);
  }

  private setReferenceUrl(url: string): void {
    appEvents.emit(Events.REFERENCE_IMAGE_READY, url);
  }

  private mount(): void {
    const app = document.getElementById('app');
    if (app) {
      app.appendChild(this.container);
    }
  }

  show(): void {
    this.container.style.display = '';
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.syncStateClasses();
  }

  setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    if (loading) this.enabled = false;
    this.dropZone.innerHTML = loading ? this.renderLoadingContent() : this.renderIdleContent();
    this.dropZone.setAttribute('aria-busy', String(loading));
    this.syncStateClasses();
  }

  private syncStateClasses(): void {
    this.container.classList.toggle('is-loading', this.loading);
    this.dropZone.classList.toggle('is-loading', this.loading);
    this.dropZone.classList.toggle('is-disabled', !this.enabled && !this.loading);
  }
}
