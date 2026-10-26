using System;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// 生图服务：读取 STUDIO 设置中的图像模型配置，按协议分派到 OpenAI 兼容或通义万相实现。
/// 结果落盘到本地缓存目录，供界面、历史与 Office 插件共用。
/// </summary>
public sealed class ImageGenerationService : IImageGenerationService
{
    // 不设总超时：本地/远程 SD 服务端可能排队或慢速出图，只由用户按 Esc 取消
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    public async Task<GenerationResult> GenerateAsync(
        GenerationRequest request, IProgress<double>? progress, CancellationToken ct)
    {
        // 演示模式：不读配置、不联网，直接走内置素材，便于预览动画
        if (App.DemoMode)
        {
            var demoPrompt = PromptComposer.Compose(request);
            if (string.IsNullOrWhiteSpace(demoPrompt)) demoPrompt = "演示画面";

            AppLog.Info("开始生成", "provider=demo");
            progress?.Report(0.02);

            var demoBytes = await DemoImageProvider.GenerateAsync(progress, ct).ConfigureAwait(false);
            if (demoBytes.Length == 0) throw new ImageGenerationException("演示素材读取失败。");

            var demoPath = SaveToCache(demoBytes);
            progress?.Report(1);
            AppLog.Info("生成完成", $"{demoBytes.Length / 1024} KB");
            return new GenerationResult(demoPath, demoBytes, demoPrompt, "demo");
        }

        var settings = SettingsStore.Instance;
        if (!settings.HasImageModel)
        {
            throw new ImageGenerationException(
                "尚未配置图像模型\n在「STUDIO 设置」的「模型」页填写接口地址与模型名称。")
            {
                IsConfigurationError = true,
            };
        }

        var prompt = PromptComposer.Compose(request);
        if (string.IsNullOrWhiteSpace(prompt))
            throw new ImageGenerationException("先选择元素，或输入描述。");

        var provider = ResolveProvider(settings.ImageProvider, settings.ImageApiBase, settings.ImageModel);

        // 未指定协议时探测一次：SD WebUI（/sdapi/v1/options）能通就走它的 txt2img，否则按 OpenAI 兼容处理
        if (provider == "auto")
        {
            provider = await SdWebUiImageProvider
                .IsAvailableAsync(Http, settings.ImageApiBase, ct)
                .ConfigureAwait(false)
                ? "sdwebui"
                : "openai";
        }

        var size = request.Size > 0 ? request.Size : 1024;

        AppLog.Info("开始生成", $"provider={provider} size={size}");
        progress?.Report(0.03);

        byte[] bytes;
        try
        {
            bytes = provider switch
            {
                "dashscope" => await DashScopeImageProvider.GenerateAsync(Http, settings.ImageApiBase,
                    settings.ImageApiKey, settings.ImageModel, prompt, size, progress, ct).ConfigureAwait(false),
                "sdwebui" => await SdWebUiImageProvider.GenerateAsync(Http, settings.ImageApiBase,
                    settings.ImageApiKey, prompt, size, progress, ct).ConfigureAwait(false),
                _ => await OpenAiImageProvider.GenerateAsync(Http, settings.ImageApiBase,
                    settings.ImageApiKey, settings.ImageModel, prompt, size, progress, ct).ConfigureAwait(false),
            };
        }
        catch (HttpRequestException ex)
        {
            AppLog.Write("网络错误", ex.GetType().Name);
            throw new ImageGenerationException("网络连接失败。请检查网络与接口地址。", 0, ex);
        }

        if (bytes.Length == 0)
            throw new ImageGenerationException("没有取到图片。请重试。");

        var path = SaveToCache(bytes);
        progress?.Report(1);
        AppLog.Info("生成完成", $"{bytes.Length / 1024} KB");
        return new GenerationResult(path, bytes, prompt, provider);
    }

    /// <summary>返回固定协议名；无法从配置判断时返回 auto，由调用方探测。</summary>
    private static string ResolveProvider(string configured, string baseUrl, string model)
    {
        var value = (configured ?? "").Trim().ToLowerInvariant();
        if (value is "openai" or "dashscope" or "sdwebui") return value;
        if (value is "sd" or "webui") return "sdwebui";

        var url = baseUrl.ToLowerInvariant();
        var name = model.ToLowerInvariant();
        if (url.Contains("dashscope") || url.Contains("aliyuncs")
            || name.StartsWith("wanx") || name.StartsWith("wan2") || name.StartsWith("qwen-image"))
            return "dashscope";

        return "auto";
    }

    private static string SaveToCache(byte[] bytes)
    {
        var dir = Path.Combine(AppLog.Directory, "cache");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"gen_{DateTime.Now:yyyyMMdd_HHmmss_fff}.png");
        File.WriteAllBytes(path, bytes);
        return path;
    }
}
