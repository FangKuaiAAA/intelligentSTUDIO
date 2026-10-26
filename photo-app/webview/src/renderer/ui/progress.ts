// ============================================================
// renderer/ui/progress.ts — 进度指示器
// 显示推理进度、模型下载进度
// ============================================================

export class ProgressUI {
  private container: HTMLElement;
  private progressBar: HTMLElement;
  private progressText: HTMLElement;
  private messageEl: HTMLElement;

  constructor() {
    this.container = this.createContainer();
    this.progressBar = this.container.querySelector('#progress-bar')!;
    this.progressText = this.container.querySelector('#progress-text')!;
    this.messageEl = this.container.querySelector('#progress-message')!;
    this.mount();
  }

  private createContainer(): HTMLElement {
    const existing = document.getElementById('progress-container');
    if (existing) return existing;
    const el = document.createElement('div');
    el.id = 'progress-container';
    el.innerHTML = `
      <div class="progress-content liquid-cluster">
        <div id="progress-text" class="progress-text"></div>
        <div id="progress-message" class="progress-message"></div>
        <div id="progress-bar" class="progress-bar-fill" aria-hidden="true"></div>
      </div>
    `;
    return el;
  }

  private mount(): void {
    const app = document.getElementById('app');
    if (app) app.appendChild(this.container);
  }

  show(message: string): void {
    this.progressText.textContent = message;
    this.messageEl.textContent = '';
    this.container.style.display = 'block';
    this.progressBar.style.width = '0%';
  }

  update(percent: number, message?: string): void {
    this.progressBar.style.width = `${percent}%`;
    if (message) {
      this.messageEl.textContent = message;
    }
  }

  hide(): void {
    this.container.style.display = 'none';
  }
}
