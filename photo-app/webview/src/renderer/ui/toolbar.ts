// ============================================================
// renderer/ui/toolbar.ts — 自定义标题栏与底部动作组
// ============================================================

import { appAPI } from '../api/ipc';
import { appEvents } from '../state/events';
import { Events } from '../state/types';
import { renderLucideIcon } from './lucide';
import { ChevronLeft, Maximize2, Minimize2, Minus, Settings, X } from 'lucide';

type ToolbarMode = 'idle' | 'ready' | 'processing' | 'result';

export class ToolbarUI {
  private container: HTMLElement;
  private bottomActions: HTMLElement;
  private backButton: HTMLButtonElement | null = null;
  private maximizeButton: HTMLButtonElement | null = null;
  private mode: ToolbarMode = 'idle';

  constructor() {
    this.container = this.createContainer();
    this.bottomActions = this.container.querySelector('#bottom-actions')!;
    this.bindEvents();
    this.mount();
    this.setMode('idle');
  }

  private createContainer(): HTMLElement {
    const existing = document.getElementById('toolbar-shell');
    if (existing) return existing;
    const el = document.createElement('div');
    el.id = 'toolbar-shell';
    el.innerHTML = `
      <header id="titlebar" class="app-titlebar">
        <div class="titlebar-drag" aria-hidden="true"></div>
        <button id="btn-back" class="liquid-button icon-button titlebar-back" title="返回上传" aria-label="返回上传">
          ${renderLucideIcon('chevron-left', ChevronLeft)}
        </button>
        <div class="titlebar-controls" role="group" aria-label="窗口控制">
          <button id="btn-settings" class="liquid-button icon-button titlebar-control" title="设置" aria-label="设置">
            ${renderLucideIcon('settings', Settings)}
          </button>
          <button id="btn-minimize" class="liquid-button icon-button titlebar-control" title="最小化" aria-label="最小化">
            ${renderLucideIcon('minus', Minus)}
          </button>
          <button id="btn-maximize" class="liquid-button icon-button titlebar-control" title="最大化" aria-label="最大化">
            ${renderLucideIcon('maximize-2', Maximize2)}
          </button>
          <button id="btn-close" class="liquid-button icon-button titlebar-control titlebar-control-close" title="关闭" aria-label="关闭">
            ${renderLucideIcon('x', X)}
          </button>
        </div>
      </header>
      <nav id="bottom-actions" class="bottom-actions" aria-label="视图操作">
        <button id="btn-reset" class="bottom-action liquid-button" type="button">重置视图</button>
        <button id="btn-reconstruct" class="bottom-action liquid-button bottom-action-primary" type="button">开始重构</button>
        <button id="btn-compare" class="bottom-action liquid-button" type="button">按住对比</button>
        <button id="btn-save" class="bottom-action liquid-button bottom-action-primary" type="button">保存</button>
      </nav>
    `;
    return el;
  }

  private bindEvents(): void {
    this.backButton = this.container.querySelector('#btn-back');
    this.maximizeButton = this.container.querySelector('#btn-maximize');

    this.backButton?.addEventListener('click', () => {
      if (this.mode === 'idle') return;
      if (this.mode === 'result') {
        appEvents.emit(Events.RETURN_TO_VIEWER);
      } else {
        appEvents.emit(Events.RETURN_TO_UPLOAD);
      }
    });

    this.container.querySelector('#btn-settings')?.addEventListener('click', () => {
      appEvents.emit('settings:open');
    });

    this.container.querySelector('#btn-minimize')?.addEventListener('click', () => {
      void appAPI.windowControl('minimize');
    });

    this.maximizeButton?.addEventListener('click', () => {
      void appAPI.windowControl('toggle-maximize');
    });

    void appAPI.getWindowState().then((state) => this.updateMaximizeButton(state.isMaximized));
    appAPI.onWindowStateChange((state) => {
      this.updateMaximizeButton(state.isMaximized);
    });

    this.container.querySelector('#btn-close')?.addEventListener('click', () => {
      void appAPI.windowControl('close');
    });

    this.container.querySelector('#btn-reset')?.addEventListener('click', () => {
      if (this.mode === 'ready') appEvents.emit('viewer:reset');
    });

    this.container.querySelector('#btn-reconstruct')?.addEventListener('click', () => {
      if (this.mode === 'ready') appEvents.emit(Events.RECONSTRUCTION_START);
    });

    const compare = this.container.querySelector('#btn-compare');
    compare?.addEventListener('pointerdown', (event) => {
      if (this.mode !== 'result') return;
      (event.currentTarget as HTMLElement).setPointerCapture((event as PointerEvent).pointerId);
      appEvents.emit(Events.RECONSTRUCTION_COMPARE_START);
    });
    compare?.addEventListener('pointerup', (event) => {
      if (this.mode !== 'result') return;
      const target = event.currentTarget as HTMLElement;
      const pointerId = (event as PointerEvent).pointerId;
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      appEvents.emit(Events.RECONSTRUCTION_COMPARE_END);
    });
    compare?.addEventListener('pointercancel', () => {
      appEvents.emit(Events.RECONSTRUCTION_COMPARE_END);
    });
    compare?.addEventListener('pointerleave', () => {
      appEvents.emit(Events.RECONSTRUCTION_COMPARE_END);
    });

    this.container.querySelector('#btn-save')?.addEventListener('click', () => {
      if (this.mode === 'result') appEvents.emit(Events.RECONSTRUCTION_SAVE);
    });
  }

  private mount(): void {
    const app = document.getElementById('app');
    if (app) app.appendChild(this.container);
  }

  onCapture(cb: () => void): void {
    appEvents.on(Events.CAPTURE_REQUESTED, cb);
  }

  onReset(cb: () => void): void {
    appEvents.on('viewer:reset', cb);
  }

  onExport(cb: () => void): void {
    appEvents.on('viewer:export', cb);
  }

  setEnabled(enabled: boolean): void {
    this.setMode(enabled ? 'ready' : 'idle');
  }

  setProcessing(): void {
    this.setMode('processing');
  }

  setResultMode(): void {
    this.setMode('result');
  }

  setIdle(): void {
    this.setMode('idle');
  }

  setMode(mode: ToolbarMode): void {
    this.mode = mode;
    this.container.dataset.mode = mode;
    this.bottomActions.setAttribute('aria-hidden', mode === 'idle' ? 'true' : 'false');
    this.updateBackButton();
  }

  private updateBackButton(): void {
    if (!this.backButton) return;
    const label = this.mode === 'result' ? '返回模型' : '返回上传';
    this.backButton.title = label;
    this.backButton.setAttribute('aria-label', label);
  }

  private updateMaximizeButton(isMaximized: boolean): void {
    if (!this.maximizeButton) return;

    this.maximizeButton.innerHTML = isMaximized
      ? renderLucideIcon('minimize-2', Minimize2)
      : renderLucideIcon('maximize-2', Maximize2);
    this.maximizeButton.title = isMaximized ? '还原' : '最大化';
    this.maximizeButton.setAttribute('aria-label', isMaximized ? '还原' : '最大化');
  }
}
