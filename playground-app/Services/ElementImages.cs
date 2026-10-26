using System;
using System.Collections.Generic;
using System.IO;
using ImagePlayground.Models;
using Microsoft.UI.Xaml.Media.Imaging;

namespace ImagePlayground.Services;

/// <summary>
/// 元素图标缓存：统一按输出目录的绝对路径加载（解包应用的 ms-appx 解析偶发不稳定），
/// 首次使用时解码到 160px 并复用同一个 BitmapImage，保证 chip 与建议区图标一致且不重复解码。
/// </summary>
public static class ElementImages
{
    private static readonly Dictionary<string, BitmapImage> Cache = new();

    public static BitmapImage? Get(PlaygroundElement element)
    {
        if (Cache.TryGetValue(element.Id, out var cached)) return cached;

        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "Assets", "Elements", element.File);
            var image = new BitmapImage { DecodePixelWidth = 160 };

            if (File.Exists(path))
                image.UriSource = new Uri(path);
            else
                image.UriSource = new Uri(element.ImageUri);

            Cache[element.Id] = image;
            return image;
        }
        catch (Exception ex)
        {
            AppLog.Write("元素图标加载失败", $"{element.Id}:{ex.GetType().Name}");
            return null;
        }
    }
}
