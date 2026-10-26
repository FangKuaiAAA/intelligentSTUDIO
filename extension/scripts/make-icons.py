"""从 Logo 文件夹的「视觉智能.ico」生成扩展图标。

用法：python extension/scripts/make-icons.py [--source <ico 路径>]
产出：extension/public/icons/icon{16,32,48,128}.png

为什么要转：Edge 的清单只接受 PNG（.ico 不认），而 Logo 只提供了 .ico，
所以这里把 ico 里的 1024px 母版按目标尺寸逐级减半重采样，避免一步缩到 16px 时糊边。
"""
import argparse
import os
import sys

DEFAULT_SOURCE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "assets", "icons", "视觉智能.ico"
)
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "icons")
SIZES = (16, 32, 48, 128)


def load_source(path: str):
    try:
        from PIL import Image
    except ImportError:
        sys.exit("缺少 Pillow：先执行 pip install pillow")
    if not os.path.exists(path):
        sys.exit(f"找不到图标母版：{path}")
    # ico 里有多层时 Pillow 默认取最大的一层，正好当母版
    return Image.open(path).convert("RGBA")


def downscale(img, size: int):
    """逐级减半再收到目标尺寸：大比例缩放时比一步 LANCZOS 更锐利。"""
    from PIL import Image

    cur = img
    while cur.width // 2 >= size * 2:
        cur = cur.resize((cur.width // 2, cur.height // 2), Image.LANCZOS)
    return cur.resize((size, size), Image.LANCZOS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="ico 母版路径")
    args = parser.parse_args()

    src = load_source(args.source)
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        out = os.path.join(OUT_DIR, f"icon{size}.png")
        downscale(src, size).save(out, "PNG", optimize=True)
        print(f"已生成 {out}（{os.path.getsize(out)} 字节）")


if __name__ == "__main__":
    main()
