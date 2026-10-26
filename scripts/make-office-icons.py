"""Office 加载项图标：从 assets/icons/*.ico 导出 16/32/80 PNG，并补画三个功能区动作图标。

为什么需要这个脚本：XML 清单的 bt:Image 只接受 PNG，且必须齐 16/32/80 三档；
而仓库里图标只有 .ico。动作图标（复原/预览/保留/快速改写）没有现成素材，
这里用 Pillow 在 8 倍画布上画、再 LANCZOS 缩小 —— 等价于抗锯齿，避免 16px 下发糊。

配色刻意取中间调（橙/蓝/绿/靛），在白底与深色 Ribbon 上都能看清；
Office 不会替加载项图标做明暗适配，纯黑或纯白都会在某一种主题下消失。
"""
from __future__ import annotations

import math
import os
from typing import List, Tuple

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO_DIR = os.path.join(ROOT, "assets", "icons")
OUT_DIR = os.path.join(ROOT, "office", "public", "icons")
SIZES = (16, 32, 80)
SS = 8  # 超采样倍数

ORANGE = (255, 159, 10, 255)
PURPLE = (191, 90, 242, 255)  # 与 cut_office_icons.py 的 #BF5AF2 一致
BLUE = (10, 132, 255, 255)
GREEN = (52, 199, 89, 255)
INDIGO = (94, 92, 230, 255)


def _from_ico(ico_name: str, out_name: str) -> None:
    path = os.path.join(LOGO_DIR, ico_name)
    if not os.path.exists(path):
        print(f"[icons] 跳过：找不到 {ico_name}")
        return
    src = Image.open(path).convert("RGBA")
    for size in SIZES:
        dst_dir = os.path.join(OUT_DIR, str(size))
        os.makedirs(dst_dir, exist_ok=True)
        src.resize((size, size), Image.LANCZOS).save(
            os.path.join(dst_dir, f"{out_name}.png"), "PNG"
        )
    print(f"[icons] {ico_name} → {out_name}.png ({'/'.join(map(str, SIZES))})")


def _canvas(size: int) -> Tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def _save(img: Image.Image, name: str) -> None:
    for size in SIZES:
        dst_dir = os.path.join(OUT_DIR, str(size))
        os.makedirs(dst_dir, exist_ok=True)
        img.resize((size, size), Image.LANCZOS).save(
            os.path.join(dst_dir, f"{name}.png"), "PNG"
        )
    print(f"[icons] 绘制 → {name}.png ({'/'.join(map(str, SIZES))})")


def _hexagon(size: int) -> Image.Image:
    img, d = _canvas(size)
    s = size * SS
    pad = s * 0.16
    cx, cy = s / 2, s / 2
    r = (s / 2) - pad
    pts = [
        (cx + r * math.cos(math.radians(60 * i - 90)),
         cy + r * math.sin(math.radians(60 * i - 90)))
        for i in range(6)
    ]
    d.line(pts + [pts[0]], fill=INDIGO, width=int(s * 0.085), joint="curve")
    return img


def _restore(size: int) -> Image.Image:
    """复原：逆时针回环箭头。

    造型依据 SF Symbols 的 `arrow.counterclockwise`（MCP 描述：粗线弧，
    箭头在左上端朝左，整体略高于宽，bbox 172×208）。这里不描别人的路径，
    而是按同一构造重画：弧形用内/外半径扫掠成实心带，**箭头方向取弧的切线**，
    所以头部永远与线身共线——之前"线条和箭头不对齐"正是手放三角导致的。
    """
    img, d = _canvas(size)
    s = size * SS
    cx, cy = s / 2, s / 2
    r_mid = s * 0.335          # 中线半径：略收，留出箭头宽度
    half = s * 0.052           # 线身半宽（约 2.5px@80）
    head_len = s * 0.145
    head_half = s * 0.105

    head_deg = 112.0           # 箭头所在角度（左上）
    gap_deg = 52.0             # 缺口跨度：从 head 到 head+gap
    start = head_deg + gap_deg
    sweep = 360.0 - gap_deg    # 逆时针扫一整圈回到 head

    def pt(deg: float, r: float) -> Tuple[float, float]:
        rad = math.radians(deg)
        return cx + r * math.cos(rad), cy - r * math.sin(rad)

    # 线身：外弧正向 + 内弧反向，闭合成实心带
    steps = 240
    outer: List[Tuple[float, float]] = []
    inner: List[Tuple[float, float]] = []
    for i in range(steps + 1):
        deg = start + sweep * (i / steps)
        outer.append(pt(deg, r_mid + half))
        inner.append(pt(deg, r_mid - half))
    d.polygon(outer + inner[::-1], fill=PURPLE)

    # 箭头：基点在中线上，方向 = 该点的切线（逆时针 => (-sin, -cos)）
    rad = math.radians(head_deg)
    tip_dir = (-math.sin(rad), -math.cos(rad))   # 屏幕坐标下的切线方向
    base = pt(head_deg, r_mid)
    apex = (base[0] + tip_dir[0] * head_len, base[1] + tip_dir[1] * head_len)
    perp = (-tip_dir[1], tip_dir[0])
    d.polygon(
        [
            (base[0] + perp[0] * head_half, base[1] + perp[1] * head_half),
            (base[0] - perp[0] * head_half, base[1] - perp[1] * head_half),
            apex,
        ],
        fill=PURPLE,
    )
    return img


def _preview(size: int) -> Image.Image:
    """预览原文：眼睛（lens 形轮廓 + 实心瞳）"""
    img, d = _canvas(size)
    s = size * SS
    w = int(s * 0.085)
    lens = (s * 0.08, s * 0.24, s * 0.92, s * 0.76)
    d.arc(lens, start=0, end=180, fill=BLUE, width=w)
    d.arc(lens, start=180, end=360, fill=BLUE, width=w)
    r = s * 0.115
    cx, cy = s / 2, s / 2
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=BLUE)
    return img


def _keep(size: int) -> Image.Image:
    """保留：对勾"""
    img, d = _canvas(size)
    s = size * SS
    w = int(s * 0.11)
    d.line(
        [(s * 0.18, s * 0.53), (s * 0.42, s * 0.76), (s * 0.84, s * 0.26)],
        fill=GREEN,
        width=w,
        joint="curve",
    )
    return img


def _illustration(size: int) -> Image.Image:
    """智能插图：画框 + 山 + 太阳（线描，与其它动作图标同一笔重）"""
    img, d = _canvas(size)
    s = size * SS
    w = int(s * 0.075)
    pad = s * 0.14
    d.rounded_rectangle(
        [pad, pad * 1.2, s - pad, s - pad * 1.2],
        radius=int(s * 0.1),
        outline=INDIGO,
        width=w,
    )
    base = s - pad * 1.2 - w
    d.line(
        [
            (pad + w, base - s * 0.02),
            (s * 0.36, base - s * 0.30),
            (s * 0.52, base - s * 0.10),
            (s * 0.66, base - s * 0.24),
            (s - pad - w, base - s * 0.02),
        ],
        fill=INDIGO,
        width=w,
        joint="curve",
    )
    r = s * 0.075
    cx, cy = s * 0.70, s * 0.34
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=INDIGO, width=w)
    return img


def main() -> None:
    _from_ico("书写辅助.ico", "writing")
    _from_ico("图乐园.ico", "playground")
    _from_ico("intelligentSTUDIO.ico", "studio")
    # quick / illustration 由 scripts/cut_office_icons.py 从用户给的线描稿生成，
    # 这里不再覆盖，否则会把那两张重新画回自绘版。
    # 文件名带语义：undo。改文件名同时会强制 Office 重新拉取（Ribbon 图标按 URL 缓存）
    _save(_restore(80), "undo")
    _save(_preview(80), "preview")
    _save(_keep(80), "keep")
    print(f"[icons] 输出目录：{OUT_DIR}")


if __name__ == "__main__":
    main()
