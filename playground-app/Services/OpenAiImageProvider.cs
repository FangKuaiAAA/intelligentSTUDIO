using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// OpenAI 兼容的 /v1/images/generations。
/// 同时兼容返回 b64_json 与 url；gpt-image 系列不接受 response_format，遇到 400 时自动去掉该字段重试一次。
/// </summary>
internal static class OpenAiImageProvider
{
    public static async Task<byte[]> GenerateAsync(
        HttpClient http, string baseUrl, string apiKey, string model, string prompt,
        int size, IProgress<double>? progress, CancellationToken ct)
    {
        var endpoint = BuildEndpoint(baseUrl);
        var payload = new Dictionary<string, object>
        {
            ["model"] = model,
            ["prompt"] = prompt,
            ["n"] = 1,
            ["size"] = $"{size}x{size}",
            ["response_format"] = "b64_json",
        };

        var bytes = await RequestAsync(http, endpoint, apiKey, payload, progress, ct).ConfigureAwait(false);
        if (bytes is not null) return bytes;

        // 去掉 response_format 再试一次（部分模型/中转站不接受该字段）
        payload.Remove("response_format");
        progress?.Report(0.2);
        bytes = await RequestAsync(http, endpoint, apiKey, payload, progress, ct).ConfigureAwait(false);
        return bytes ?? throw new ImageGenerationException("生图服务没有返回图片数据。");
    }

    private static async Task<byte[]?> RequestAsync(
        HttpClient http, string endpoint, string apiKey, Dictionary<string, object> payload,
        IProgress<double>? progress, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(payload);
        using var response = await HttpUtil
            .SendOnceAsync(http, () => HttpUtil.JsonPost(endpoint, json, apiKey), ct)
            .ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            // 仅在明确是 response_format 字段不被接受时返回 null 让上层重试
            if ((int)response.StatusCode == 400
                && body.Contains("response_format", StringComparison.OrdinalIgnoreCase))
                return null;

            throw new ImageGenerationException(await HttpUtil.DescribeErrorAsync(response).ConfigureAwait(false),
                (int)response.StatusCode);
        }

        progress?.Report(0.55);
        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        using var doc = JsonDocument.Parse(text);
        if (!doc.RootElement.TryGetProperty("data", out var data)
            || data.ValueKind != JsonValueKind.Array
            || data.GetArrayLength() == 0)
            throw new ImageGenerationException("生图服务返回的数据格式不正确。");

        var first = data[0];
        if (first.TryGetProperty("b64_json", out var b64) && b64.ValueKind == JsonValueKind.String
            && b64.GetString() is { Length: > 0 } b64Text)
        {
            progress?.Report(0.85);
            return HttpUtil.DecodeBase64(b64Text);
        }

        if (first.TryGetProperty("url", out var urlNode) && urlNode.ValueKind == JsonValueKind.String
            && urlNode.GetString() is { Length: > 0 } url)
        {
            progress?.Report(0.7);
            return await HttpUtil.DownloadAsync(http, url, ct).ConfigureAwait(false);
        }

        throw new ImageGenerationException("生图服务没有返回图片数据。");
    }

    /// <summary>兼容 base 末尾是否已带 /v1 或 /images/generations。</summary>
    private static string BuildEndpoint(string baseUrl)
    {
        var url = baseUrl.Trim().TrimEnd('/');
        if (url.EndsWith("/images/generations", StringComparison.OrdinalIgnoreCase)) return url;
        if (url.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) return url + "/images/generations";
        return url + "/v1/images/generations";
    }
}
