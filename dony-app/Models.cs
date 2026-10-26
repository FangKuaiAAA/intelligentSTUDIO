using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Dony;

public class SessionSummary
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("created_at")] public double CreatedAt { get; set; }
    [JsonPropertyName("updated_at")] public double UpdatedAt { get; set; }
    [JsonPropertyName("turn_count")] public int TurnCount { get; set; }
    [JsonPropertyName("preview")] public string Preview { get; set; } = "";

    public string UpdatedText => UpdatedAt <= 0
        ? ""
        : System.DateTimeOffset.FromUnixTimeSeconds((long)UpdatedAt).ToLocalTime()
            .ToString("MM-dd HH:mm");

    public string Subtitle => $"{UpdatedText} · {TurnCount} 条消息 · {Preview}";
}

public class CardDetail
{
    [JsonPropertyName("label")] public string Label { get; set; } = "";
    [JsonPropertyName("value")] public string Value { get; set; } = "";
}

public class CardExtra
{
    [JsonPropertyName("details")] public List<CardDetail> Details { get; set; } = new();
}

public class CardInfo
{
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("subtitle")] public string Subtitle { get; set; } = "";
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("extra")] public CardExtra? Extra { get; set; }

    /// <summary>副标题（有明细时把明细拼在后面，天气卡片也能看到降雨/风/湿度）。</summary>
    public string SubtitleWithDetails
    {
        get
        {
            var details = Extra?.Details;
            if (details is null || details.Count == 0) return Subtitle;
            var extra = string.Join(" · ", details.Select(d => $"{d.Label} {d.Value}"));
            return string.IsNullOrEmpty(Subtitle) ? extra : $"{Subtitle} · {extra}";
        }
    }
}

public class ChatTurn
{
    [JsonPropertyName("role")] public string Role { get; set; } = "";
    [JsonPropertyName("content")] public string Content { get; set; } = "";
    [JsonPropertyName("cards")] public List<CardInfo>? Cards { get; set; }
    /// <summary>这一轮 Dony 实际执行过的操作（一行一条）。</summary>
    [JsonPropertyName("operations")] public List<string>? Operations { get; set; }
}

public class SessionDetail
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("turns")] public List<ChatTurn> Turns { get; set; } = new();
}

public class VoiceOption
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
}

public class DriveInfo
{
    [JsonPropertyName("drive")] public string Drive { get; set; } = "";
    [JsonPropertyName("is_system")] public bool IsSystem { get; set; }
}

public class DonySettings
{
    [JsonPropertyName("tts_enabled")] public bool TtsEnabled { get; set; } = true;
    [JsonPropertyName("tts_always")] public bool TtsAlways { get; set; }
    [JsonPropertyName("tts_voice_only")] public bool TtsVoiceOnly { get; set; } = true;
    [JsonPropertyName("tts_voice")] public string TtsVoice { get; set; } = "";
    [JsonPropertyName("tts_voices")] public List<VoiceOption> Voices { get; set; } = new();
    [JsonPropertyName("tts_preview_text")] public string TtsPreviewText { get; set; } = "";
    [JsonPropertyName("allowed_paths")] public List<string> AllowedPaths { get; set; } = new();
    [JsonPropertyName("use_default_paths")] public bool UseDefaultPaths { get; set; } = true;
    [JsonPropertyName("allowed_drives")] public List<string> AllowedDrives { get; set; } = new();
    [JsonPropertyName("use_default_drives")] public bool UseDefaultDrives { get; set; } = true;
    [JsonPropertyName("drives")] public List<DriveInfo> Drives { get; set; } = new();
    [JsonPropertyName("system_drive")] public string SystemDrive { get; set; } = "";
    [JsonPropertyName("user_home")] public string UserHome { get; set; } = "";
    [JsonPropertyName("user_folders")] public Dictionary<string, string> UserFolders { get; set; } = new();
}

public class SettingsPatch
{
    [JsonPropertyName("tts_enabled")] public bool? TtsEnabled { get; set; }
    [JsonPropertyName("tts_always")] public bool? TtsAlways { get; set; }
    [JsonPropertyName("tts_voice_only")] public bool? TtsVoiceOnly { get; set; }
    [JsonPropertyName("tts_voice")] public string? TtsVoice { get; set; }
    [JsonPropertyName("allowed_paths")] public List<string>? AllowedPaths { get; set; }
    [JsonPropertyName("use_default_paths")] public bool? UseDefaultPaths { get; set; }
    [JsonPropertyName("allowed_drives")] public List<string>? AllowedDrives { get; set; }
    [JsonPropertyName("use_default_drives")] public bool? UseDefaultDrives { get; set; }
}

/// <summary>续聊过程事件（与主界面 Alt+Space 的协议一致，见后端 llm.py / app_chat.py）。</summary>
public class ChatEvent
{
    public string Type { get; set; } = "";
    public string Text { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>text-chunk 的流式增量文本。</summary>
    public string Delta { get; set; } = "";
    /// <summary>mode 事件：fast / task。</summary>
    public string Mode { get; set; } = "";
    /// <summary>ask 事件类型：confirm（是/否确认）或 question（模型反问，需输入）。</summary>
    public string Kind { get; set; } = "";
    /// <summary>ask 事件的 id，答复时回传。</summary>
    public string AskId { get; set; } = "";
    /// <summary>plan 事件的任务步骤。</summary>
    public List<string> Steps { get; set; } = new();
    /// <summary>error 事件的错误信息。</summary>
    public string Message { get; set; } = "";
    /// <summary>tool-end 事件：工具是否执行成功。</summary>
    public bool Ok { get; set; }
    /// <summary>tool-start 事件：这一步操作的人类可读描述（与历史记录里同一串文字）。</summary>
    [JsonPropertyName("op")] public string Op { get; set; } = "";
    public CardInfo? Card { get; set; }
    public List<CardInfo> Cards { get; set; } = new();
}
