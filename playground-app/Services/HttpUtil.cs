using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

internal static class HttpUtil
{
    /// <summary>
    /// 只发一次。生图请求每重试一次就会让服务端再跑一整轮推理，代价过高，
    /// 因此失败后不在后台自动重试，交由用户决定是否再点「启动」。
    /// </summary>
    public static Task<HttpResponseMessage> SendOnceAsync(
        HttpClient http, Func<HttpRequestMessage> factory, CancellationToken ct) =>
        http.SendAsync(factory(), HttpCompletionOption.ResponseHeadersRead, ct);

    /// <summary>把服务端错误体压成一句中文，避免把整段 JSON 抛到界面。</summary>
    public static async Task<string> DescribeErrorAsync(HttpResponseMessage response)
    {
        string body = "";
        try { body = await response.Content.ReadAsStringAsync().ConfigureAwait(false); }
        catch { /* 忽略 */ }

        var message = ExtractMessage(body);
        var status = (int)response.StatusCode;

        if (status == 401 || status == 403)
            return "鉴权失败：请检查 STUDIO 设置中的图像模型 API Key。";
        if (status == 404)
            return "接口地址不存在：请检查设置中的图像模型 Base URL。";
        if (status == 429)
            return "请求过于频繁或额度不足，请稍后重试。";
        if (status >= 500)
            return $"生图服务暂时不可用（HTTP {status}），请稍后重试。";
        return string.IsNullOrWhiteSpace(message)
            ? $"生成失败（HTTP {status}）。"
            : $"生成失败：{message}";
    }

    private static string ExtractMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "";
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.String) return error.GetString() ?? "";
                if (error.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String)
                    return m.GetString() ?? "";
            }
            if (root.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String)
                return msg.GetString() ?? "";
            if (root.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String)
                return code.GetString() ?? "";
        }
        catch { /* 非 JSON 错误体 */ }

        return body.Length > 200 ? body[..200] : body;
    }

    /// <summary>下载结果图（部分中转站只返回 url）。</summary>
    public static async Task<byte[]> DownloadAsync(HttpClient http, string url, CancellationToken ct)
    {
        using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new ImageGenerationException(await DescribeErrorAsync(response).ConfigureAwait(false),
                (int)response.StatusCode);
        return await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
    }

    /// <summary>兼容 data:image/png;base64,xxx 与纯 base64。</summary>
    public static byte[] DecodeBase64(string value)
    {
        var comma = value.IndexOf(',');
        if (value.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma > 0)
            value = value[(comma + 1)..];
        try { return Convert.FromBase64String(value); }
        catch (FormatException ex) { throw new ImageGenerationException("返回的图片数据无法解析。", 0, ex); }
    }

    public static HttpRequestMessage JsonPost(string url, string json, string? apiKey)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrWhiteSpace(apiKey))
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
        return request;
    }
}
