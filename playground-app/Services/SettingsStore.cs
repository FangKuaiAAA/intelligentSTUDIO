using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace ImagePlayground.Services;

/// <summary>MCP 服务器条目（与设置 APP / 后端共用同一份配置结构，本应用只做读写透传）。</summary>
public sealed class McpServer
{
    public string Name { get; set; } = "";
    public string Command { get; set; } = "";
}

/// <summary>
/// 设置持久化：读写 intelligentSTUDIO 的配置文件（.appx_config.json），与 backend/agent/config.py、
/// STUDIO 设置 APP 使用同一数据源。图乐园只读取图像模型三项 + 协议，不写入任何键。
/// </summary>
public sealed class SettingsStore
{
    public static SettingsStore Instance { get; } = new();

    /// <summary>intelligentSTUDIO 仓库根目录；找不到时为 null（设置改存用户目录）。</summary>
    public string? RepoRoot { get; }

    /// <summary>配置文件完整路径。</summary>
    public string ConfigPath { get; }

    public ObservableCollection<McpServer> McpServers { get; } = new();

    private readonly JsonObject _root;
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    private SettingsStore()
    {
        RepoRoot = FindRepoRoot();
        if (RepoRoot is not null)
        {
            ConfigPath = Path.Combine(RepoRoot, ".appx_config.json");
        }
        else
        {
            // 打包态：配置写在用户目录（安装目录在 Program Files 下不可写），与主进程/后端保持一致
            ConfigPath = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "IntelligentStudio"), "config.json");
        }
        _root = Load();
        LoadMcpServers();
    }

    private static string? FindRepoRoot()
    {
        // 从输出目录向上查找包含 package.json 与 backend 目录的仓库根（config.py 读取同一位置的 .appx_config.json）
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "package.json"))
                && Directory.Exists(Path.Combine(dir.FullName, "backend")))
                return dir.FullName;
        }
        return null;
    }

    private JsonObject Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
                return JsonNode.Parse(File.ReadAllText(ConfigPath)) as JsonObject ?? new JsonObject();
        }
        catch { /* 配置损坏时退回空白对象，保存时覆盖 */ }
        return new JsonObject();
    }

    public void Save()
    {
        SaveMcpServers();
        Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
        File.WriteAllText(ConfigPath, _root.ToJsonString(JsonOpts));
    }

    public string GetString(string key, string fallback = "") =>
        _root.TryGetPropertyValue(key, out var node)
            && node is JsonValue value
            && value.TryGetValue<string>(out var s)
            ? s : fallback;

    public bool GetBool(string key, bool fallback = false) =>
        _root.TryGetPropertyValue(key, out var node)
            && node is JsonValue value
            && value.TryGetValue<bool>(out var b)
            ? b : fallback;

    public int GetInt(string key, int fallback = 0) =>
        _root.TryGetPropertyValue(key, out var node)
            && node is JsonValue value
            && value.TryGetValue<int>(out var i)
            ? i : fallback;

    public void Set(string key, string? value) => _root[key] = value is null ? null : JsonValue.Create(value);
    public void Set(string key, bool value) => _root[key] = JsonValue.Create(value);
    public void Set(string key, int value) => _root[key] = JsonValue.Create(value);

    // ---------- 图乐园使用的配置（只读） ----------

    // 留空时跟随主模型（OPENAI_*），与设置页「留空沿用上一组配置」的说明一致
    public string ImageApiBase => Fallback("IMAGE_API_BASE", "OPENAI_API_BASE");

    public string ImageApiKey => Fallback("IMAGE_API_KEY", "OPENAI_API_KEY");

    public string ImageModel => Fallback("IMAGE_MODEL", "OPENAI_MODEL");

    private string Fallback(string key, string masterKey)
    {
        var v = GetString(key).Trim();
        return v.Length > 0 ? v : GetString(masterKey).Trim();
    }

    /// <summary>auto | openai | dashscope | sdwebui；缺省 auto 先探测 SD WebUI，再按 OpenAI 兼容处理。</summary>
    public string ImageProvider => GetString("IMAGE_PROVIDER", "auto").Trim();

    /// <summary>
    /// 图像服务是否已配置：只要求接口地址。
    /// SD WebUI 这类服务端自带模型，模型名称可以留空；其余协议的模型缺失由服务端报错兜底。
    /// </summary>
    public bool HasImageModel => ImageApiBase.Length > 0;

    private void LoadMcpServers()
    {
        McpServers.Clear();
        if (!_root.TryGetPropertyValue("MCP_SERVERS", out var node) || node is not JsonArray array) return;
        foreach (var item in array)
        {
            if (item is not JsonObject obj) continue;
            var name = obj.TryGetPropertyValue("name", out var n) ? n?.GetValue<string>() ?? "" : "";
            var command = obj.TryGetPropertyValue("command", out var c) ? c?.GetValue<string>() ?? "" : "";
            McpServers.Add(new McpServer { Name = name, Command = command });
        }
    }

    private void SaveMcpServers()
    {
        var array = new JsonArray();
        foreach (var server in McpServers)
            array.Add(new JsonObject { ["name"] = server.Name, ["command"] = server.Command });
        _root["MCP_SERVERS"] = array;
    }

    /// <summary>通知智能服务地址（backend/notification_service.py，由主程序拉起）。</summary>
    public const string NotificationApiBase = "http://127.0.0.1:8770";

    public async Task<JsonObject?> GetNotificationStatusAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var json = await http.GetStringAsync($"{NotificationApiBase}/api/status");
            return JsonNode.Parse(json) as JsonObject;
        }
        catch { return null; }
    }

    /// <summary>通知后端配置已保存（dony_app_api 的 /api/settings/reload）。</summary>
    public async Task NotifyBackendAsync()
    {
        try
        {
            var baseUrl = Environment.GetEnvironmentVariable("DONY_APP_API") ?? "http://127.0.0.1:8769";
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            using var resp = await http.PostAsync($"{baseUrl}/api/settings/reload", null);
            _ = resp;
        }
        catch { /* 接口尚未提供；忽略 */ }
    }
}
