using System.Collections.Generic;

namespace IntelligentStudio.Onboarding.Services;

/// <summary>媒体呈现方式：框内（圆角卡片、四周留白）或无框（上、左、右延伸到窗口边缘）。</summary>
public enum StepMediaKind
{
    None,
    FramedImage,
    FramedVideo,
    FullImage,
    FullVideo,
}

/// <summary>该页要提供的选项组。</summary>
public enum StepOptions
{
    None,
    /// <summary>关闭 / 始终朗读回复 / 仅在语音使用 Dony 时朗读回复。</summary>
    VoiceRead,
    /// <summary>双击 Ctrl 启动书写辅助。</summary>
    WritingDoubleCtrl,
    /// <summary>通知智能与智能勿扰模式。</summary>
    Notifications,
}

/// <summary>扩展安装目标。</summary>
public enum InstallTarget
{
    None,
    Edge,
    Office,
}

public enum StepKind
{
    /// <summary>媒体 + 图标标题介绍 + 可选选项。</summary>
    Media,
    /// <summary>四组模型配置。</summary>
    Models,
    /// <summary>欢迎页与「完成」。</summary>
    Welcome,
}

public sealed class OnboardingStep
{
    public StepKind Kind { get; init; } = StepKind.Media;
    public string Title { get; init; } = "";
    public string Description { get; init; } = "";
    /// <summary>输出目录下的 ico 文件名（由 csproj 从 assets\icons 复制）。</summary>
    public string IconFile { get; init; } = "intelligentSTUDIO.ico";
    public StepMediaKind MediaKind { get; init; } = StepMediaKind.None;
    /// <summary>assets\onboarding 下的文件名；为空表示该页没有媒体。</summary>
    public string? MediaFile { get; init; }
    public StepOptions Options { get; init; } = StepOptions.None;
    public InstallTarget Install { get; init; } = InstallTarget.None;
    /// <summary>首页在顶部居中放一枚大图标。</summary>
    public bool ShowHero { get; init; }
}

/// <summary>11 页引导的全部文案与配置。文案为书面语、动词开头，流程用词统一为「继续 / 上一步 / 完成」。</summary>
public static class StepCatalog
{
    public static IReadOnlyList<OnboardingStep> Create() => new[]
    {
        new OnboardingStep
        {
            Kind = StepKind.Media,
            ShowHero = true,
            Title = "intelligentSTUDIO",
            Description = "更好，更高级美观的类Windows系统级人工智能，兼容几乎所有现代Windows电脑（Windows10 21H2+，Windows11，需要显卡支持DirectX12）。",
        },
        new OnboardingStep
        {
            Title = "Dony",
            Description = "按 Alt+Space 唤醒，键入或说话提问，也可以让它代为操作电脑完成任务。对话记录保存在「Dony 对话」。",
            IconFile = "Dony.ico",
            MediaKind = StepMediaKind.FramedImage,
            MediaFile = "dony.png",
            Options = StepOptions.VoiceRead,
        },
        new OnboardingStep
        {
            Title = "视觉智能",
            Description = "按 Alt+V 框选屏幕区域，选择理解内容、翻译、提取文字、识别物体或搜索物体，回答显示在选区旁边。",
            IconFile = "视觉智能.ico",
            MediaKind = StepMediaKind.FullVideo,
            MediaFile = "visual.mp4",
        },
        new OnboardingStep
        {
            Title = "书写辅助",
            Description = "选中文字后打开写作工具，校对、重写、调整语气，或归纳为表格。改写结果直接替换原文，可随时恢复。",
            IconFile = "书写辅助.ico",
            MediaKind = StepMediaKind.FullVideo,
            MediaFile = "writing.mp4",
            Options = StepOptions.WritingDoubleCtrl,
        },
        new OnboardingStep
        {
            Title = "通知智能",
            Description = "同一应用的多条通知合并为一条摘要。开启智能勿扰模式后，仅重要通知弹出提醒。",
            IconFile = "intelligentSTUDIO.ico",
            MediaKind = StepMediaKind.FramedImage,
            MediaFile = "notifications.png",
            Options = StepOptions.Notifications,
        },
        new OnboardingStep
        {
            Title = "照片编辑器",
            Description = "打开或拖入照片，裁剪构图、添加滤镜、消除多余内容、扩展画面，或重构照片。",
            IconFile = "照片智能编辑器.ico",
            MediaKind = StepMediaKind.FullVideo,
            MediaFile = "photo.mp4",
        },
        new OnboardingStep
        {
            Title = "图乐园",
            Description = "选择元素或导入照片，输入提示词并选择风格，生成图片。历史记录保留每次生成的结果。",
            IconFile = "图乐园.ico",
            MediaKind = StepMediaKind.FullImage,
            MediaFile = "playground.png",
        },
        new OnboardingStep
        {
            Title = "在浏览器中使用视觉智能",
            Description = "在 Edge 中框选网页内容，直接理解、翻译或提取文字；也可以整理标签页、收藏夹与书签。",
            IconFile = "视觉智能.ico",
            Install = InstallTarget.Edge,
        },
        new OnboardingStep
        {
            Title = "在 Office 中使用书写辅助和图乐园",
            Description = "在 Word、Excel 和 PowerPoint 中使用书写辅助与图乐园：改写文档内容，或依据上下文插入图片。",
            IconFile = "书写辅助.ico",
            Install = InstallTarget.Office,
        },
        new OnboardingStep
        {
            Kind = StepKind.Models,
            Title = "模型配置",
            Description = "填写接口地址、API 密钥与模型名称。留空的项沿用上一组配置。",
        },
        new OnboardingStep
        {
            Kind = StepKind.Welcome,
            Title = "欢迎使用 intelligentSTUDIO",
            Description = "设置已完成。可以随时在 STUDIO 设置中调整。",
            IconFile = "intelligentSTUDIO.ico",
            ShowHero = true,
        },
    };
}
