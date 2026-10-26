"""准备照片编辑器的本地模型。

用法：
    python scripts/fetch-photo-models.py
    python scripts/fetch-photo-models.py --sharp-dir "D:\\OpenCode\\photo-reframing-1.0.0-win-unpacked\\resources\\models"

行为：
- SAM 分割模型与 Moebius 修补模型从 HuggingFace 下载到 models/photo/。
- SHARP 权重体积超过 2 GB，优先从本地已有的 Photo-Reframing 目录硬链接过来，避免复制。
- 结果写入 models/photo/manifest.json，记录字节数与 sha256，运行期不再联网。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "models" / "photo"

MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"]

# SAM ViT-B：SlimSAM-77 的分割质量不足（常把多个物体连成一片），换成完整 ViT-B 编码器
SAM_FILES = [
    ("/Xenova/sam-vit-base/resolve/main/onnx/vision_encoder.onnx", "sam_encoder.onnx"),
    ("/Xenova/sam-vit-base/resolve/main/onnx/prompt_encoder_mask_decoder.onnx", "sam_decoder.onnx"),
]

LEGACY_SAM_FILES = ["mobile_sam_encoder.onnx", "mobile_sam_decoder.onnx"]

# Moebius：0.2B 的无条件修补模型，消除用它；四个文件合计约 800 MB
MOEBIUS_BASE = "/luweigen/moebius-onnx-android/resolve/main/"
MOEBIUS_FILES = [
    (MOEBIUS_BASE + "unet.fp16x.onnx", "moebius/unet.fp16x.onnx"),
    (MOEBIUS_BASE + "vae_encoder.static.onnx", "moebius/vae_encoder.static.onnx"),
    (MOEBIUS_BASE + "vae_decoder.static.onnx", "moebius/vae_decoder.static.onnx"),
    (MOEBIUS_BASE + "app/assets/context.bin", "moebius/context.bin"),
]

SHARP_FILES = ["sharp_web_predictor.onnx", "sharp_web_predictor.onnx.data"]

SHARP_CANDIDATES = [
    Path(r"D:\OpenCode\photo-reframing-1.0.0-win-unpacked\resources\models"),
    Path(r"D:\OpenCode\Photo-Reframing-main\models"),
    ROOT / "models" / "sharp",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(path: str, target: Path) -> bool:
    """按镜像顺序尝试下载；同一份文件只保留一个来源的副本。"""
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() and target.stat().st_size > 0:
        print(f"  已存在  {target.name}  {target.stat().st_size / 1048576:.1f} MB")
        return True

    for mirror in MIRRORS:
        url = mirror + path
        print(f"  下载    {target.name}")
        print(f"          {url}")

        try:
            with urllib.request.urlopen(url, timeout=60) as response, target.open("wb") as handle:
                total = int(response.headers.get("Content-Length") or 0)
                read = 0
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    handle.write(chunk)
                    read += len(chunk)
                    if total:
                        percent = read * 100 // total
                        sys.stdout.write(f"\r          {percent:3d}%  {read / 1048576:.0f} MB")
                        sys.stdout.flush()
            print()
            if target.stat().st_size > 0:
                return True
        except Exception as exc:
            print(f"\n  失败：{exc}")

        if target.exists():
            target.unlink()

    return False


def link_or_copy(source: Path, target: Path) -> bool:
    if target.exists() and target.stat().st_size > 0:
        print(f"  已存在  {target.name}")
        return True

    print(f"  链接    {target.name}")
    try:
        os.link(source, target)
        return True
    except Exception:
        pass

    try:
        shutil.copy2(source, target)
        return True
    except Exception as exc:
        print(f"  失败：{exc}")
        return False


def setup_sharp(sharp_dir: Path | None) -> bool:
    sources = ([sharp_dir] if sharp_dir else []) + SHARP_CANDIDATES
    for folder in sources:
        if folder is None:
            continue
        candidate = Path(folder)
        if not all((candidate / name).exists() for name in SHARP_FILES):
            continue

        print(f"  SHARP 来源：{candidate}")
        ok = True
        for name in SHARP_FILES:
            ok = link_or_copy(candidate / name, DEST / name) and ok
        return ok

    print("  缺少 SHARP 模型，且未在本机找到可用副本。")
    print("  请下载以下两个文件并放入 models/photo/：")
    print("    https://ml-sharp.quassum.com/sharp_web_predictor.onnx")
    print("    https://ml-sharp.quassum.com/sharp_web_predictor.onnx.data")
    print("  或用 --sharp-dir 指定已有目录。")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="准备照片编辑器模型")
    parser.add_argument("--sharp-dir", type=str, default=None, help="包含 SHARP 权重的目录")
    args = parser.parse_args()

    DEST.mkdir(parents=True, exist_ok=True)
    print(f"模型目录：{DEST}")

    ok = True
    print("\n[SAM 分割模型]")
    for path, name in SAM_FILES:
        ok = download(path, DEST / name) and ok

    # 旧版 SlimSAM 不再使用
    for name in LEGACY_SAM_FILES:
        legacy = DEST / name
        if legacy.exists():
            legacy.unlink()
            print(f"  移除旧模型  {name}")

    print("\n[Moebius 修补模型]")
    for path, name in MOEBIUS_FILES:
        ok = download(path, DEST / name) and ok

    print("\n[SHARP 三维重建模型]")
    ok = setup_sharp(Path(args.sharp_dir) if args.sharp_dir else None) and ok

    manifest = {}
    for path in sorted(DEST.rglob("*")):
        if path.is_file() and path.name != "manifest.json":
            key = str(path.relative_to(DEST)).replace("\\", "/")
            manifest[key] = {"bytes": path.stat().st_size, "sha256": sha256(path)}

    (DEST / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("\n模型清单已写入 manifest.json")
    if not ok:
        print("部分模型尚未就绪，照片编辑器的相应功能会给出提示。")
        return 1

    print("全部就绪。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
