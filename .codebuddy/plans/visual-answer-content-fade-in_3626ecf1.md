---
name: visual-answer-content-fade-in
overview: 把视觉智能回答框内"答案文字 + 卡片"的进入动画从位移飞入改为纯淡入（仅透明度），与回答框本身的淡入保持一致，其余动画与 UI 不动。
todos:
  - id: fade-answer-content
    content: 用 [skill:animate] 将 VisualOverlay.tsx 中答案文字行与两类卡片的进入动画改为纯淡入，保留错峰延迟
    status: completed
  - id: trim-will-change
    content: 收敛 VisualOverlay.css 中 .visual-answer-text 与 .visual-card 的 will-change 为 opacity
    status: completed
    dependencies:
      - fade-answer-content
  - id: verify-build
    content: 运行 npx tsc --noEmit 与 npx vite build，并核对其它动画（光边、选区、胶囊、拖拽缩放）未被改动
    status: completed
    dependencies:
      - fade-answer-content
      - trim-will-change
---

## 产品概述
把视觉智能（Alt+V）的黑色回答框改造成"一团气雾"：中间是极低的黑色半透明、不加任何模糊；四周由内侧向外以黑色做**大半径的模糊渐变**，像雾气一样越往外越淡；圆角明显加大。

## 核心特性
- 中间主体：黑色透明度大幅降低，保持通透，**不使用任何模糊**（不截图、不用 backdrop-filter、不用系统亚克力）。
- 边缘气雾：从框沿向外多层叠加的大半径黑色阴影，越远越淡，且必须在可见范围内自然衰减到几乎为零，避免出现被裁切的硬边。
- 圆角加大：由现在的 8px 提升到明显更大的圆角，整体轮廓更圆润柔化。
- 连带细节同步：滚动区圆角与内边距、卡片宽度、关闭按钮与右下角拖拽弧线的位置、正文可读性。
- 不改动任何其它交互与动画（加载光边、选区扫描、选项胶囊、拖拽缩放、滚动条、卡片进入动画、窗口形态）。

## 技术栈
沿用现有项目：React 18 + TypeScript + Vite（Electron 桌面端），本次只涉及 `VisualOverlay.css` 的样式参数与 `VisualOverlay.tsx` 的一个常量，不引入任何新依赖、不新增 DOM 结构。

## 实现方案

### 1. 主体：极低黑色半透明、无模糊
```css
.visual-answer-box {
  border-radius: 20px;
  background: rgba(8, 8, 12, 0.42);              /* 由 0.9 降到 0.42 */
  border: 1px solid rgba(255, 255, 255, 0.06);   /* 硬边几乎不可见 */
}
```
不使用 `backdrop-filter`（Electron 透明窗口无法模糊窗口外的真实桌面，属于无效开销）。

### 2. 边缘：多层向外的大半径黑色雾化
用 5 层 `box-shadow`（无方向偏移，保证四周均匀成雾），半径由小到大、透明度由高到低，并带少量 spread 让雾更蓬松：
```css
box-shadow:
  0 0 18px 2px rgba(0, 0, 0, 0.30),
  0 0 36px 4px rgba(0, 0, 0, 0.25),
  0 0 56px 6px rgba(0, 0, 0, 0.19),
  0 0 76px 8px rgba(0, 0, 0, 0.12),
  0 0 96px 10px rgba(0, 0, 0, 0.06);
```
最外层在约 96px 处只剩 6%，配合下面的窗口留白（96px）刚好在窗口边界前自然衰减到接近 0，因此不会看到"被窗户边缘切一刀"的硬边。

### 3. 圆角加大与内层跟随
- 主体圆角 8px → **20px**。
- `.visual-answer-scroll` 圆角同步为 20px；左右内边距由 16px 提到 **24px**（大于圆角半径），并把卡片宽度由 `calc(100% - 14px)` 改为 `100%`，避免圆角把卡片四角裁掉。

### 4. 连带细节
- 关闭按钮：圆角变大后不再骑角，改为 `transform: none; top: 12px; right: 12px`，落在圆角内侧。
- 右下角拖拽弧线：`right/bottom` 由 4px 提到 8px，避免与更大的圆角重叠。
- 正文对比度：底色更透后，`.visual-answer-text` 颜色提到接近纯白并加轻微暗色描边阴影，保证在 0.42 黑底上仍清晰；`.visual-card` 为浅灰实底，不受影响。

### 5. 窗口留白同步（关键，防裁切）
`VisualOverlay.tsx` 中 `WINDOW_PAD` 由 72 调到 **96**，与最外层雾半径对应。该常量同时决定 `contentWindowSize()` 的窗口尺寸，因此雾的扩散空间会自动跟随；`WINDOW_PAD` 也是 stage 在窗口内的固定偏移，调大后无需其它坐标改动。副作用说明：窗口四周的留白区会略微变大（该区域现在被雾填充，观感上属于内容的一部分）。

### 性能
只用静态 `box-shadow` 与纯色背景绘制，无动画、无逐帧重绘、无额外图层提升与截屏，开销低于此前的 `backdrop-filter` 方案。

## 目录结构
```
src/components/overlay/
├── VisualOverlay.css   # [MODIFY] 回答框改气雾形态：
│                       #   .visual-answer-box  —— 半径 96px 的五层向外雾化阴影、
│                       #                       底色 rgba(8,8,12,.42)、圆角 20px、极淡边框
│                       #   .visual-answer-scroll —— 圆角 20px、左右内边距 24px
│                       #   .visual-card        —— 宽度改 100%（配合内边距，避免被圆角裁角）
│                       #   .visual-answer-text —— 提高文字对比度（近纯白 + 轻微暗色阴影）
│                       #   .visual-card-close-btn —— 改为内嵌 12px，不再骑角
│                       #   .visual-answer-resize::after —— 右下角内缩 8px，避开更大圆角
└── VisualOverlay.tsx   # [MODIFY] WINDOW_PAD 72 → 96，为向外雾化留足不被窗口裁切的空间
```

## 关键代码结构
仅一个常量改动需要精确：
```ts
// 确认选择后覆盖层会缩小成一个普通窗口，四周留给光边与阴影的空间
// 需覆盖回答框最外层雾化半径（96px），否则雾会被窗口边缘裁出硬边
const WINDOW_PAD = 96
```

## 校验方式
1. `npx tsc --noEmit` 通过；
2. `npx vite build` 通过；
3. 人工确认：回答框呈"气雾"观感（中间清透、四周向外柔和渐隐、无硬边与矩形界限）、圆角更大、卡片四角未被裁、关闭按钮与拖拽弧线位置正常、正文清晰可读；其余动画（加载光边、选区、胶囊、拖拽缩放）与改动前一致。

## Agent Extensions
### Skill
- **emil-design-eng**
  - Purpose: 用其"不可见细节决定质感"的标准来校准气雾的阴影层次、透明度阶梯、圆角与对比度，避免出现硬边、层次断层或可读性不足。
  - Expected outcome: 得到一组合格的多层阴影与圆角参数（衰减连续、最外层在窗口边界前归零、正文对比度达标），并完成一次自检清单核对。
