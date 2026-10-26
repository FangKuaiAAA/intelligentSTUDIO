using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// Stable Diffusion WebUI / SD.Next 风格的 <c>/sdapi/v1/txt2img</c>（默认端口 7860）。
/// 只传提示词与尺寸，采样步数等沿用服务端已调好的默认值；
/// 该接口没有进度回调，进度条按时间平滑推进，完成时跳到 0.9。
/// </summary>
internal static class SdWebUiImageProvider
{
    public static async Task<byte[]> GenerateAsync(
        HttpClient http, string baseUrl, string apiKey, string prompt,
        int size, IProgress<double>? progress, CancellationToken ct)
    {
        var endpoint = BuildEndpoint(baseUrl);
        var payload = new Dictionary<string, object>
        {
            ["prompt"] = prompt,
            ["width"] = size,
            ["height"] = size,
        };
        var json = JsonSerializer.Serialize(payload);

        progress?.Report(0.12);
        using var pump = new ProgressPump(progress, 0.12, 0.85, TimeSpan.FromSeconds(75));

        var started = Stopwatch.StartNew();

        // 只读响应头：拿到响应头的时刻 = 服务端开始回写（生成结束），之后的耗时才可能是传输
        using var response = await HttpUtil
            .SendOnceAsync(http, () => BuildRequest(endpoint, json, apiKey), ct)
            .ConfigureAwait(false);

        var headersAt = started.Elapsed.TotalSeconds;
        var declared = response.Content.Headers.ContentLength;

        AppLog.Info("SD 首包",
            $"HTTP {(int)response.StatusCode} {headersAt:F1}s 声明长度 {(declared is null ? "未知" : $"{declared / 1024} KB")}");

        if (!response.IsSuccessStatusCode)
            throw new ImageGenerationException(
                await HttpUtil.DescribeErrorAsync(response).ConfigureAwait(false),
                (int)response.StatusCode);

        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var bodyAt = started.Elapsed.TotalSeconds;

        AppLog.Info("SD 正文",
            $"{text.Length / 1024} KB {bodyAt:F1}s（传输 {(bodyAt - headersAt):F1}s）");

        using var doc = JsonDocument.Parse(text);

        // 服务端自报的生成秒数：与首包时间对比即可判断时间花在生成、排队还是传输
        LogServerGenerationTime(doc.RootElement);

        if (!doc.RootElement.TryGetProperty("images", out var images)
            || images.ValueKind != JsonValueKind.Array
            || images.GetArrayLength() == 0)
            throw new ImageGenerationException("生图服务没有返回图片数据。");

        var b64 = images[0].GetString();
        if (string.IsNullOrWhiteSpace(b64))
            throw new ImageGenerationException("生图服务没有返回图片数据。");

        progress?.Report(0.9);

        var bytes = HttpUtil.DecodeBase64(b64);
        AppLog.Info("SD 解码", $"{bytes.Length / 1024} KB 累计 {started.Elapsed.TotalSeconds:F1}s");
        return bytes;
    }

    /// <summary>SD 的 info 字段是一段 JSON 字符串，里面的 time 才是真正的推理耗时。</summary>
    private static void LogServerGenerationTime(JsonElement root)
    {
        try
        {
            if (!root.TryGetProperty("info", out var info)) return;

            var text = info.ValueKind == JsonValueKind.String ? info.GetString() : info.GetRawText();
            if (string.IsNullOrWhiteSpace(text)) return;

            using var infoDoc = JsonDocument.Parse(text);
            if (infoDoc.RootElement.TryGetProperty("time", out var time))
                AppLog.Info("SD 生成耗时", $"{time} 秒");
        }
        catch { /* info 不是标准 JSON 时忽略 */ }
    }

    private static readonly Dictionary<string, (bool ok, DateTime at)> ProbeCache = new();
    private static readonly TimeSpan ProbeTtl = TimeSpan.FromMinutes(5);

    /// <summary>
    /// 探测该地址是否为 SD WebUI 风格接口：/sdapi/v1/options 能否返回 200。
    /// 结果缓存 5 分钟，避免每次生成都多打一次请求；探测本身不触发任何推理。
    /// </summary>
    public static async Task<bool> IsAvailableAsync(HttpClient http, string baseUrl, CancellationToken ct)
    {
        var key = Root(baseUrl);

        lock (ProbeCache)
        {
            if (ProbeCache.TryGetValue(key, out var cached)
                && DateTime.UtcNow - cached.at < ProbeTtl)
                return cached.ok;
        }

        var ok = false;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(4));

            using var response = await http
                .GetAsync($"{key}/sdapi/v1/options", timeout.Token)
                .ConfigureAwait(false);

            ok = response.IsSuccessStatusCode;
        }
        catch
        {
            ok = false;
        }

        lock (ProbeCache) ProbeCache[key] = (ok, DateTime.UtcNow);
        return ok;
    }

    private static HttpRequestMessage BuildRequest(string endpoint, string json, string? apiKey)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };

        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            // SD WebUI 的 --api-auth 用 user:password，其余情况按 Bearer 传
            if (apiKey.Contains(':'))
            {
                var token = Convert.ToBase64String(Encoding.UTF8.GetBytes(apiKey));
                request.Headers.Authorization = new AuthenticationHeaderValue("Basic", token);
            }
            else
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            }
        }

        return request;
    }

    private static string Normalize(string baseUrl) => baseUrl.Trim().TrimEnd('/');

    /// <summary>
    /// 服务根地址：兼容只填主机端口、填到 /sdapi/v1、或直接填到 /txt2img 三种写法。
    /// </summary>
    private static string Root(string baseUrl)
    {
        var url = Normalize(baseUrl);
        if (url.EndsWith("/txt2img", StringComparison.OrdinalIgnoreCase))
            url = url[..^"/txt2img".Length];
        if (url.EndsWith("/sdapi/v1", StringComparison.OrdinalIgnoreCase))
            url = url[..^"/sdapi/v1".Length];
        return url.TrimEnd('/');
    }

    private static string BuildEndpoint(string baseUrl) => Root(baseUrl) + "/sdapi/v1/txt2img";
}

/// <summary>按时间推进的伪进度：仅在请求进行期间向前走，结束后由调用方跳到最终值。</summary>
internal sealed class ProgressPump : IDisposable
{
    private readonly CancellationTokenSource _cts = new();

    public ProgressPump(IProgress<double>? progress, double from, double to, TimeSpan span)
    {
        if (progress is null) return;

        _ = Task.Run(async () =>
        {
            var start = DateTime.UtcNow;
            try
            {
                while (!_cts.IsCancellationRequested)
                {
                    await Task.Delay(700, _cts.Token).ConfigureAwait(false);

                    var elapsed = (DateTime.UtcNow - start).TotalSeconds;
                    // 指数逼近目标值：不会停在某个平台，长任务也能一直缓慢前进
                    var k = 1 - Math.Exp(-elapsed / span.TotalSeconds);
                    try { progress.Report(from + (to - from) * Math.Clamp(k, 0, 0.99)); } catch { /* 忽略 */ }
                }
            }
            catch { /* 取消时退出 */ }
        });
    }

    public void Dispose()
    {
        try { _cts.Cancel(); } catch { /* 忽略 */ }
        _cts.Dispose();
    }
}
