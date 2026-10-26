namespace PhotoEditor.Services;

public enum PromptTask
{
    Erase,
    Outpaint,
    Reconstruct,
}

/// <summary>
/// 补全提示词模板。修图模型主要依据图像上下文工作，这里只保留固定描述，
/// 不再调用视觉模型撰写提示词。
/// </summary>
public static class PromptComposer
{
    /// <summary>固定模板，描述目标内容而非操作。</summary>
    public static string Fallback(PromptTask task) => task switch
    {
        PromptTask.Outpaint =>
            "the scene continues beyond the frame with the same materials, colours and lighting, "
            + "matching camera perspective and scale, photorealistic",
        PromptTask.Reconstruct =>
            "the surrounding floor and walls continue through the area with consistent materials, "
            + "aligned perspective and diffused daylight, photorealistic",
        _ =>
            "seamless continuation of the surrounding surface, matching texture, colour and lighting, "
            + "aligned perspective, photorealistic",
    };
}
