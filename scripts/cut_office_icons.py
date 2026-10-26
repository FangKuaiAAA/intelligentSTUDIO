"""Cut two glyphs out of screenshots, tint them purple, export 16/32/80 PNG.

两个来源，取蒙版的方式不同：

  · ink   —— 黑线白底（截图）：alpha = 反相后的暗度；
  · alpha —— 自带透明通道（白色笔画）：直接取 alpha，转灰度只会得到一片白。

三个尺寸都从**原图**按 LANCZOS 缩放，不做任何"简化重绘"：
重绘的版本形状与原稿对不上，观感也差。若小尺寸线条偏细，只做一次很轻的
膨胀补偿（dilate 一档），不改变造型。

Usage: python scripts/cut_office_icons.py <illus.png> <edit.png>
"""
from __future__ import annotations

import sys

from PIL import Image, ImageFilter, ImageOps

PURPLE = (191, 90, 242)  # #BF5AF2
ROOT = r"d:\OpenCode\APPXInteligent\office\public\icons"


def _pad(mask: Image.Image) -> Image.Image:
    """裁到笔画边界，套正方画布（留 6% 余量）。保持原始分辨率，不做上采样。"""
    bbox = mask.getbbox()
    if bbox:
        mask = mask.crop(bbox)
    side = max(mask.size)
    pad = int(side * 0.06)
    canvas = Image.new("L", (side + 2 * pad, side + 2 * pad), 0)
    canvas.paste(mask, ((canvas.width - mask.width) // 2, (canvas.height - mask.height) // 2))
    return canvas


def extract_ink(path: str) -> Image.Image:
    gray = Image.open(path).convert("L")
    alpha = ImageOps.invert(gray)
    alpha = alpha.point(lambda v: 0 if v < 30 else (255 if v > 90 else int(v * 255 / 90)))
    return _pad(alpha)


def extract_alpha(path: str) -> Image.Image:
    img = Image.open(path).convert("RGBA")
    alpha = img.split()[3]
    alpha = alpha.point(lambda v: 0 if v < 40 else (255 if v > 150 else int(v * 255 / 150)))
    return _pad(alpha)


def save(mask: Image.Image, name: str) -> None:
    for size in (80, 32, 16):
        work = mask
        # 16px 只有 16 个像素宽，1px 的笔画缩下去会消失：先膨胀一点点，
        # 缩完再收一次阈值，保持与原稿同样的造型，只是线不至于断。
        if size == 16:
            work = mask.filter(ImageFilter.MaxFilter(3))
        small = work.resize((size, size), Image.LANCZOS)
        if size == 16:
            small = small.point(lambda v: 0 if v < 36 else (255 if v > 92 else int(v * 255 / 92)))
        out = Image.new("RGBA", (size, size), PURPLE + (0,))
        out.putalpha(small)
        out.save(f"{ROOT}\\{size}\\{name}.png")
        print(f"[icons] {name}.png {size}px")


def save_mono(mask: Image.Image, name: str, size: int = 64) -> None:
    """窗格输入框左侧的小图标：与功能区同一个字形，但用近黑色。
    功能区图标是紫色的，输入框里跟文字同色才不抢眼。"""
    small = mask.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (29, 29, 31, 0))  # #1d1d1f
    out.putalpha(small)
    ui_dir = f"{ROOT}\\ui"
    import os as _os

    _os.makedirs(ui_dir, exist_ok=True)
    out.save(f"{ui_dir}\\{name}.png")
    print(f"[icons] ui/{name}.png {size}px")


def main() -> None:
    src_illustration, src_edit = sys.argv[1], sys.argv[2]
    edit_mask = extract_alpha(src_edit)
    save(extract_ink(src_illustration), "illus")
    save(edit_mask, "edit")
    save_mono(edit_mask, "edit-dark")


if __name__ == "__main__":
    main()
