using System;
using System.Threading.Tasks;
using Windows.Graphics.Imaging;

namespace PhotoEditor.Services;

/// <summary>滤镜参数：全部为界面滑块的原始值域，换算集中在本文件。</summary>
public sealed class FilterSettings
{
    public double Brightness { get; set; }      // -100..100
    public double Contrast { get; set; }        // -100..100
    public double Saturation { get; set; }      // -100..100
    public double Temperature { get; set; }     // -100（冷）..100（暖）
    public double Sharpen { get; set; }         // 0..100
    public double Vignette { get; set; }        // 0..100

    public bool IsNeutral =>
        Brightness == 0 && Contrast == 0 && Saturation == 0
        && Temperature == 0 && Sharpen == 0 && Vignette == 0;

    public FilterSettings Clone() => (FilterSettings)MemberwiseClone();
}

/// <summary>裁剪与几何变换参数。裁剪框使用「旋转后图像」上的归一化坐标。</summary>
public sealed class CropSettings
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Width { get; set; } = 1;
    public double Height { get; set; } = 1;
    public int QuarterTurns { get; set; }
    public double FineAngle { get; set; }       // -15..15 度
    public bool FlipHorizontal { get; set; }
    public double StretchX { get; set; } = 1;   // 0.25..4
    public double StretchY { get; set; } = 1;

    public bool IsNeutral =>
        X == 0 && Y == 0 && Width == 1 && Height == 1 && QuarterTurns == 0
        && FineAngle == 0 && !FlipHorizontal && StretchX == 1 && StretchY == 1;

    public CropSettings Clone() => (CropSettings)MemberwiseClone();
}

/// <summary>
/// CPU 像素管线：几何变换、滤镜、遮罩运算。全部按行并行，不做逐像素的对象分配。
/// 预览与导出共用同一套实现，只有输入分辨率不同。
/// </summary>
public static class ImageProcessor
{
    // ---------- 几何 ----------

    /// <summary>
    /// 旋转（90° 步进 + 微调）、镜像、裁剪与拉伸，一次重采样完成。
    /// 输出尺寸由「旋转后的裁剪区 × 拉伸系数」决定。
    /// </summary>
    public static SoftwareBitmap Transform(SoftwareBitmap source, CropSettings settings)
    {
        var quarter = ((settings.QuarterTurns % 4) + 4) % 4;
        var rotatedWidth = quarter % 2 == 0 ? source.PixelWidth : source.PixelHeight;
        var rotatedHeight = quarter % 2 == 0 ? source.PixelHeight : source.PixelWidth;

        var cropX = Clamp(settings.X, 0, 1);
        var cropY = Clamp(settings.Y, 0, 1);
        var cropW = Clamp(settings.Width, 0.02, 1 - cropX);
        var cropH = Clamp(settings.Height, 0.02, 1 - cropY);

        var outWidth = Math.Max(1, (int)Math.Round(rotatedWidth * cropW * Clamp(settings.StretchX, 0.2, 4)));
        var outHeight = Math.Max(1, (int)Math.Round(rotatedHeight * cropH * Clamp(settings.StretchY, 0.2, 4)));

        var srcPixels = ImageCodec.ReadPixels(source, out var srcStride);

        // 实际可索引的行数与列数以缓冲长度为准，避免 stride 与尺寸不一致时越界
        var srcHeight = Math.Min(source.PixelHeight, srcPixels.Length / Math.Max(1, srcStride));
        var dst = new byte[outWidth * outHeight * 4];

        var cropCenterX = (cropX + cropW / 2.0) * rotatedWidth;
        var cropCenterY = (cropY + cropH / 2.0) * rotatedHeight;
        var cropPixelW = cropW * rotatedWidth;
        var cropPixelH = cropH * rotatedHeight;

        var angle = settings.FineAngle * Math.PI / 180.0;
        var cos = Math.Cos(angle);
        var sin = Math.Sin(angle);

        Parallel.For(0, outHeight, y =>
        {
            var dy = (y + 0.5 - outHeight / 2.0) * cropPixelH / outHeight;
            for (var x = 0; x < outWidth; x++)
            {
                var dx = (x + 0.5 - outWidth / 2.0) * cropPixelW / outWidth;

                // 反向旋转回裁剪空间
                var rx = dx * cos + dy * sin;
                var ry = -dx * sin + dy * cos;

                if (settings.FlipHorizontal) rx = -rx;

                var ax = cropCenterX + rx;
                var ay = cropCenterY + ry;

                MapToSource(ax, ay, quarter, source.PixelWidth, srcHeight,
                    out var sx, out var sy);

                Sample(srcPixels, srcStride, source.PixelWidth, srcHeight,
                    sx, sy, dst, (y * outWidth + x) * 4);
            }
        });

        return ImageCodec.FromBgra(outWidth, outHeight, dst);
    }

    /// <summary>双线性采样：越界坐标钳制到边缘，避免黑边。</summary>
    private static void Sample(byte[] source, int stride, int width, int height,
        double x, double y, byte[] destination, int destinationOffset)
    {
        // ReadPixels 的长度可能被 capacity 截断，最后一次索引必须按实际数组长度收窄，
        // 否则最后一行会越界（Parallel.For 里表现为 AggregateException）。
        if (stride <= 0) return;

        var maxRow = source.Length / stride - 1;
        var maxColumn = stride / 4 - 1;
        if (maxRow < 0 || maxColumn < 0) return;

        height = Math.Min(height, maxRow + 1);
        width = Math.Min(width, maxColumn + 1);

        if (double.IsNaN(x)) x = 0;
        if (double.IsNaN(y)) y = 0;

        if (x < 0) x = 0;
        else if (x > width - 1) x = width - 1;
        if (y < 0) y = 0;
        else if (y > height - 1) y = height - 1;

        var x0 = (int)x;
        var y0 = (int)y;
        var x1 = Math.Min(width - 1, x0 + 1);
        var y1 = Math.Min(height - 1, y0 + 1);
        var fx = (float)(x - x0);
        var fy = (float)(y - y0);

        var i00 = y0 * stride + x0 * 4;
        var i10 = y0 * stride + x1 * 4;
        var i01 = y1 * stride + x0 * 4;
        var i11 = y1 * stride + x1 * 4;

        for (var c = 0; c < 3; c++)
        {
            var top = source[i00 + c] + (source[i10 + c] - source[i00 + c]) * fx;
            var bottom = source[i01 + c] + (source[i11 + c] - source[i01 + c]) * fx;
            destination[destinationOffset + c] = (byte)Math.Clamp(top + (bottom - top) * fy, 0, 255);
        }
        destination[destinationOffset + 3] = 255;
    }

    private static void MapToSource(double x, double y, int quarter, int width, int height,
        out double sx, out double sy)
    {
        switch (quarter)
        {
            case 1: sx = y; sy = height - 1 - x; break;          // 顺时针 90°
            case 2: sx = width - 1 - x; sy = height - 1 - y; break; // 180°
            case 3: sx = width - 1 - y; sy = x; break;           // 顺时针 270°
            default: sx = x; sy = y; break;
        }
    }

    private static double Clamp(double value, double min, double max) =>
        value < min ? min : value > max ? max : value;

    /// <summary>双线性缩放。</summary>
    public static SoftwareBitmap Resize(SoftwareBitmap source, int width, int height)
    {
        if (source.PixelWidth == width && source.PixelHeight == height)
            return SoftwareBitmap.Copy(source);

        var src = ImageCodec.ReadPixels(source, out var stride);
        var dst = new byte[width * height * 4];

        Parallel.For(0, height, y =>
        {
            var sy = (y + 0.5) * source.PixelHeight / height - 0.5;
            for (var x = 0; x < width; x++)
            {
                var sx = (x + 0.5) * source.PixelWidth / width - 0.5;
                Sample(src, stride, source.PixelWidth, source.PixelHeight, sx, sy, dst, (y * width + x) * 4);
            }
        });

        return ImageCodec.FromBgra(width, height, dst);
    }

    public readonly record struct PixelRegion(int X, int Y, int Width, int Height);

    /// <summary>
    /// 按遮罩外接框裁出局部区域，并把待补像素填成中性灰。
    /// 整图重绘会让模型倾向保留原样，只有把区域真正挖空、并只提交这一块，才可能被填补。
    /// </summary>
    public static (SoftwareBitmap Image, byte[] Mask, PixelRegion Region) PrepareLocalInpaint(
        SoftwareBitmap source, byte[] mask, int width, int height, int maxSize = 768, int padding = 48)
    {
        var minX = width;
        var minY = height;
        var maxX = -1;
        var maxY = -1;

        for (var y = 0; y < height; y++)
        {
            var row = y * width;
            for (var x = 0; x < width; x++)
            {
                if (mask[row + x] <= 127) continue;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }

        if (maxX < 0)
        {
            minX = 0;
            minY = 0;
            maxX = Math.Min(width - 1, 255);
            maxY = Math.Min(height - 1, 255);
        }

        minX = Math.Max(0, minX - padding);
        minY = Math.Max(0, minY - padding);
        maxX = Math.Min(width - 1, maxX + padding);
        maxY = Math.Min(height - 1, maxY + padding);

        var regionWidth = maxX - minX + 1;
        var regionHeight = maxY - minY + 1;

        var longest = Math.Max(regionWidth, regionHeight);
        var scale = longest > maxSize ? maxSize / (double)longest : 1.0;
        // 区域过小时按比例放大，避免生成模型看不清内容
        if (longest * scale < 256) scale = 256.0 / longest;

        var targetWidth = Math.Max(8, (int)Math.Round(regionWidth * scale));
        var targetHeight = Math.Max(8, (int)Math.Round(regionHeight * scale));
        targetWidth = Math.Max(64, targetWidth / 64 * 64);
        targetHeight = Math.Max(64, targetHeight / 64 * 64);

        var sourcePixels = ImageCodec.ReadPixels(source, out var sourceStride);
        var localPixels = new byte[targetWidth * targetHeight * 4];
        var localMask = new byte[targetWidth * targetHeight];

        for (var y = 0; y < targetHeight; y++)
        {
            var sourceY = minY + y * regionHeight / targetHeight;
            var sourceRow = sourceY * sourceStride;
            var targetRow = y * targetWidth;

            for (var x = 0; x < targetWidth; x++)
            {
                var sourceX = minX + x * regionWidth / targetWidth;
                var inside = mask[sourceY * width + sourceX] > 127;

                var index = targetRow + x;
                var target = index * 4;
                var pixel = sourceRow + sourceX * 4;

                localMask[index] = inside ? (byte)255 : (byte)0;

                if (inside)
                {
                    // 中性灰：明确表示这里没有内容
                    localPixels[target] = 127;
                    localPixels[target + 1] = 127;
                    localPixels[target + 2] = 127;
                }
                else
                {
                    localPixels[target] = sourcePixels[pixel];
                    localPixels[target + 1] = sourcePixels[pixel + 1];
                    localPixels[target + 2] = sourcePixels[pixel + 2];
                }

                localPixels[target + 3] = 255;
            }
        }

        var image = ImageCodec.FromBgra(targetWidth, targetHeight, localPixels);
        return (image, localMask, new PixelRegion(minX, minY, regionWidth, regionHeight));
    }

    /// <summary>
    /// 把局部生成结果按遮罩贴回原图的对应区域，选区外像素原样保留。
    /// 遮罩尺寸（maskWidth/maskHeight）与原始区域尺寸（region）可能不同，需按比例映射。
    /// </summary>
    public static async Task<SoftwareBitmap> PasteLocalAsync(SoftwareBitmap original, byte[] generatedPng,
        byte[] localMask, int maskWidth, int maskHeight, PixelRegion region)
    {
        using var generated = await ImageCodec.DecodeAsync(generatedPng);
        using var scaled = Resize(generated, region.Width, region.Height);

        var originalPixels = ImageCodec.ReadPixels(original, out var originalStride);
        var generatedPixels = ImageCodec.ReadPixels(scaled, out var generatedStride);

        var outputWidth = original.PixelWidth;
        var outputHeight = original.PixelHeight;
        var output = new byte[outputWidth * outputHeight * 4];

        for (var y = 0; y < outputHeight; y++)
        {
            Buffer.BlockCopy(originalPixels, y * originalStride, output,
                y * outputWidth * 4, outputWidth * 4);
        }

        if (maskWidth <= 0 || maskHeight <= 0) return ImageCodec.FromBgra(outputWidth, outputHeight, output);

        for (var y = 0; y < maskHeight; y++)
        {
            var localY = Math.Min(region.Height - 1, y * region.Height / maskHeight);
            var targetY = region.Y + localY;
            if (targetY < 0 || targetY >= outputHeight) continue;

            var maskRow = y * maskWidth;
            var sourceRow = localY * generatedStride;

            for (var x = 0; x < maskWidth; x++)
            {
                if (localMask[maskRow + x] <= 127) continue;

                var localX = Math.Min(region.Width - 1, x * region.Width / maskWidth);
                var targetX = region.X + localX;
                if (targetX < 0 || targetX >= outputWidth) continue;

                var target = (targetY * outputWidth + targetX) * 4;
                var source = sourceRow + localX * 4;

                output[target] = generatedPixels[source];
                output[target + 1] = generatedPixels[source + 1];
                output[target + 2] = generatedPixels[source + 2];
                output[target + 3] = 255;
            }
        }

        return ImageCodec.FromBgra(outputWidth, outputHeight, output);
    }

    /// <summary>把遮罩区域填成中性灰，用于扩图提交前挖空外围。</summary>
    public static SoftwareBitmap FillMasked(SoftwareBitmap source, byte[] mask, byte value = 127)
    {
        var width = source.PixelWidth;
        var height = source.PixelHeight;
        var pixels = ImageCodec.ReadPixels(source, out var stride);
        var output = new byte[width * height * 4];

        for (var y = 0; y < height; y++)
        {
            var sourceRow = y * stride;
            var targetRow = y * width * 4;

            for (var x = 0; x < width; x++)
            {
                var target = targetRow + x * 4;
                var pixel = sourceRow + x * 4;

                if (mask[y * width + x] > 127)
                {
                    output[target] = value;
                    output[target + 1] = value;
                    output[target + 2] = value;
                }
                else
                {
                    output[target] = pixels[pixel];
                    output[target + 1] = pixels[pixel + 1];
                    output[target + 2] = pixels[pixel + 2];
                }

                output[target + 3] = 255;
            }
        }

        return ImageCodec.FromBgra(width, height, output);
    }

    /// <summary>
    /// 把 repair-mask 截图里的洋红区域转成二值遮罩（255 = 需要重绘）。
    /// 该截图由渲染层把缺失区域涂成 #ff00ff，抗锯齿边缘按宽松阈值处理。
    /// </summary>
    public static byte[] ExtractMagentaMask(SoftwareBitmap bitmap)
    {
        var width = bitmap.PixelWidth;
        var height = bitmap.PixelHeight;
        var pixels = ImageCodec.ReadPixels(bitmap, out var stride);
        var mask = new byte[width * height];

        for (var y = 0; y < height; y++)
        {
            var row = y * stride;
            for (var x = 0; x < width; x++)
            {
                var index = row + x * 4;
                var blue = pixels[index];
                var green = pixels[index + 1];
                var red = pixels[index + 2];
                // 洋红特征：红蓝高、绿低。用均值差判断，能命中与背景混合后的半洋红边缘
                mask[y * width + x] = (red + blue) / 2 - green > 60 && red > 90 && blue > 90
                    ? (byte)255
                    : (byte)0;
            }
        }

        return mask;
    }

    /// <summary>
    /// 外部图像接口的入参尺寸：长边不超过 1536，且宽高必须是 8 的倍数。
    /// SD WebUI 对非 8 倍数直接返回 400，body 过大还会在传输阶段断开。
    /// </summary>
    public static (int Width, int Height) FitForApi(int width, int height, int maxLongEdge = 1024)
    {
        var longest = Math.Max(width, height);
        var scale = longest > maxLongEdge ? maxLongEdge / (double)longest : 1.0;

        var targetWidth = Math.Max(8, (int)Math.Round(width * scale));
        var targetHeight = Math.Max(8, (int)Math.Round(height * scale));

        // 对齐到 64：Flux / Z-Image 一类模型的 VAE 下采样更严格，8 的倍数仍可能触发形状错误
        return (Math.Max(64, targetWidth / 64 * 64), Math.Max(64, targetHeight / 64 * 64));
    }

    /// <summary>遮罩按最近邻缩放，保持二值边界。</summary>
    public static byte[] ResizeMask(byte[] mask, int width, int height, int newWidth, int newHeight)
    {
        if (width == newWidth && height == newHeight) return mask;

        var result = new byte[newWidth * newHeight];
        for (var y = 0; y < newHeight; y++)
        {
            var sourceRow = Math.Min(height - 1, y * height / newHeight) * width;
            var targetRow = y * newWidth;

            for (var x = 0; x < newWidth; x++)
                result[targetRow + x] = mask[sourceRow + Math.Min(width - 1, x * width / newWidth)];
        }

        return result;
    }

    /// <summary>
    /// 遮罩缩小时取块内最大值：只要块内有一个重绘像素，缩放后仍为重绘，
    /// 避免最近邻采样把 1～2px 的细线整段丢掉。
    /// </summary>
    public static byte[] ResizeMaskMax(byte[] mask, int width, int height, int newWidth, int newHeight)
    {
        if (width == newWidth && height == newHeight) return mask;

        var result = new byte[newWidth * newHeight];

        Parallel.For(0, newHeight, y =>
        {
            var sourceY0 = y * height / newHeight;
            var sourceY1 = Math.Max(sourceY0 + 1, (y + 1) * height / newHeight);
            var targetRow = y * newWidth;

            for (var x = 0; x < newWidth; x++)
            {
                var sourceX0 = x * width / newWidth;
                var sourceX1 = Math.Max(sourceX0 + 1, (x + 1) * width / newWidth);

                byte max = 0;
                for (var sy = sourceY0; sy < sourceY1 && sy < height; sy++)
                {
                    var row = sy * width;
                    for (var sx = sourceX0; sx < sourceX1 && sx < width; sx++)
                    {
                        if (mask[row + sx] > max) max = mask[row + sx];
                    }
                }

                result[targetRow + x] = max;
            }
        });

        return result;
    }

    /// <summary>
    /// 遮罩边缘羽化：小半径均值模糊。实心区域周围仍是实心，只有边界变成过渡灰，
    /// 用于让重绘区域与保留区域自然衔接。
    /// </summary>
    public static byte[] FeatherMask(byte[] mask, int width, int height, int radius)
    {
        if (radius <= 0) return mask;

        var horizontal = new byte[mask.Length];
        Parallel.For(0, height, y =>
        {
            var row = y * width;
            for (var x = 0; x < width; x++)
            {
                var sum = 0;
                var count = 0;
                var from = Math.Max(0, x - radius);
                var to = Math.Min(width - 1, x + radius);

                for (var i = from; i <= to; i++)
                {
                    sum += mask[row + i];
                    count++;
                }

                horizontal[row + x] = (byte)(sum / Math.Max(1, count));
            }
        });

        var result = new byte[mask.Length];
        Parallel.For(0, height, y =>
        {
            for (var x = 0; x < width; x++)
            {
                var sum = 0;
                var count = 0;
                var from = Math.Max(0, y - radius);
                var to = Math.Min(height - 1, y + radius);

                for (var i = from; i <= to; i++)
                {
                    sum += horizontal[i * width + x];
                    count++;
                }

                result[y * width + x] = (byte)(sum / Math.Max(1, count));
            }
        });

        return result;
    }

    /// <summary>四边等量扩展。</summary>
    public static (SoftwareBitmap Canvas, byte[] Mask) ComposeOutpaint(
        SoftwareBitmap source, double expand, int maxLongEdge = 1024) =>
        ComposeOutpaint(source, expand, expand, expand, expand, maxLongEdge);

    /// <summary>
    /// 按四边各自的比例扩展画布：原图贴在计算出的偏移位置，四周用低分辨率放大充当模糊延展。
    /// 比例为相对原图的倍率（0.25 = 该边增加 25%）。返回画布与遮罩（外围白 = 需要补全）。
    /// </summary>
    public static (SoftwareBitmap Canvas, byte[] Mask) ComposeOutpaint(
        SoftwareBitmap source, double left, double top, double right, double bottom,
        int maxLongEdge = 1024)
    {
        left = Math.Max(0, left);
        top = Math.Max(0, top);
        right = Math.Max(0, right);
        bottom = Math.Max(0, bottom);

        if (left + top + right + bottom <= 0)
            left = right = top = bottom = 0.01;

        var srcWidth = source.PixelWidth;
        var srcHeight = source.PixelHeight;

        var ratioX = 1 + left + right;
        var ratioY = 1 + top + bottom;

        var canvasWidth = (int)Math.Round(srcWidth * ratioX);
        var canvasHeight = (int)Math.Round(srcHeight * ratioY);

        var longest = Math.Max(canvasWidth, canvasHeight);
        if (longest > maxLongEdge)
        {
            var scale = maxLongEdge / (double)longest;
            canvasWidth = Math.Max(32, (int)Math.Round(canvasWidth * scale));
            canvasHeight = Math.Max(32, (int)Math.Round(canvasHeight * scale));
        }

        // 外部接口要求宽高为 8 的倍数，这里直接对齐，避免下游 400
        canvasWidth = Math.Max(8, canvasWidth / 8 * 8);
        canvasHeight = Math.Max(8, canvasHeight / 8 * 8);

        var innerWidth = Math.Max(8, (int)Math.Round(canvasWidth / ratioX));
        var innerHeight = Math.Max(8, (int)Math.Round(canvasHeight / ratioY));
        using var inner = Resize(source, innerWidth, innerHeight);

        var innerPixels = ImageCodec.ReadPixels(inner, out var innerStride);

        var offsetX = Math.Clamp((int)Math.Round(canvasWidth * left / ratioX), 0, canvasWidth - innerWidth);
        var offsetY = Math.Clamp((int)Math.Round(canvasHeight * top / ratioY), 0, canvasHeight - innerHeight);

        // 扩展区用照片最外侧的一行/列像素向外拉伸（edge replication），
        // 而不是把整张照片缩小再放大，后者会让整幅画面都变模糊。
        var canvasPixels = new byte[canvasWidth * canvasHeight * 4];
        for (var y = 0; y < canvasHeight; y++)
        {
            var sourceY = Math.Clamp(y - offsetY, 0, innerHeight - 1);
            var sourceRow = sourceY * innerStride;
            var targetRow = y * canvasWidth * 4;

            for (var x = 0; x < canvasWidth; x++)
            {
                var sourceX = Math.Clamp(x - offsetX, 0, innerWidth - 1);
                var sourcePixel = sourceRow + sourceX * 4;
                var targetPixel = targetRow + x * 4;

                canvasPixels[targetPixel] = innerPixels[sourcePixel];
                canvasPixels[targetPixel + 1] = innerPixels[sourcePixel + 1];
                canvasPixels[targetPixel + 2] = innerPixels[sourcePixel + 2];
                canvasPixels[targetPixel + 3] = 255;
            }
        }

        var mask = new byte[canvasWidth * canvasHeight];
        // 过渡带按画布长边取比例，避免画布尺寸变化时融合宽度忽大忽小
        var inset = Math.Max(4, (int)Math.Round(Math.Max(canvasWidth, canvasHeight) * 0.008));
        for (var y = 0; y < canvasHeight; y++)
        {
            var insideY = y >= offsetY + inset && y < offsetY + innerHeight - inset;
            for (var x = 0; x < canvasWidth; x++)
            {
                var inside = insideY && x >= offsetX + inset && x < offsetX + innerWidth - inset;
                mask[y * canvasWidth + x] = inside ? (byte)0 : (byte)255;
            }
        }

        // 边缘拉伸后对扩展区做轻度模糊，避免出现硬条纹；照片主体不动
        var softened = BlurRgb(canvasPixels, canvasWidth, canvasHeight, Math.Max(2, canvasWidth / 60));
        for (var index = 0; index < mask.Length; index++)
        {
            if (mask[index] <= 127) continue;

            var pixel = index * 4;
            canvasPixels[pixel] = softened[pixel];
            canvasPixels[pixel + 1] = softened[pixel + 1];
            canvasPixels[pixel + 2] = softened[pixel + 2];
        }

        // 过渡带羽化：重绘区与保留区的接缝更自然
        mask = FeatherMask(mask, canvasWidth, canvasHeight, 4);

        return (ImageCodec.FromBgra(canvasWidth, canvasHeight, canvasPixels), mask);
    }

    /// <summary>可分离平均模糊，只处理 RGB，用于扩展区的柔和过渡。</summary>
    private static byte[] BlurRgb(byte[] pixels, int width, int height, int radius)
    {
        if (radius <= 0) return (byte[])pixels.Clone();

        var horizontal = new byte[pixels.Length];
        for (var y = 0; y < height; y++)
        {
            var row = y * width;
            for (var x = 0; x < width; x++)
            {
                var from = Math.Max(0, x - radius);
                var to = Math.Min(width - 1, x + radius);
                var count = to - from + 1;

                int r = 0, g = 0, b = 0;
                for (var i = from; i <= to; i++)
                {
                    var p = (row + i) * 4;
                    r += pixels[p];
                    g += pixels[p + 1];
                    b += pixels[p + 2];
                }

                var q = (row + x) * 4;
                horizontal[q] = (byte)(r / count);
                horizontal[q + 1] = (byte)(g / count);
                horizontal[q + 2] = (byte)(b / count);
                horizontal[q + 3] = 255;
            }
        }

        var result = new byte[pixels.Length];
        for (var x = 0; x < width; x++)
        {
            for (var y = 0; y < height; y++)
            {
                var from = Math.Max(0, y - radius);
                var to = Math.Min(height - 1, y + radius);
                var count = to - from + 1;

                int r = 0, g = 0, b = 0;
                for (var i = from; i <= to; i++)
                {
                    var p = (i * width + x) * 4;
                    r += horizontal[p];
                    g += horizontal[p + 1];
                    b += horizontal[p + 2];
                }

                var q = (y * width + x) * 4;
                result[q] = (byte)(r / count);
                result[q + 1] = (byte)(g / count);
                result[q + 2] = (byte)(b / count);
                result[q + 3] = 255;
            }
        }

        return result;
    }

    // ---------- 滤镜 ----------

    /// <summary>在既有缓冲上就地应用滤镜，调用方负责写入位图。</summary>
    public static void ApplyFilters(byte[] pixels, int stride, int width, int height, FilterSettings s)
    {
        var brightness = s.Brightness / 100.0 * 0.42;
        var contrast = 1.0 + s.Contrast / 100.0 * 0.65;
        var saturation = 1.0 + s.Saturation / 100.0;
        var warmth = s.Temperature / 100.0;

        // 亮度/对比度/饱和度/色温：线性组合，逐像素完成
        Parallel.For(0, height, y =>
        {
            var offset = y * stride;
            for (var x = 0; x < width; x++)
            {
                var i = offset + x * 4;
                double b = pixels[i];
                double g = pixels[i + 1];
                double r = pixels[i + 2];

                // 色温：暖调抬红压蓝，冷调反之
                r += warmth * 26;
                b -= warmth * 26;

                // 亮度
                r += brightness * 255;
                g += brightness * 255;
                b += brightness * 255;

                // 对比度（围绕中灰）
                r = (r - 128) * contrast + 128;
                g = (g - 128) * contrast + 128;
                b = (b - 128) * contrast + 128;

                // 饱和度
                var luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                r = luma + (r - luma) * saturation;
                g = luma + (g - luma) * saturation;
                b = luma + (b - luma) * saturation;

                pixels[i] = ToByte(b);
                pixels[i + 1] = ToByte(g);
                pixels[i + 2] = ToByte(r);
                pixels[i + 3] = 255;
            }
        });

        if (s.Sharpen > 0.5)
            Sharpen(pixels, stride, width, height, s.Sharpen / 100.0);

        if (s.Vignette > 0.5)
            Vignette(pixels, stride, width, height, s.Vignette / 100.0);
    }

    /// <summary>3×3 反锐化掩模：只在中间亮度区生效，避免暗部噪点被放大。</summary>
    private static void Sharpen(byte[] pixels, int stride, int width, int height, double amount)
    {
        var copy = (byte[])pixels.Clone();
        var strength = 1.6 * amount;

        Parallel.For(1, height - 1, y =>
        {
            for (var x = 1; x < width - 1; x++)
            {
                var i = y * stride + x * 4;
                for (var c = 0; c < 3; c++)
                {
                    var center = copy[i + c];
                    var neighbors = copy[i - 4 + c] + copy[i + 4 + c]
                                    + copy[i - stride + c] + copy[i + stride + c];
                    var detail = center * 4 - neighbors;
                    var value = center + detail * strength * 0.25;
                    pixels[i + c] = ToByte(center + (value - center));
                }
            }
        });
    }

    private static void Vignette(byte[] pixels, int stride, int width, int height, double amount)
    {
        var cx = width / 2.0;
        var cy = height / 2.0;
        var maxDistance = Math.Sqrt(cx * cx + cy * cy);
        var inner = 0.55;

        Parallel.For(0, height, y =>
        {
            var dy = (y - cy) / maxDistance;
            for (var x = 0; x < width; x++)
            {
                var dx = (x - cx) / maxDistance;
                var d = Math.Sqrt(dx * dx + dy * dy);
                if (d <= inner) continue;

                var t = Math.Min(1, (d - inner) / (1 - inner));
                var factor = 1 - amount * 0.85 * t * t;
                var i = y * stride + x * 4;
                pixels[i] = ToByte(pixels[i] * factor);
                pixels[i + 1] = ToByte(pixels[i + 1] * factor);
                pixels[i + 2] = ToByte(pixels[i + 2] * factor);
            }
        });
    }

    private static byte ToByte(double value) =>
        value <= 0 ? (byte)0 : value >= 255 ? (byte)255 : (byte)(value + 0.5);

    // ---------- 遮罩 ----------

    /// <summary>8 位单通道遮罩的方形膨胀，用两遍行列滑动实现，半径可到数十像素。</summary>
    public static byte[] DilateMask(byte[] mask, int width, int height, int radius)
    {
        if (radius <= 0) return mask;

        var horizontal = new byte[mask.Length];
        Parallel.For(0, height, y =>
        {
            var row = y * width;
            for (var x = 0; x < width; x++)
            {
                byte max = 0;
                var from = Math.Max(0, x - radius);
                var to = Math.Min(width - 1, x + radius);
                for (var i = from; i <= to; i++)
                {
                    if (mask[row + i] > max) max = mask[row + i];
                }
                horizontal[row + x] = max;
            }
        });

        var result = new byte[mask.Length];
        Parallel.For(0, width, x =>
        {
            for (var y = 0; y < height; y++)
            {
                byte max = 0;
                var from = Math.Max(0, y - radius);
                var to = Math.Min(height - 1, y + radius);
                for (var i = from; i <= to; i++)
                {
                    if (horizontal[i * width + x] > max) max = horizontal[i * width + x];
                }
                result[y * width + x] = max;
            }
        });

        return result;
    }

    /// <summary>提取遮罩轮廓带（膨胀环 − 原遮罩），用于元素轮廓的高光流动叠加。</summary>
    public static byte[] MaskOutline(byte[] mask, int width, int height, int thickness)
    {
        var grown = DilateMask(mask, width, height, Math.Max(1, thickness));
        var outline = new byte[mask.Length];
        for (var i = 0; i < mask.Length; i++)
            outline[i] = grown[i] > 127 && mask[i] <= 127 ? (byte)255 : (byte)0;
        return outline;
    }

    /// <summary>把 8 位遮罩铺成带 alpha 的 RGBA，供 Image 控件叠加显示。</summary>
    public static byte[] MaskToRgba(byte[] mask, int width, int height, byte r, byte g, byte b, byte alpha)
    {
        var rgba = new byte[width * height * 4];
        Parallel.For(0, height, y =>
        {
            for (var x = 0; x < width; x++)
            {
                var m = mask[y * width + x];
                var i = (y * width + x) * 4;
                rgba[i] = b;
                rgba[i + 1] = g;
                rgba[i + 2] = r;
                rgba[i + 3] = (byte)(m * alpha / 255);
            }
        });
        return rgba;
    }
}
