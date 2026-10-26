using System;

namespace IntelligentStudio.Onboarding.Services;

/// <summary>
/// 窗口与媒体版式常量。媒体统一 16:9：无框媒体满窗宽，框内媒体左右各留 32。
/// 小屏幕放不下整幅 16:9 时按内容区高度收缩（画面等比裁切，宽度不变）。
/// </summary>
public static class LayoutMetrics
{
    public const double WindowWidth = 980;
    public const double WindowHeight = 860;
    public const double FooterHeight = 60;

    /// <summary>无框媒体宽度：贴住窗口左右边缘。</summary>
    public const double FullMediaWidth = WindowWidth;

    /// <summary>框内媒体宽度：窗口左右各留 32。</summary>
    public const double FramedMediaWidth = WindowWidth - 64;

    /// <summary>无框页为标题介绍与选项预留的高度。</summary>
    private const double FullTextReserve = 190;

    /// <summary>框内页为标题介绍与选项预留的高度（含上下边距 34）。</summary>
    private const double FramedTextReserve = 250;

    public static double FullMediaHeight { get; private set; } = FullMediaWidth * 9 / 16;

    public static double FramedMediaHeight { get; private set; } = FramedMediaWidth * 9 / 16;

    /// <summary>按内容区实际高度收缩媒体，保证标题介绍与选项留在窗口内。</summary>
    public static void ApplyContentHeight(double contentHeight)
    {
        FullMediaHeight = Math.Clamp(
            FullMediaWidth * 9 / 16, 240, Math.Max(240, contentHeight - FullTextReserve));
        FramedMediaHeight = Math.Clamp(
            FramedMediaWidth * 9 / 16, 200, Math.Max(200, contentHeight - FramedTextReserve));
    }
}
