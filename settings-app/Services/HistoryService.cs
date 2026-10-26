using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace DonySettings.Services;

/// <summary>对话记录：通过 Dony 应用接口清空全部历史会话。</summary>
public static class HistoryService
{
    /// <summary>返回删除的会话条数；连接失败时抛出 HttpRequestException。</summary>
    public static async Task<int> ClearAllAsync()
    {
        var baseUrl = Environment.GetEnvironmentVariable("DONY_APP_API") ?? "http://127.0.0.1:8769";
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
        using var resp = await http.DeleteAsync($"{baseUrl}/api/history/sessions");
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        return doc.RootElement.TryGetProperty("removed", out var value)
               && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32()
            : 0;
    }
}
