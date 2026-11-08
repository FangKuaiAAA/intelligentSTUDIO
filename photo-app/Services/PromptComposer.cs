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
            // 扩展：把画面外侧那块模糊/空白区域**填充补全**，只延续已有背景。
            // 不加限制时模型会在空白区脑补出新的主体（人物/动物/器物），
            // 看起来像画面里凭空多了一坨东西。
            "fill in the blank, blurred margins outside the original frame so they blend seamlessly "
            + "with the photo; continue only the existing background — the same ground, water, "
            + "foliage and sky, keeping materials, colours, lighting, perspective and scale consistent; "
            + "do NOT add any new object, person, animal, vehicle or product; "
            + "no text, no watermark, no vignette, photorealistic",
        PromptTask.Reconstruct =>
            "the surrounding floor and walls continue through the area with consistent materials, "
            + "aligned perspective and diffused daylight, photorealistic",
        _ =>
            "seamless continuation of the surrounding surface, matching texture, colour and lighting, "
            + "aligned perspective, photorealistic",
    };
}
