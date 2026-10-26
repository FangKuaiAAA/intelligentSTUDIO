using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;

namespace PhotoEditor.Services;

/// <summary>
/// WIC 编解码：文件 → Bgra8 SoftwareBitmap，SoftwareBitmap → 显示源 / PNG 字节 / 磁盘文件。
/// 编辑器内部统一使用预乘 Bgra8，便于直接做像素运算，也满足 SoftwareBitmapSource 的前置条件。
/// </summary>
public static class ImageCodec
{
    /// <summary>解码任意受支持格式（JPG/PNG/BMP/TIFF/HEIF 需系统扩展）。</summary>
    public static async Task<SoftwareBitmap> DecodeAsync(string path)
    {
        using var stream = await FileRandomAccessStream.OpenAsync(path, FileAccessMode.Read);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        var bitmap = await decoder.GetSoftwareBitmapAsync(
            BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);

        // 统一成无 alpha 的 Bgra8：照片不需要透明通道，避免预乘在滤镜链路里引入误差
        return bitmap;
    }

    public static async Task<SoftwareBitmap> DecodeAsync(byte[] bytes)
    {
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream.GetOutputStreamAt(0)))
        {
            writer.WriteBytes(bytes);
            await writer.StoreAsync();
            await writer.FlushAsync();
        }
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        return await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
    }

    /// <summary>编码为 PNG 字节，供本地推理服务与补全接口传输。</summary>
    public static async Task<byte[]> EncodePngAsync(SoftwareBitmap bitmap)
    {
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();

        var bytes = new byte[stream.Size];
        stream.Seek(0);
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync((uint)stream.Size);
        reader.ReadBytes(bytes);
        return bytes;
    }

    /// <summary>
    /// JPEG 编码。外部接口的 body 过大时会在读取阶段直接返回 400（服务端队列里看不到任务），
    /// 有损压缩能把几 MB 的 PNG 降到几百 KB。
    /// </summary>
    public static async Task<byte[]> EncodeJpegAsync(SoftwareBitmap bitmap, float quality = 0.9f)
    {
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream);

        var options = new BitmapPropertySet
        {
            ["ImageQuality"] = new BitmapTypedValue(quality, Windows.Foundation.PropertyType.Single),
        };
        await encoder.BitmapProperties.SetPropertiesAsync(options);

        using var flattened = SoftwareBitmap.Convert(bitmap, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);
        encoder.SetSoftwareBitmap(flattened);
        await encoder.FlushAsync();

        var bytes = new byte[stream.Size];
        stream.Seek(0);
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync((uint)stream.Size);
        reader.ReadBytes(bytes);
        return bytes;
    }

    /// <summary>把 PNG 重编码成 JPEG，用于减小接口请求体。</summary>
    public static async Task<byte[]> ReencodeAsJpegAsync(byte[] png, float quality = 0.9f)
    {
        using var bitmap = await DecodeAsync(png);
        return await EncodeJpegAsync(bitmap, quality);
    }

    public static async Task WriteAsync(SoftwareBitmap bitmap, StorageFile file)
    {
        using var stream = await file.OpenAsync(FileAccessMode.ReadWrite);
        stream.Size = 0;

        var isJpeg = file.FileType is ".jpg" or ".jpeg";
        var encoder = isJpeg
            ? await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream)
            : await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);

        if (isJpeg)
        {
            var options = new BitmapPropertySet
            {
                ["ImageQuality"] = new BitmapTypedValue(0.94f, Windows.Foundation.PropertyType.Single),
            };
            await encoder.BitmapProperties.SetPropertiesAsync(options);
        }

        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();
    }

    /// <summary>生成用于 Image 控件显示的源。每次调用都产生新实例，避免复用已释放的位图。</summary>
    public static async Task<SoftwareBitmapSource> ToSourceAsync(SoftwareBitmap bitmap)
    {
        var copy = SoftwareBitmap.Copy(bitmap);
        var source = new SoftwareBitmapSource();
        await source.SetBitmapAsync(copy);
        copy.Dispose();
        return source;
    }

    /// <summary>缩放到指定长边，用于预览与遮罩计算。</summary>
    public static async Task<SoftwareBitmap> ResizeToLongEdgeAsync(SoftwareBitmap source, int longEdge)
    {
        var scale = longEdge / (double)Math.Max(source.PixelWidth, source.PixelHeight);
        if (scale >= 1) return SoftwareBitmap.Copy(source);

        var width = Math.Max(1, (int)Math.Round(source.PixelWidth * scale));
        var height = Math.Max(1, (int)Math.Round(source.PixelHeight * scale));

        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetSoftwareBitmap(source);
        encoder.BitmapTransform.ScaledWidth = (uint)width;
        encoder.BitmapTransform.ScaledHeight = (uint)height;
        encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
        await encoder.FlushAsync();

        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        return await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetBufferHandler(IntPtr thisPtr, out IntPtr buffer, out uint capacity);

    private static readonly Guid ByteAccessIid = new("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D");

    /// <summary>
    /// 取得像素缓冲指针。CsWinRT 会拦截所有到 WinRT 对象的强制转换，
    /// 这里直接 QI 出 IMemoryBufferByteAccess，再按虚表调用 GetBuffer。
    /// </summary>
    private static IntPtr GetBufferPointer(object reference, out uint capacity)
    {
        var abi = ((WinRT.IWinRTObject)reference).NativeObject.ThisPtr;

        var iid = ByteAccessIid;
        var result = Marshal.QueryInterface(abi, ref iid, out var byteAccess);
        if (result != 0) throw new InvalidOperationException("无法访问像素缓冲。");

        try
        {
            var vtable = Marshal.ReadIntPtr(byteAccess);
            var slot = Marshal.ReadIntPtr(vtable, 3 * IntPtr.Size);
            var handler = Marshal.GetDelegateForFunctionPointer<GetBufferHandler>(slot);

            var status = handler(byteAccess, out var pointer, out capacity);
            if (status != 0) throw new InvalidOperationException("读取像素缓冲失败。");
            return pointer;
        }
        finally
        {
            Marshal.Release(byteAccess);
        }
    }

    /// <summary>锁定像素缓冲，交给处理函数直接读写；处理结束自动释放。</summary>
    public static void WithPixels(SoftwareBitmap bitmap, Action<byte[], int, int> action)
    {
        using var buffer = bitmap.LockBuffer(BitmapBufferAccessMode.ReadWrite);
        using var reference = buffer.CreateReference();

        var data = GetBufferPointer(reference, out var capacity);

        var plane = buffer.GetPlaneDescription(0);
        var stride = plane.Stride;
        var bytes = stride * bitmap.PixelHeight;
        if (bytes > capacity) bytes = (int)capacity;

        var array = new byte[bytes];
        Marshal.Copy(data, array, 0, bytes);
        action(array, stride, bitmap.PixelHeight);
        Marshal.Copy(array, 0, data, bytes);
    }

    /// <summary>以字节形式读取像素（不写回），用于遮罩生成等只读场景。</summary>
    public static byte[] ReadPixels(SoftwareBitmap bitmap, out int stride)
    {
        using var buffer = bitmap.LockBuffer(BitmapBufferAccessMode.Read);
        using var reference = buffer.CreateReference();

        var data = GetBufferPointer(reference, out var capacity);

        var plane = buffer.GetPlaneDescription(0);
        stride = plane.Stride;
        var bytes = stride * bitmap.PixelHeight;
        if (bytes > capacity) bytes = (int)capacity;

        var array = new byte[bytes];
        Marshal.Copy(data, array, 0, bytes);
        return array;
    }

    /// <summary>缩放到精确尺寸：云端返回的图可能与输入尺寸不同，回填前统一。</summary>
    public static async Task<SoftwareBitmap> ResizeAsync(SoftwareBitmap source, int width, int height)
    {
        if (source.PixelWidth == width && source.PixelHeight == height)
            return SoftwareBitmap.Copy(source);

        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetSoftwareBitmap(source);
        encoder.BitmapTransform.ScaledWidth = (uint)Math.Max(1, width);
        encoder.BitmapTransform.ScaledHeight = (uint)Math.Max(1, height);
        encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
        await encoder.FlushAsync();

        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        return await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
    }

    /// <summary>8 位单通道遮罩编码为黑白 PNG，供推理与补全接口使用。</summary>
    public static async Task<byte[]> EncodeMaskPngAsync(byte[] mask, int width, int height)
    {
        var rgba = new byte[width * height * 4];
        for (var i = 0; i < mask.Length && i * 4 + 3 < rgba.Length; i++)
        {
            var value = mask[i];
            var j = i * 4;
            rgba[j] = value;
            rgba[j + 1] = value;
            rgba[j + 2] = value;
            rgba[j + 3] = 255;
        }

        using var bitmap = FromBgra(width, height, rgba);
        return await EncodePngAsync(bitmap);
    }

    /// <summary>
    /// 编码 images/edits 语义的遮罩：透明区域表示需要重绘，其余区域保持原样。
    /// 与推理用的黑白遮罩相反，不能直接复用。
    /// </summary>
    public static async Task<byte[]> EncodeEditMaskPngAsync(byte[] mask, int width, int height)
    {
        var rgba = new byte[width * height * 4];
        for (var i = 0; i < mask.Length && i * 4 + 3 < rgba.Length; i++)
        {
            var j = i * 4;
            rgba[j] = 255;
            rgba[j + 1] = 255;
            rgba[j + 2] = 255;
            rgba[j + 3] = mask[i] > 127 ? (byte)0 : (byte)255;
        }

        using var bitmap = FromBgra(width, height, rgba);
        return await EncodePngAsync(bitmap);
    }

    /// <summary>
    /// 用遮罩把生成结果贴回原图：遮罩白色处取生成结果，其余保留原像素。
    /// 该图像服务不支持 mask 参数，只能整图重绘后按选区回贴。
    /// </summary>
    public static async Task<byte[]> CompositeWithMaskAsync(byte[] originalPng, byte[] generatedPng,
        byte[] maskPng, int width, int height, int feather = 3)
    {
        using var original = await DecodeAsync(originalPng);
        using var produced = await DecodeAsync(generatedPng);
        using var normalized = await ResizeAsync(produced, width, height);

        var mask = await DecodeMaskAsync(maskPng, width, height);
        var originalPixels = ReadPixels(original, out var originalStride);
        var producedPixels = ReadPixels(normalized, out var producedStride);

        var weights = SoftenMask(mask, width, height, feather);
        var result = new byte[width * height * 4];

        for (var y = 0; y < height; y++)
        {
            var originalRow = y * originalStride;
            var producedRow = y * producedStride;
            var targetRow = y * width * 4;

            for (var x = 0; x < width; x++)
            {
                var weight = weights[y * width + x] / 255f;
                var index = targetRow + x * 4;

                if (weight <= 0.001f)
                {
                    result[index] = originalPixels[originalRow + x * 4];
                    result[index + 1] = originalPixels[originalRow + x * 4 + 1];
                    result[index + 2] = originalPixels[originalRow + x * 4 + 2];
                    result[index + 3] = 255;
                    continue;
                }

                for (var channel = 0; channel < 3; channel++)
                {
                    var before = originalPixels[originalRow + x * 4 + channel];
                    var after = producedPixels[producedRow + x * 4 + channel];
                    result[index + channel] = (byte)Math.Clamp(before * (1 - weight) + after * weight, 0, 255);
                }

                result[index + 3] = 255;
            }
        }

        using var bitmap = FromBgra(width, height, result);
        return await EncodePngAsync(bitmap);
    }

    /// <summary>可分离均值模糊，避免贴回时出现硬边。</summary>
    private static byte[] SoftenMask(byte[] mask, int width, int height, int radius)
    {
        if (radius <= 0) return mask;

        var horizontal = new byte[mask.Length];
        for (var y = 0; y < height; y++)
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
        }

        var result = new byte[mask.Length];
        for (var x = 0; x < width; x++)
        {
            for (var y = 0; y < height; y++)
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
        }

        return result;
    }

    /// <summary>把 PNG 遮罩解码为 8 位单通道（取红通道）。</summary>
    public static async Task<byte[]> DecodeMaskAsync(byte[] png, int width, int height)
    {
        using var bitmap = await DecodeAsync(png);
        var pixels = ReadPixels(bitmap, out var stride);
        var mask = new byte[width * height];

        var copyWidth = Math.Min(width, bitmap.PixelWidth);
        var copyHeight = Math.Min(height, bitmap.PixelHeight);
        for (var y = 0; y < copyHeight; y++)
        {
            var row = y * stride;
            for (var x = 0; x < copyWidth; x++)
                mask[y * width + x] = pixels[row + x * 4 + 2];
        }
        return mask;
    }

    /// <summary>由 Bgra8 字节数组创建位图（遮罩合成、补全结果回填使用）。</summary>
    public static SoftwareBitmap FromBgra(int width, int height, byte[] pixels)
    {
        var bitmap = new SoftwareBitmap(BitmapPixelFormat.Bgra8,
            width, height, BitmapAlphaMode.Premultiplied);

        using var buffer = bitmap.LockBuffer(BitmapBufferAccessMode.Write);
        using var reference = buffer.CreateReference();

        var data = GetBufferPointer(reference, out var capacity);
        var size = Math.Min(pixels.Length, (int)capacity);
        Marshal.Copy(pixels, 0, data, size);
        return bitmap;
    }

    /// <summary>创建纯白 / 纯黑 RGBA 数组，用于遮罩。</summary>
    public static byte[] NewMaskBytes(int width, int height, byte value = 0)
    {
        var bytes = new byte[width * height * 4];
        for (var i = 0; i < bytes.Length; i += 4)
        {
            bytes[i] = value;
            bytes[i + 1] = value;
            bytes[i + 2] = value;
            bytes[i + 3] = 255;
        }
        return bytes;
    }
}
