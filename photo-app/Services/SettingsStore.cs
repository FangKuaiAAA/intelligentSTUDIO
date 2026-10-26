using System;
using System.IO;
using System.Text.Json.Nodes;

namespace PhotoEditor.Services;

/// <summary>
/// 设置读取：与 STUDIO 设置 APP、backend/agent/config.py 共用 .appx_config.json。
/// 照片编辑器只读图像模型的四项配置，不写入任何键。
/// </summary>
public sealed class SettingsStore
{
    public static SettingsStore Instance { get; } = new();

    public string? RepoRoot { get; }
    public string ConfigPath { get; }

    private readonly JsonObject _root;

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
    }

    private static string? FindRepoRoot()
    {
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
        catch { /* 配置损坏时按空配置处理，不覆盖原文件 */ }
        return new JsonObject();
    }

    public string GetString(string key, string fallback = "") =>
        _root.TryGetPropertyValue(key, out var node)
            && node is JsonValue value
            && value.TryGetValue<string>(out var s)
            ? s : fallback;

    // ---------- 图像模型（与图乐园共用，只读） ----------

    // 留空时跟随主模型（OPENAI_*）；编辑模型再回落到图像模型
    public string ImageApiBase => Fallback("IMAGE_API_BASE", "OPENAI_API_BASE");

    public string ImageApiKey => Fallback("IMAGE_API_KEY", "OPENAI_API_KEY");

    public string ImageModel => Fallback("IMAGE_MODEL", "OPENAI_MODEL");

    private string Fallback(string key, string masterKey)
    {
        var v = GetString(key).Trim();
        return v.Length > 0 ? v : GetString(masterKey).Trim();
    }

    /// <summary>auto | openai | dashscope。</summary>
    public string ImageProvider => GetString("IMAGE_PROVIDER", "auto").Trim();

    public bool HasImageModel => ImageApiBase.Length > 0;

    // ---------- 编辑模型（照片编辑器的补全，独立于图像模型） ----------
    // 未单独配置时回落到图像模型，保证旧配置继续可用。

    public string EditApiBase => GetString("EDIT_API_BASE", ImageApiBase).Trim();

    public string EditApiKey => GetString("EDIT_API_KEY", ImageApiKey).Trim();

    public string EditModel => GetString("EDIT_MODEL", ImageModel).Trim();

    /// <summary>auto | filledit | openai | dashscope。</summary>
    public string EditProvider => GetString("EDIT_PROVIDER", ImageProvider).Trim();

    public bool HasEditModel => EditApiBase.Length > 0;

    // ---------- 主模型（用于撰写修复提示词，只读） ----------

    public string ChatApiBase => GetString("OPENAI_API_BASE").Trim();

    public string ChatApiKey => GetString("OPENAI_API_KEY").Trim();

    public string ChatModel => GetString("OPENAI_MODEL").Trim();

    public string ChatVisionModel => GetString("OPENAI_VISION_MODEL").Trim();

    public bool HasChatModel => ChatApiBase.Length > 0 && ChatModel.Length > 0;
}
