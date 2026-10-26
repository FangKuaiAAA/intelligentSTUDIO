using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;

namespace PhotoEditor.Services;

public sealed class SegmentResponse
{
    [JsonPropertyName("mask")] public string Mask { get; set; } = "";
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }
    [JsonPropertyName("found")] public bool Found { get; set; }
}

public sealed class JobStatus
{
    [JsonPropertyName("state")] public string State { get; set; } = "pending";
    [JsonPropertyName("stage")] public string Stage { get; set; } = "";
    [JsonPropertyName("progress")] public double Progress { get; set; }
    [JsonPropertyName("result")] public string? Result { get; set; }
    [JsonPropertyName("meta")] public JsonElement Meta { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
}

/// <summary>
/// 本地推理服务（backend/photo_service.py，127.0.0.1:8772）：分割、修复、3D 重建。
/// 图像一律以 base64 PNG 往返，避免临时文件争用。
/// 8771 归 office_bridge.py（Office 加载项桥），本服务用 8772。
/// </summary>
public sealed class PhotoServiceClient
{
    public const int Port = 8772;

    public static string BaseUrl => $"http://127.0.0.1:{Port}";

    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static PhotoServiceClient Instance { get; } = new();

    /// <summary>服务是否就绪；未就绪时尝试从仓库启动一次。</summary>
    public async Task<bool> EnsureRunningAsync(CancellationToken ct = default)
    {
        if (await PingAsync(ct).ConfigureAwait(false)) return true;
        TryStartService();
        for (var i = 0; i < 40; i++)
        {
            await Task.Delay(500, ct).ConfigureAwait(false);
            if (await PingAsync(ct).ConfigureAwait(false)) return true;
        }
        return false;
    }

    public async Task<bool> PingAsync(CancellationToken ct = default)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            using var response = await Http.GetAsync($"{BaseUrl}/api/health", timeout.Token).ConfigureAwait(false);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>为一张图建立分割会话：编码器只跑一次，后续点击只需解码器。</summary>
    public async Task<string> CreateSessionAsync(byte[] imagePng, CancellationToken ct = default)
    {
        var payload = new Dictionary<string, object>
        {
            ["image"] = Convert.ToBase64String(imagePng),
        };

        using var response = await Http.PostAsJsonAsync($"{BaseUrl}/api/session", payload, JsonOptions, ct)
            .ConfigureAwait(false);
        await EnsureSuccessAsync(response, "建立会话").ConfigureAwait(false);

        var body = await response.Content.ReadFromJsonAsync<SessionCreated>(cancellationToken: ct)
            .ConfigureAwait(false);
        return body?.Id ?? throw new InvalidOperationException("分割服务没有返回会话编号。");
    }

    public async Task<SegmentResponse> SegmentAsync(string sessionId, IReadOnlyList<Point> points,
        byte[]? scribbleMask, CancellationToken ct = default)
    {
        var payload = new Dictionary<string, object?>
        {
            ["session"] = sessionId,
            ["points"] = ToPointList(points),
        };

        if (scribbleMask is { Length: > 0 })
            payload["scribble"] = Convert.ToBase64String(scribbleMask);

        using var response = await Http.PostAsJsonAsync($"{BaseUrl}/api/segment", payload, JsonOptions, ct)
            .ConfigureAwait(false);
        await EnsureSuccessAsync(response, "分割").ConfigureAwait(false);

        var result = await response.Content.ReadFromJsonAsync<SegmentResponse>(cancellationToken: ct)
            .ConfigureAwait(false);
        return result ?? throw new InvalidOperationException("分割服务没有返回结果。");
    }

    /// <summary>Moebius：无文本条件的局部修补，以遮罩为中心裁窗口后整体重绘。</summary>
    public async Task<byte[]> MoebiusInpaintAsync(byte[] imagePng, byte[] maskPng,
        int steps = 20, CancellationToken ct = default)
    {
        var payload = new Dictionary<string, object>
        {
            ["image"] = Convert.ToBase64String(imagePng),
            ["mask"] = Convert.ToBase64String(maskPng),
            ["steps"] = steps,
        };

        using var response = await Http.PostAsJsonAsync($"{BaseUrl}/api/moebius/inpaint", payload, JsonOptions, ct)
            .ConfigureAwait(false);
        await EnsureSuccessAsync(response, "Moebius 修复").ConfigureAwait(false);

        var body = await response.Content.ReadFromJsonAsync<InpaintResponse>(cancellationToken: ct)
            .ConfigureAwait(false);
        if (body is null || string.IsNullOrEmpty(body.Image))
            throw new InvalidOperationException("Moebius 修复没有返回图像。");

        return Convert.FromBase64String(body.Image);
    }

    public async Task<string> StartReframeAsync(byte[] imagePng, string? outputPath = null, CancellationToken ct = default)
    {
        var payload = new Dictionary<string, object>
        {
            ["image"] = Convert.ToBase64String(imagePng),
        };

        // 全量高斯体积大，让推理服务直接落盘，省掉一次 base64 往返
        if (!string.IsNullOrEmpty(outputPath))
            payload["output_path"] = outputPath;

        using var response = await Http.PostAsJsonAsync($"{BaseUrl}/api/reframe/prepare", payload, JsonOptions, ct)
            .ConfigureAwait(false);
        await EnsureSuccessAsync(response, "三维重建").ConfigureAwait(false);

        var body = await response.Content.ReadFromJsonAsync<JobCreated>(cancellationToken: ct)
            .ConfigureAwait(false);
        return body?.Job ?? throw new InvalidOperationException("重建服务没有返回任务编号。");
    }

    public async Task<JobStatus> GetJobAsync(string jobId, CancellationToken ct = default)
    {
        using var response = await Http.GetAsync($"{BaseUrl}/api/jobs/{jobId}", ct).ConfigureAwait(false);
        await EnsureSuccessAsync(response, "任务查询").ConfigureAwait(false);

        var status = await response.Content.ReadFromJsonAsync<JobStatus>(cancellationToken: ct)
            .ConfigureAwait(false);
        return status ?? throw new InvalidOperationException("任务状态缺失。");
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, string stage)
    {
        if (response.IsSuccessStatusCode) return;

        var detail = "";
        try { detail = await response.Content.ReadAsStringAsync().ConfigureAwait(false); }
        catch { /* 忽略读取失败 */ }

        AppLog.Write($"{stage}失败", $"HTTP {(int)response.StatusCode}");
        throw new HttpRequestException($"{stage}失败：{(int)response.StatusCode} {Trim(detail)}");
    }

    private static string Trim(string text) =>
        string.IsNullOrWhiteSpace(text) ? "" : text.Length > 200 ? text[..200] : text;

    private static List<object> ToPointList(IReadOnlyList<Point> points)
    {
        var list = new List<object>(points.Count);
        foreach (var point in points)
            list.Add(new { x = point.X, y = point.Y, label = 1 });
        return list;
    }

    /// <summary>拉起 Python 服务：优先使用 .venv-photo，其次系统 python。</summary>
    private void TryStartService()
    {
        try
        {
            var root = SettingsStore.Instance.RepoRoot;
            if (root is null) return;

            var script = Path.Combine(root, "backend", "photo_service.py");
            if (!File.Exists(script)) return;

            var venv = Path.Combine(root, ".venv-photo312", "Scripts", "python.exe");
            if (!File.Exists(venv))
                venv = Path.Combine(root, ".venv-photo", "Scripts", "python.exe");

            var python = File.Exists(venv) ? venv : "python";

            var info = new ProcessStartInfo(python, $"\"{script}\"")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            Process.Start(info);
            AppLog.Info("启动推理服务", python);
        }
        catch (Exception ex)
        {
            AppLog.Write("启动推理服务失败", ex.GetType().Name);
        }
    }

    private sealed class InpaintResponse
    {
        [JsonPropertyName("image")] public string Image { get; set; } = "";
    }

    private sealed class SessionCreated
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";
    }

    private sealed class JobCreated
    {
        [JsonPropertyName("job")] public string Job { get; set; } = "";
    }
}
