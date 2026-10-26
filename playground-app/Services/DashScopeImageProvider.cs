using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// 通义万相（DashScope）异步任务：创建任务拿 task_id，每 2 秒轮询，成功后下载结果图。
/// </summary>
internal static class DashScopeImageProvider
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(150);

    public static async Task<byte[]> GenerateAsync(
        HttpClient http, string baseUrl, string apiKey, string model, string prompt,
        int size, IProgress<double>? progress, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(apiKey))
            throw new ImageGenerationException("通义万相需要在 STUDIO 设置中填写图像模型 API Key。",
                401) { IsConfigurationError = true };

        var root = NormalizeRoot(baseUrl);
        var createUrl = root + "/api/v1/services/aigc/text2image/image-synthesis";

        var payload = new Dictionary<string, object>
        {
            ["model"] = model,
            ["input"] = new Dictionary<string, object> { ["prompt"] = prompt },
            ["parameters"] = new Dictionary<string, object>
            {
                ["size"] = $"{size}*{size}",
                ["n"] = 1,
            },
        };
        var json = JsonSerializer.Serialize(payload);

        string taskId;
        using (var response = await HttpUtil.SendOnceAsync(http, () =>
               {
                   var request = HttpUtil.JsonPost(createUrl, json, apiKey);
                   request.Headers.TryAddWithoutValidation("X-DashScope-Async", "enable");
                   return request;
               }, ct).ConfigureAwait(false))
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw new ImageGenerationException(await HttpUtil.DescribeErrorAsync(response).ConfigureAwait(false),
                    (int)response.StatusCode);

            using var doc = JsonDocument.Parse(text);
            taskId = ReadTaskId(doc.RootElement)
                     ?? throw new ImageGenerationException("通义万相未返回任务编号。");
        }

        progress?.Report(0.3);
        var deadline = DateTimeOffset.UtcNow + PollTimeout;
        var taskUrl = $"{root}/api/v1/tasks/{taskId}";
        var spins = 0;

        while (DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(PollInterval, ct).ConfigureAwait(false);

            using var response = await http.GetAsync(taskUrl, ct).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw new ImageGenerationException(await HttpUtil.DescribeErrorAsync(response).ConfigureAwait(false),
                    (int)response.StatusCode);

            using var doc = JsonDocument.Parse(text);
            var output = doc.RootElement.TryGetProperty("output", out var o) ? o : default;
            var status = output.ValueKind == JsonValueKind.Object
                         && output.TryGetProperty("task_status", out var s) && s.ValueKind == JsonValueKind.String
                ? s.GetString() ?? ""
                : "";

            switch (status.ToUpperInvariant())
            {
                case "SUCCEEDED":
                    progress?.Report(0.85);
                    var url = ReadFirstResultUrl(output);
                    if (string.IsNullOrWhiteSpace(url))
                        throw new ImageGenerationException("通义万相任务成功但没有返回图片地址。");
                    return await HttpUtil.DownloadAsync(http, url, ct).ConfigureAwait(false);

                case "FAILED":
                case "CANCELED":
                case "UNKNOWN":
                    var reason = output.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
                        ? m.GetString()
                        : null;
                    throw new ImageGenerationException(
                        string.IsNullOrWhiteSpace(reason) ? "通义万相生成失败。" : $"通义万相生成失败：{reason}");
            }

            spins++;
            progress?.Report(Math.Min(0.8, 0.3 + spins * 0.03));
        }

        throw new ImageGenerationException("通义万相生成超时（150 秒），请稍后重试。");
    }

    private static string NormalizeRoot(string baseUrl)
    {
        var root = baseUrl.Trim().TrimEnd('/');
        if (root.EndsWith("/api/v1", StringComparison.OrdinalIgnoreCase))
            root = root[..^"/api/v1".Length];
        return root;
    }

    private static string? ReadTaskId(JsonElement root)
    {
        if (root.TryGetProperty("output", out var output)
            && output.TryGetProperty("task_id", out var id)
            && id.ValueKind == JsonValueKind.String)
            return id.GetString();
        return null;
    }

    private static string? ReadFirstResultUrl(JsonElement output)
    {
        if (!output.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array
            || results.GetArrayLength() == 0)
            return null;
        var first = results[0];
        if (first.TryGetProperty("url", out var url) && url.ValueKind == JsonValueKind.String)
            return url.GetString();
        return null;
    }
}
