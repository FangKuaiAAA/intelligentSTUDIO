using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace IntelligentStudio.Onboarding.Services;

/// <summary>Dony 朗读回复的三种模式。</summary>
public enum VoiceReadMode
{
    /// <summary>关闭：不朗读回复。</summary>
    Off,
    /// <summary>始终朗读回复：键入模式也朗读。</summary>
    Always,
    /// <summary>仅在语音使用 Dony 时朗读回复。</summary>
    VoiceOnly,
}

/// <summary>
/// Dony 语音设置的落盘位置是 %APPDATA%\Dony\settings.json（backend/agent/store.py 与
/// backend/dony_app_api.py 共用）。首次启动时 Dony 主程序未必在运行，不能走 8769 接口，
/// 因此这里直接原子写入同一份文件，并保留未识别的键。
/// 语义与后端一致：两个朗读开关任一开启即 tts_enabled=true；tts_always 开启时
/// tts_voice_only 已无意义，一并置为 false。
/// </summary>
public static class DonyVoiceSettings
{
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    private static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Dony", "settings.json");

    public static VoiceReadMode Read()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return VoiceReadMode.VoiceOnly;
            var root = JsonNode.Parse(File.ReadAllText(SettingsPath)) as JsonObject;
            if (root is null) return VoiceReadMode.VoiceOnly;

            var enabled = ReadBool(root, "tts_enabled", true);
            if (!enabled) return VoiceReadMode.Off;
            return ReadBool(root, "tts_always", false) ? VoiceReadMode.Always : VoiceReadMode.VoiceOnly;
        }
        catch
        {
            // 文件损坏或正被写入：按 Dony 的默认行为呈现（仅语音模式朗读）
            return VoiceReadMode.VoiceOnly;
        }
    }

    public static void Write(VoiceReadMode mode)
    {
        var root = Load();
        root["tts_enabled"] = mode != VoiceReadMode.Off;
        root["tts_always"] = mode == VoiceReadMode.Always;
        root["tts_voice_only"] = mode == VoiceReadMode.VoiceOnly;
        Save(root);
    }

    private static JsonObject Load()
    {
        try
        {
            if (File.Exists(SettingsPath))
                return JsonNode.Parse(File.ReadAllText(SettingsPath)) as JsonObject ?? new JsonObject();
        }
        catch { /* 损坏时以空白对象重写，保留不了的内容按默认值补齐 */ }
        return new JsonObject();
    }

    /// <summary>临时文件 + 覆盖：后端按修改时间热加载，不能让它读到半截 JSON。</summary>
    private static void Save(JsonObject root)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
        var temp = SettingsPath + ".onboarding.tmp";
        File.WriteAllText(temp, root.ToJsonString(JsonOpts));
        File.Move(temp, SettingsPath, overwrite: true);
    }

    private static bool ReadBool(JsonObject root, string key, bool fallback) =>
        root[key] is JsonValue value && value.TryGetValue<bool>(out var result) ? result : fallback;
}
