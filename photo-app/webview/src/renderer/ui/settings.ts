// ============================================================
// renderer/ui/settings.ts — 重构供应商设置面板
// ============================================================

import {
  DEFAULT_MAX_SCREEN_SPACE_SPLAT_SIZE,
  DEFAULT_OPACITY_THRESHOLD,
  DEFAULT_POINT_CLOUD_MODE,
  DEFAULT_SPLAT_ALPHA_REMOVAL_THRESHOLD,
  DEFAULT_SPLAT_SCALE,
  DEFAULT_VIEWER_BACKGROUND,
  DEFAULT_VIEWER_FOV,
} from '../../shared/constants';
import type { ReconstructionModel, ReconstructionResolution, ViewerSettings } from '../../shared/types';
import { Check, ChevronDown, X } from 'lucide';
import { renderLucideIcon } from './lucide';

const SETTINGS_STORAGE_KEY = 'sharp-viewer:reconstruction-settings';
const KIE_REGISTER_URL = 'https://kie.ai?ref=eef20ef0b0595cad227d45b29c635f6c';

const RECONSTRUCTION_MODELS: Array<{ value: ReconstructionModel; label: string }> = [
  { value: 'gpt-image-2', label: 'GPT Image 2' },
  { value: 'seedream-5-lite', label: 'Seedream 5.0 Lite' },
  { value: 'nano-banana-2', label: 'Nano Banana 2' },
];

type PersistedSettings = {
  kieApiKey?: string;
  reconstructionModel?: ReconstructionModel;
  reconstructionResolution?: ReconstructionResolution;
};

type SelectConfig<T extends string> = {
  key: string;
  formName: string;
  defaultValue: T;
  options: Array<{ value: T; label: string }>;
  readValue: (settings: ViewerSettings) => T;
  normalizeValue: (value: string) => T;
};

function readPersistedSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedSettings;
    return {
      kieApiKey: typeof parsed.kieApiKey === 'string' ? parsed.kieApiKey : undefined,
      reconstructionModel: isReconstructionModel(parsed.reconstructionModel) ? parsed.reconstructionModel : undefined,
      reconstructionResolution:
        parsed.reconstructionResolution === '4K' || parsed.reconstructionResolution === '2K'
          ? parsed.reconstructionResolution
          : undefined,
    };
  } catch {
    return {};
  }
}

function persistSettings(settings: ViewerSettings): void {
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      kieApiKey: settings.kieApiKey,
      reconstructionModel: settings.reconstructionModel,
      reconstructionResolution: settings.reconstructionResolution,
    } satisfies PersistedSettings)
  );
}

function isReconstructionModel(value: unknown): value is ReconstructionModel {
  return typeof value === 'string' && RECONSTRUCTION_MODELS.some((model) => model.value === value);
}

function normalizeReconstructionModel(value: string): ReconstructionModel {
  return isReconstructionModel(value) ? value : 'gpt-image-2';
}

function getReconstructionModelLabel(value: ReconstructionModel): string {
  return RECONSTRUCTION_MODELS.find((model) => model.value === value)?.label ?? 'GPT Image 2';
}

const persisted = readPersistedSettings();

export const defaultViewerSettings: ViewerSettings = {
  qualityPreset: 'full',
  opacityThreshold: DEFAULT_OPACITY_THRESHOLD,
  maxGaussians: 0,
  focalPxOverride: null,
  splatAlphaRemovalThreshold: DEFAULT_SPLAT_ALPHA_REMOVAL_THRESHOLD,
  splatScale: DEFAULT_SPLAT_SCALE,
  maxScreenSpaceSplatSize: DEFAULT_MAX_SCREEN_SPACE_SPLAT_SIZE,
  pointCloudMode: DEFAULT_POINT_CLOUD_MODE,
  backgroundColor: DEFAULT_VIEWER_BACKGROUND,
  fov: DEFAULT_VIEWER_FOV,
  reconstructionProvider: 'kie',
  reconstructionModel: persisted.reconstructionModel ?? 'gpt-image-2',
  reconstructionInputMode: 'single',
  kieApiKey: persisted.kieApiKey ?? '',
  reconstructionResolution: persisted.reconstructionResolution ?? '2K',
};

type ApplyCallback = (settings: ViewerSettings) => void;

export class SettingsUI {
  private container: HTMLElement;
  private form: HTMLFormElement;
  private settings: ViewerSettings = { ...defaultViewerSettings };
  private applyCallbacks: ApplyCallback[] = [];
  private closeTimer: number | null = null;
  private selectConfigs: Array<SelectConfig<string>>;

  constructor() {
    this.selectConfigs = this.createSelectConfigs();
    this.container = this.createContainer();
    this.form = this.container.querySelector('#settings-form') as HTMLFormElement;
    this.mount();
    this.bindEvents();
    this.syncForm();
  }

  getSettings(): ViewerSettings {
    return { ...this.settings };
  }

  onApply(callback: ApplyCallback): void {
    this.applyCallbacks.push(callback);
  }

  open(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.container.style.display = 'block';
    this.container.classList.remove('is-closing');
    this.container.classList.remove('is-open');
    void this.container.offsetWidth;
    this.container.classList.add('is-open');
    const input = this.form.elements.namedItem('kieApiKey');
    if (input instanceof HTMLInputElement) {
      window.setTimeout(() => input.focus(), 120);
    }
  }

  close(): void {
    if (this.container.style.display === 'none') return;
    this.container.classList.remove('is-open');
    this.container.classList.add('is-closing');
    this.closeTimer = window.setTimeout(() => {
      this.container.style.display = 'none';
      this.container.classList.remove('is-closing');
      this.closeTimer = null;
    }, 220);
  }

  private createContainer(): HTMLElement {
    const existing = document.getElementById('settings-panel');
    if (existing) return existing;
    const el = document.createElement('div');
    el.id = 'settings-panel';
    el.innerHTML = `
      <div class="settings-backdrop" data-settings-close></div>
      <aside class="settings-drawer liquid-surface" aria-label="设置">
        <div class="settings-header">
          <div>
            <div class="settings-title">设置</div>
            <a class="settings-subtitle settings-provider-link" href="${KIE_REGISTER_URL}" target="_blank" rel="noreferrer">
              当前供应商：KIE · 点击此处注册或获取密钥
            </a>
          </div>
          <button type="button" class="liquid-button icon-button settings-close" data-settings-close title="关闭" aria-label="关闭设置">
            ${renderLucideIcon('x', X)}
          </button>
        </div>
        <form id="settings-form" class="settings-form">
          <section class="settings-section">
            <h3>图像重构</h3>
            <label class="setting-row setting-row-inline">
              <span>KIE 密钥</span>
              <input name="kieApiKey" type="password" autocomplete="off" placeholder="Bearer API Key" />
            </label>
            <label class="setting-row setting-row-inline">
              <span>模型</span>
              ${this.renderCustomSelect({
                key: 'model',
                formName: 'reconstructionModel',
                options: RECONSTRUCTION_MODELS,
              })}
            </label>
            <label class="setting-row setting-row-inline">
              <span>分辨率</span>
              ${this.renderCustomSelect({
                key: 'resolution',
                formName: 'reconstructionResolution',
                options: [
                  { value: '2K', label: '2K' },
                  { value: '4K', label: '4K' },
                ],
              })}
            </label>
          </section>

          <div class="settings-actions">
            <button type="button" class="liquid-button settings-secondary" data-settings-reset>清空</button>
            <button type="submit" class="liquid-button settings-primary">完成</button>
          </div>
        </form>
      </aside>
    `;
    return el;
  }

  private mount(): void {
    const app = document.getElementById('app');
    if (app) app.appendChild(this.container);
  }

  private bindEvents(): void {
    this.container.querySelectorAll('[data-settings-close]').forEach((button) => {
      button.addEventListener('click', () => this.close());
    });
    this.selectConfigs.forEach((config) => this.bindCustomSelect(config));
    this.container.querySelector('[data-settings-reset]')?.addEventListener('click', () => {
      this.settings = {
        ...this.settings,
        kieApiKey: '',
        reconstructionModel: 'gpt-image-2',
        reconstructionInputMode: 'single',
        reconstructionResolution: '2K',
      };
      this.syncForm();
      this.emitApply();
    });
    this.form.addEventListener('input', () => this.syncFromForm());
    this.form.addEventListener('change', () => this.syncFromForm());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.syncFromForm();
      this.close();
    });
  }

  private syncFromForm(): void {
    this.settings = this.readForm();
    this.emitApply();
  }

  private emitApply(): void {
    persistSettings(this.settings);
    const next = this.getSettings();
    this.applyCallbacks.forEach((callback) => callback(next));
  }

  private syncForm(): void {
    (this.form.elements.namedItem('kieApiKey') as HTMLInputElement).value = this.settings.kieApiKey;
    (this.form.elements.namedItem('reconstructionModel') as HTMLSelectElement).value = this.settings.reconstructionModel;
    (this.form.elements.namedItem('reconstructionResolution') as HTMLSelectElement).value =
      this.settings.reconstructionResolution;
    this.selectConfigs.forEach((config) => this.syncCustomSelect(config));
  }

  private readForm(): ViewerSettings {
    const model = (this.form.elements.namedItem('reconstructionModel') as HTMLSelectElement).value;
    const resolution = (this.form.elements.namedItem('reconstructionResolution') as HTMLSelectElement).value;
    return {
      ...this.settings,
      reconstructionProvider: 'kie',
      reconstructionModel: normalizeReconstructionModel(model),
      reconstructionInputMode: 'single',
      kieApiKey: (this.form.elements.namedItem('kieApiKey') as HTMLInputElement).value.trim(),
      reconstructionResolution: resolution === '4K' ? '4K' : '2K',
    };
  }

  private createSelectConfigs(): Array<SelectConfig<string>> {
    return [
      {
        key: 'model',
        formName: 'reconstructionModel',
        defaultValue: 'gpt-image-2',
        options: RECONSTRUCTION_MODELS,
        readValue: (settings) => settings.reconstructionModel,
        normalizeValue: normalizeReconstructionModel,
      },
      {
        key: 'resolution',
        formName: 'reconstructionResolution',
        defaultValue: '2K',
        options: [
          { value: '2K', label: '2K' },
          { value: '4K', label: '4K' },
        ],
        readValue: (settings) => settings.reconstructionResolution,
        normalizeValue: (value) => (value === '4K' ? '4K' : '2K'),
      },
    ];
  }

  private renderCustomSelect<T extends string>(config: Pick<SelectConfig<T>, 'key' | 'formName' | 'options'>): string {
    const firstOption = config.options[0];
    return `
      <span class="custom-select" data-select="${config.key}">
        <select name="${config.formName}" class="native-select-hidden" aria-hidden="true" tabindex="-1">
          ${config.options.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}
        </select>
        <button type="button" class="custom-select-button" data-select-toggle="${config.key}" aria-haspopup="listbox" aria-expanded="false">
          <span data-select-value="${config.key}">${firstOption?.label ?? ''}</span>
          ${renderLucideIcon('chevron-down', ChevronDown)}
        </button>
        <span class="custom-select-menu" data-select-menu="${config.key}" role="listbox">
          ${config.options
            .map(
              (option, index) => `
                <button type="button" class="custom-select-option${index === 0 ? ' is-selected' : ''}" data-select-option="${config.key}" data-select-option-value="${option.value}" role="option" aria-selected="${index === 0 ? 'true' : 'false'}">
                  <span>${option.label}</span>
                  ${renderLucideIcon('check', Check)}
                </button>
              `
            )
            .join('')}
        </span>
      </span>
    `;
  }

  private bindCustomSelect(config: SelectConfig<string>): void {
    const root = this.container.querySelector<HTMLElement>(`[data-select="${config.key}"]`);
    const toggle = this.container.querySelector<HTMLButtonElement>(`[data-select-toggle="${config.key}"]`);
    const menu = this.container.querySelector<HTMLElement>(`[data-select-menu="${config.key}"]`);
    const nativeSelect = this.form.elements.namedItem(config.formName) as HTMLSelectElement | null;
    if (!root || !toggle || !menu || !nativeSelect) return;

    // 菜单原始父节点，关闭时移回原位
    const menuParent = menu.parentElement;

    const positionMenu = (): void => {
      if (!menu.classList.contains('is-portal-open')) return;
      const rect = toggle.getBoundingClientRect();
      menu.style.left = `${rect.left}px`;
      menu.style.top = `${rect.bottom + 8}px`;
      menu.style.width = `${rect.width}px`;
    };

    const openMenu = (): void => {
      root.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      // Portal 到 body：脱离 .settings-drawer 的 transform/backdrop-filter 层叠上下文，
      // 让菜单自身的 backdrop-filter 能采样到 drawer 后方的真实页面背景并生效
      document.body.appendChild(menu);
      menu.classList.add('is-portal-open');
      // 强制下一帧再定位，确保 fixed 定位已生效
      requestAnimationFrame(positionMenu);
    };

    const closeMenu = (): void => {
      if (!root.classList.contains('is-open')) return;
      root.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      menu.classList.remove('is-portal-open');
      menu.style.left = '';
      menu.style.top = '';
      menu.style.width = '';
      menuParent?.appendChild(menu);
    };

    toggle.addEventListener('click', () => {
      if (root.classList.contains('is-open')) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    this.container.querySelectorAll<HTMLButtonElement>(`[data-select-option="${config.key}"]`).forEach((option) => {
      option.addEventListener('click', () => {
        const value = config.normalizeValue(option.dataset.selectOptionValue ?? config.defaultValue);
        nativeSelect.value = value;
        closeMenu();
        this.syncFromForm();
        this.syncCustomSelect(config);
      });
    });

    document.addEventListener('pointerdown', (event) => {
      if (!root.classList.contains('is-open')) return;
      if (root.contains(event.target as Node)) return;
      if (menu.contains(event.target as Node)) return;
      closeMenu();
    });

    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
  }

  private syncCustomSelect(config: SelectConfig<string>): void {
    const value = config.readValue(this.settings);
    const label = this.container.querySelector<HTMLElement>(`[data-select-value="${config.key}"]`);
    const nativeSelect = this.form.elements.namedItem(config.formName) as HTMLSelectElement | null;
    if (nativeSelect) nativeSelect.value = value;
    if (label) {
      if (config.key === 'model') {
        label.textContent = getReconstructionModelLabel(value as ReconstructionModel);
      } else {
        label.textContent = config.options.find((option) => option.value === value)?.label ?? value;
      }
    }

    this.container.querySelectorAll<HTMLButtonElement>(`[data-select-option="${config.key}"]`).forEach((option) => {
      const selected = option.dataset.selectOptionValue === value;
      option.classList.toggle('is-selected', selected);
      option.setAttribute('aria-selected', String(selected));
    });
  }
}
