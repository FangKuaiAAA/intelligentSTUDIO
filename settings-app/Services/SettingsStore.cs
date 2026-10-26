using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace DonySettings.Services;

/// <summary>MCP 服务器条目（写入配置文件的 MCP_SERVERS 数组，后端 agent/mcp.py 启动时读取并拉起）。</summary>
public sealed class McpServer
{
    public string Name { get; set; } = "";
    public string Command { get; set; } = "";
}

/// <summary>
/// 设置持久化：读写 intelligentSTUDIO 配置文件（.appx_config.json），与 backend/agent/config.py 使用同一数据源。
/// 主模型四项（OPENAI_API_BASE / OPENAI_API_KEY / OPENAI_MODEL / OPENAI_VISION_MODEL）为后端已读取的键；
/// 图像模型（IMAGE_*）与通知智能（SMART_DND_* / NOTIFY_*）为另有约定的键，
/// 保存后待后端接入即可直接读取。
/// </summary>
public sealed class SettingsStore
{
    public static SettingsStore Instance { get; } = new();

    /// <summary>intelligentSTUDIO 仓库根目录；找不到时为 null（设置改存用户目录）。</summary>
    public string? RepoRoot { get; }

    /// <summary>配置文件完整路径。</summary>
    public string ConfigPath { get; }

    /// <summary>MCP 服务器列表（编辑后调用 Save 持久化）。</summary>
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
            ConfigPath = Path.Combine(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "IntelligentStudio"),
                "config.json");
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

    /// <summary>写回配置文件（保留未识别的键）。</summary>
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

    /// <summary>读取通知服务状态；服务未启动时返回 null，由页面显示为未知。</summary>
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
    /// TTS/路径即时生效；MCP 与 Skill 目录在进程启动时加载，需重启 Dony；接口不可达时忽略。</summary>
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
