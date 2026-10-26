using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// 演示模式（--demo）使用的本地“模型”：不访问网络，按接近真实生成的节奏推进进度后返回内置素材，
/// 用于在没有配置生图模型时预览生成动画与结果形态。
/// </summary>
internal static class DemoImageProvider
{
    private static readonly Random Rng = new();

    public static async Task<byte[]> GenerateAsync(IProgress<double>? progress, CancellationToken ct)
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Assets", "Demo");
        var files = Directory.Exists(dir) ? Directory.GetFiles(dir, "*.png") : Array.Empty<string>();
        if (files.Length == 0)
            throw new ImageGenerationException("演示素材缺失。");

        progress?.Report(0.04);

        // 共约 15 秒（20 × 0.75s），足够看清呼吸光边与换色
        const int steps = 20;
        for (var i = 1; i <= steps; i++)
        {
            await Task.Delay(750, ct).ConfigureAwait(false);
            progress?.Report(0.04 + i * (0.9 / steps));
        }

        var pick = files[Rng.Next(files.Length)];
        return await File.ReadAllBytesAsync(pick, ct).ConfigureAwait(false);
    }
}
