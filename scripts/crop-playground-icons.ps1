# 从 5 张参考截图中裁出「图乐园」的 56 个圆形元素图标。
# 纯 ASCII 源码：中文名称由 UTF-8 文本 playground-app/design/element-names.txt 提供，
# 避免 Windows PowerShell 5.1 按 ANSI 读取 .ps1 时破坏中文。
param(
    [string]$SourceDir = "D:\fangjiahe\Desktop",
    [string]$Root
)

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }

$designDir = Join-Path $Root "playground-app\design"
$outDir = Join-Path $Root "playground-app\Assets\Elements"
$namesFile = Join-Path $designDir "element-names.txt"

if (-not (Test-Path $namesFile)) { throw "names file missing: $namesFile" }
New-Item -ItemType Directory -Force -Path $designDir | Out-Null
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 源截图按页码顺序发现（文件名含时间戳，按修改时间排序与页码一致）
$sources = Get-ChildItem -LiteralPath $SourceDir -Filter "*.png" |
    Where-Object { $_.Name -like "*23.06.38*" -or $_.Name -like "*23.06.43*" -or
                   $_.Name -like "*23.06.48*" -or $_.Name -like "*23.06.52*" -or
                   $_.Name -like "*23.07.01*" }
if ($sources.Count -ne 5) { throw "expected 5 screenshots, found $($sources.Count)" }

# 按内容识别页码：含「太空」的那张为第 1 页，其余按时间戳顺序对应 2..5 页由名称表决定，
# 因此这里改用固定映射（时间戳 -> 页码），确保顺序与视觉一致。
$map = @{
    "23.07.01" = 1
    "23.06.38" = 2
    "23.06.43" = 3
    "23.06.48" = 4
    "23.06.52" = 5
}
$pageFiles = @{}
foreach ($f in $sources) {
    foreach ($key in $map.Keys) {
        if ($f.Name -like "*$key*") { $pageFiles[$map[$key]] = $f.FullName }
    }
}
for ($p = 1; $p -le 5; $p++) {
    if (-not $pageFiles.ContainsKey($p)) { throw "page $p screenshot missing" }
    Copy-Item -LiteralPath $pageFiles[$p] -Destination (Join-Path $designDir "page$p.png") -Force
}

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public static class PlaygroundIconCropper
{
    private const int Tile = 128;        // 输出边长
    private const int Super = 4;         // 超采样倍数（圆形边缘抗锯齿）
    private const int LumThreshold = 22; // 黑底阈值

    public static string Run(string[] pagePaths, string[] lines, string outDir, string designDir)
    {
        Directory.CreateDirectory(outDir);
        Directory.CreateDirectory(designDir);

        // 读取名称表：page|seq|name|promptName
        var table = new Dictionary<int, List<string[]>>();
        foreach (var raw in lines)
        {
            if (string.IsNullOrWhiteSpace(raw) || raw.StartsWith("#")) continue;
            var parts = raw.Split('|');
            if (parts.Length < 4) continue;
            int page = int.Parse(parts[0].Substring(1));
            if (!table.ContainsKey(page)) table[page] = new List<string[]>();
            table[page].Add(parts);
        }

        var manifest = new StringBuilder();
        manifest.Append("{\n  \"version\": 1,\n  \"pages\": [\n");

        var tiles = new List<string>();

        for (int page = 1; page <= pagePaths.Length; page++)
        {
            using (var bmp = new Bitmap(pagePaths[page - 1]))
            {
                var mask = BuildMask(bmp);
                // 列：只保留宽度 >= 40 的竖带（排除翻页箭头等细长干扰）
                var cols = Runs(ProjectX(mask, bmp.Width, bmp.Height), 30, 40)
                    .Where(r => r[1] - r[0] >= 40).ToList();
                // 行：整幅水平投影，两行图标带（标签高度不足 40 自动排除）
                var rows = Runs(ProjectY(mask, bmp.Width, bmp.Height, 0, bmp.Width - 1), 40, 40);
                var boxes = new List<int[]>();
                foreach (var row in rows)
                {
                    foreach (var col in cols)
                    {
                        var b = BBox(mask, bmp.Width, bmp.Height, col[0], col[1], row[0], row[1]);
                        if (b[0] < 0) continue;                       // 该位置无图标
                        if (b[2] - b[0] < 40 || b[3] - b[1] < 40) continue; // 噪声
                        boxes.Add(b);
                    }
                }

                var pageItems = table.ContainsKey(page) ? table[page] : new List<string[]>();
                if (boxes.Count != pageItems.Count)
                    throw new Exception("page " + page + ": detected " + boxes.Count + " icons but names=" + pageItems.Count);

                Console.WriteLine("page " + page + " -> " + boxes.Count + " icons, columns="
                    + cols.Count + ", rows=" + rows.Count);

                for (int i = 0; i < boxes.Count; i++)
                {
                    var b = boxes[i];
                    int bw = b[2] - b[0] + 1;
                    int bh = b[3] - b[1] + 1;
                    int side = Math.Max(bw, bh) + 4;
                    int cx = (b[0] + b[2]) / 2;
                    int cy = (b[1] + b[3]) / 2;
                    int left = cx - side / 2;
                    int top = cy - side / 2;
                    if (left < 0) left = 0;
                    if (top < 0) top = 0;
                    if (left + side > bmp.Width) left = bmp.Width - side;
                    if (top + side > bmp.Height) top = bmp.Height - side;

                    var info = pageItems[i];
                    string id = info[0] + "_" + info[1];
                    string name = info[2];
                    string prompt = info[3];
                    string file = id + ".png";

                    using (var srcRect = new Bitmap(side, side, PixelFormat.Format32bppArgb))
                    {
                        using (var gs = Graphics.FromImage(srcRect))
                        {
                            gs.DrawImage(bmp, new Rectangle(0, 0, side, side),
                                new Rectangle(left, top, side, side), GraphicsUnit.Pixel);
                        }

                        using (var big = new Bitmap(side * Super, side * Super, PixelFormat.Format32bppArgb))
                        {
                            using (var gb = Graphics.FromImage(big))
                            {
                                gb.Clear(Color.Transparent);
                                gb.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                gb.PixelOffsetMode = PixelOffsetMode.HighQuality;
                                using (var path = new GraphicsPath())
                                {
                                    path.AddEllipse(0, 0, big.Width - 1, big.Height - 1);
                                    gb.SetClip(path);
                                    gb.DrawImage(srcRect, new Rectangle(0, 0, big.Width, big.Height));
                                }
                            }
                            using (var outBmp = new Bitmap(Tile, Tile, PixelFormat.Format32bppArgb))
                            {
                                using (var go = Graphics.FromImage(outBmp))
                                {
                                    go.Clear(Color.Transparent);
                                    go.CompositingQuality = CompositingQuality.HighQuality;
                                    go.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                    go.PixelOffsetMode = PixelOffsetMode.HighQuality;
                                    go.DrawImage(big, new Rectangle(0, 0, Tile, Tile));
                                }
                                outBmp.Save(Path.Combine(outDir, file), ImageFormat.Png);
                            }
                        }
                    }

                    tiles.Add(Path.Combine(outDir, file));

                    Console.WriteLine("  " + id + " " + name + " @ " + left + "," + top + " side=" + side);
                }
            }
        }

        // 规范 JSON（名称表本身即为最终顺序，直接据此生成）
        manifest = new StringBuilder();
        manifest.Append("{\n  \"version\": 1,\n  \"pages\": [\n");
        for (int page = 1; page <= pagePaths.Length; page++)
        {
            var pageItems = table.ContainsKey(page) ? table[page] : new List<string[]>();
            string title = page == 1 ? "\u573a\u666f" : page == 2 ? "\u4e3b\u9898"
                        : page == 3 ? "\u8868\u60c5" : page == 4 ? "\u89d2\u8272" : "\u914d\u9970";
            manifest.Append("    {\n      \"page\": " + page + ", \"title\": \"" + title + "\", \"items\": [\n");
            for (int i = 0; i < pageItems.Count; i++)
            {
                var info = pageItems[i];
                manifest.Append("        { \"id\": \"" + info[0] + "_" + info[1] + "\", \"name\": \""
                    + info[2] + "\", \"prompt\": \"" + info[3] + "\", \"file\": \""
                    + info[0] + "_" + info[1] + ".png\" }");
                manifest.Append(i == pageItems.Count - 1 ? "\n" : ",\n");
            }
            manifest.Append("      ]\n    }");
            manifest.Append(page == pagePaths.Length ? "\n" : ",\n");
        }
        manifest.Append("  ]\n}\n");

        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToString(), new UTF8Encoding(false));

        // 拼版校验图
        MakeContactSheet(tiles, Path.Combine(designDir, "contact-sheet.png"));
        return outDir;
    }

    private static void MakeContactSheet(List<string> tiles, string path)
    {
        const int cols = 8;
        int rows = (tiles.Count + cols - 1) / cols;
        const int gap = 10;
        int w = cols * Tile + (cols + 1) * gap;
        int h = rows * Tile + (rows + 1) * gap;
        using (var sheet = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(sheet))
        {
            g.Clear(Color.FromArgb(255, 12, 12, 16));
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            for (int i = 0; i < tiles.Count; i++)
            {
                int cx = gap + (i % cols) * (Tile + gap);
                int cy = gap + (i / cols) * (Tile + gap);
                using (var img = new Bitmap(tiles[i]))
                    g.DrawImage(img, new Rectangle(cx, cy, Tile, Tile));
            }
            sheet.Save(path, ImageFormat.Png);
        }
    }

    private static bool[,] BuildMask(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        var mask = new bool[w, h];
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var bytes = new byte[data.Stride * h];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            for (int y = 0; y < h; y++)
            {
                int row = y * data.Stride;
                for (int x = 0; x < w; x++)
                {
                    int i = row + x * 4;
                    int lum = (bytes[i + 2] * 299 + bytes[i + 1] * 587 + bytes[i] * 114) / 1000;
                    mask[x, y] = lum > LumThreshold;
                }
            }
        }
        finally { bmp.UnlockBits(data); }
        return mask;
    }

    private static int[] ProjectX(bool[,] mask, int w, int h)
    {
        var counts = new int[w];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                if (mask[x, y]) counts[x]++;
        return counts;
    }

    private static int[] ProjectY(bool[,] mask, int w, int h, int x0, int x1)
    {
        var counts = new int[h];
        for (int y = 0; y < h; y++)
            for (int x = x0; x <= x1; x++)
                if (mask[x, y]) counts[y]++;
        return counts;
    }

    private static List<int[]> Runs(int[] counts, int minCount, int minLen)
    {
        var list = new List<int[]>();
        int start = -1;
        for (int i = 0; i < counts.Length; i++)
        {
            bool on = counts[i] >= minCount;
            if (on && start < 0) start = i;
            else if (!on && start >= 0)
            {
                if (i - start >= minLen) list.Add(new[] { start, i - 1 });
                start = -1;
            }
        }
        if (start >= 0 && counts.Length - start >= minLen) list.Add(new[] { start, counts.Length - 1 });
        return list;
    }

    private static int[] BBox(bool[,] mask, int w, int h, int x0, int x1, int y0, int y1)
    {
        int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
        for (int y = y0; y <= y1; y++)
            for (int x = x0; x <= x1; x++)
                if (mask[x, y])
                {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
        if (maxX < 0) return new[] { -1, -1, -1, -1 };
        return new[] { minX, minY, maxX, maxY };
    }
}
"@

$lines = [System.IO.File]::ReadAllLines($namesFile, [System.Text.Encoding]::UTF8)
$pagePaths = @($pageFiles[1], $pageFiles[2], $pageFiles[3], $pageFiles[4], $pageFiles[5])
$result = [PlaygroundIconCropper]::Run($pagePaths, $lines, $outDir, $designDir)
Write-Host "icons written to: $result"
