// ============================================================
// renderer/ui/liquid-glass.ts
// 保守版玻璃按钮样式注入，不改动现有按钮 DOM
// ============================================================

const STYLE_ID = 'liquid-glass-inline-style';

export class LiquidGlassUI {
  constructor() {
    this.mount();
  }

  private mount(): void {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.liquid-button,
.liquid-cluster,
.liquid-surface {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.03) 48%, rgba(255, 255, 255, 0));
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.32),
    inset 0 -1px 0 rgba(255, 255, 255, 0.08),
    0 8px 24px rgba(10, 16, 24, 0.14);
  -webkit-backdrop-filter: blur(14px) saturate(132%);
  backdrop-filter: blur(14px) saturate(132%);
}

.liquid-button:hover,
.liquid-cluster:hover,
.liquid-surface:hover {
  border-color: rgba(255, 255, 255, 0.28);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.42),
    inset 0 -1px 0 rgba(255, 255, 255, 0.12),
    0 12px 28px rgba(10, 16, 24, 0.18);
}

.liquid-button:active,
.liquid-button.is-active,
.liquid-cluster:active,
.liquid-surface:active {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.26),
    inset 0 -1px 0 rgba(255, 255, 255, 0.06),
    0 8px 18px rgba(10, 16, 24, 0.12);
}

#app[data-phase='idle'] .liquid-button,
#app[data-phase='idle'] .liquid-cluster,
#app[data-phase='idle'] .liquid-surface {
  color: #172033;
  text-shadow: 0 1px 10px rgba(255, 255, 255, 0.24);
}

#app.app-has-content .liquid-button,
#app.app-has-content .liquid-cluster,
#app.app-has-content .liquid-surface {
  color: #f8fbff;
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.32);
}
`;
    document.head.appendChild(style);
  }
}
