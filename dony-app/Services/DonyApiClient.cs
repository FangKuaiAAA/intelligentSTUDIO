using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Dony.Services;

/// <summary>Dony 后端接口客户端：历史会话、续聊（SSE 流式）、TTS 与文件访问设置。</summary>
public class DonyApiClient
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;

    public string BaseUrl { get; }

    public DonyApiClient(string? baseUrl = null)
    {
        BaseUrl = baseUrl ?? Environment.GetEnvironmentVariable("DONY_APP_API") ?? "http://127.0.0.1:8769";
        _http = new HttpClient { BaseAddress = new Uri(BaseUrl), Timeout = TimeSpan.FromSeconds(120) };
    }

    public async Task<bool> PingAsync(CancellationToken ct = default)
    {
        try
        {
            using var resp = await _http.GetAsync("/api/health", ct);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>历史会话列表（后端返回 {"sessions": [...]}）。</summary>
    private sealed class SessionsResponse
    {
        [System.Text.Json.Serialization.JsonPropertyName("sessions")]
        public List<SessionSummary> Sessions { get; set; } = new();
    }

    public async Task<List<SessionSummary>> GetSessionsAsync(CancellationToken ct = default)
        => (await _http.GetFromJsonAsync<SessionsResponse>("/api/history/sessions", JsonOpts, ct))?.Sessions
           ?? new List<SessionSummary>();

    public async Task<SessionDetail?> GetSessionAsync(string id, CancellationToken ct = default)
        => await _http.GetFromJsonAsync<SessionDetail>($"/api/history/sessions/{id}", JsonOpts, ct);

    public async Task DeleteSessionAsync(string id, CancellationToken ct = default)
        => (await _http.DeleteAsync($"/api/history/sessions/{id}", ct)).EnsureSuccessStatusCode();

    public async Task RenameSessionAsync(string id, string title, CancellationToken ct = default)
    {
        using var resp = await _http.PatchAsJsonAsync($"/api/history/sessions/{id}",
            new Dictionary<string, string> { ["title"] = title }, JsonOpts, ct);
        resp.EnsureSuccessStatusCode();
    }

    public async Task<DonySettings?> GetSettingsAsync(CancellationToken ct = default)
        => await _http.GetFromJsonAsync<DonySettings>("/api/settings", JsonOpts, ct);

    public async Task<DonySettings?> UpdateSettingsAsync(SettingsPatch patch, CancellationToken ct = default)
    {
        using var resp = await _http.PutAsJsonAsync("/api/settings", patch, JsonOpts, ct);
        resp.EnsureSuccessStatusCode();
        return JsonSerializer.Deserialize<DonySettings>(await resp.Content.ReadAsStringAsync(ct), JsonOpts);
    }

    /// <summary>
    /// 试听朗读：用指定音色合成一段 mp3 并返回字节（后端只合成不播放）。
    /// voice 为空时后端使用当前已保存的音色。
    /// </summary>
    public async Task<byte[]> PreviewTtsAsync(string? voice, string? text = null,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object>();
        if (!string.IsNullOrEmpty(voice)) body["voice"] = voice;
        if (!string.IsNullOrEmpty(text)) body["text"] = text;
        using var resp = await _http.PostAsJsonAsync("/api/tts/preview", body, JsonOpts, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string detail = "";
            try
            {
                using var doc = await JsonDocument.ParseAsync(
                    await resp.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
                if (doc.RootElement.TryGetProperty("detail", out var d)) detail = d.GetString() ?? "";
            }
            catch { }
            throw new Exception(string.IsNullOrEmpty(detail) ? $"HTTP {(int)resp.StatusCode}" : detail);
        }
        return await resp.Content.ReadAsByteArrayAsync(ct);
    }

    /// <summary>在历史会话中继续对话，逐条产出事件（delta / tool / card / done / error）。</summary>
    public async IAsyncEnumerable<ChatEvent> ChatAsync(string sessionId, string text,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/history/sessions/{sessionId}/chat")
        {
            Content = JsonContent.Create(new Dictionary<string, object> { ["text"] = text, ["voice"] = false }),
        };
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();
        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream)
        {
            ct.ThrowIfCancellationRequested();
            var line = await reader.ReadLineAsync(ct);
            if (string.IsNullOrWhiteSpace(line) || !line.StartsWith("data: "))
                continue;
            ChatEvent? ev = null;
            try
            {
                using var doc = JsonDocument.Parse(line[6..]);
                var root = doc.RootElement;
                ev = new ChatEvent
                {
                    Type = root.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "",
                    Text = root.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "",
                    Label = root.TryGetProperty("label", out var lb) ? lb.GetString() ?? "" : "",
                    Delta = root.TryGetProperty("delta", out var dl) ? dl.GetString() ?? "" : "",
                    Mode = root.TryGetProperty("mode", out var md) ? md.GetString() ?? "" : "",
                    Kind = root.TryGetProperty("kind", out var kd) ? kd.GetString() ?? "" : "",
                    AskId = root.TryGetProperty("id", out var idp) ? idp.GetString() ?? "" : "",
                    Message = root.TryGetProperty("message", out var mg) ? mg.GetString() ?? "" : "",
                };
                if (root.TryGetProperty("ok", out var ok) && ok.ValueKind
                    is JsonValueKind.True or JsonValueKind.False)
                    ev.Ok = ok.GetBoolean();
                if (root.TryGetProperty("steps", out var steps) && steps.ValueKind == JsonValueKind.Array)
                    ev.Steps = steps.Deserialize<List<string>>(JsonOpts) ?? new();
                if (root.TryGetProperty("card", out var card))
                    ev.Card = card.Deserialize<CardInfo>(JsonOpts);
                if (root.TryGetProperty("cards", out var cards))
                    ev.Cards = cards.Deserialize<List<CardInfo>>(JsonOpts) ?? new();
            }
            catch
            {
                continue;
            }
            yield return ev;
        }
    }

    /// <summary>
    /// 回填对话中的确认 / 反问答复（SSE 是单向的，所以另发一个 POST）。
    /// kind=confirm 时用 approved；kind=question 时用 text。
    /// </summary>
    public async Task RespondAskAsync(string sessionId, string askId, string? text = null,
        bool? approved = null, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object>();
        if (text is not null) body["text"] = text;
        if (approved is not null) body["approved"] = approved.Value;
        using var resp = await _http.PostAsJsonAsync(
            $"/api/history/sessions/{sessionId}/ask/{askId}", body, JsonOpts, ct);
        resp.EnsureSuccessStatusCode();
    }
}
