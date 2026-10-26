using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Animation;

namespace PhotoEditor.Controls;

/// <summary>
/// 生成进度：两层 4px 圆角条 + 阶段文字，不显示百分比。
/// 进度由调用方按服务端阶段推进，动画只负责把刻度平滑过去，避免跳动。
/// </summary>
public sealed partial class RainbowProgressBar : UserControl
{
    private Storyboard? _story;
    private double _target;

    public RainbowProgressBar()
    {
        InitializeComponent();
    }

    /// <summary>显示并进入工作态；文字由调用方随后更新。</summary>
    public void Begin(string text)
    {
        Label.Text = text;
        Fade(1);
        SetProgress(0.04);
    }

    public void SetText(string text) => Label.Text = text;

    /// <summary>推进到目标刻度（0..1）。低位刻度保持明显推进感，末尾留白等待最终结果。</summary>
    public void SetProgress(double value)
    {
        _target = Math.Clamp(value, 0, 0.94);
        AnimateTo(_target);
    }

    public void Complete()
    {
        _target = 1;
        AnimateTo(1, 260);
    }

    public void Hide() => Fade(0);

    private void AnimateTo(double value, int durationMs = 420)
    {
        // Stop() 会把 ScaleX 恢复到动画前的值，必须在停止前记下当前刻度，
        // 否则每次推进都从 0 重新跑到目标，看起来像进度反复重来。
        var current = FillScale.ScaleX;
        _story?.Stop();
        FillScale.ScaleX = current;

        var animation = new DoubleAnimation
        {
            From = current,
            To = value,
            Duration = TimeSpan.FromMilliseconds(durationMs),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            EnableDependentAnimation = true,
        };
        Storyboard.SetTarget(animation, FillScale);
        Storyboard.SetTargetProperty(animation, "ScaleX");

        _story = new Storyboard();
        _story.Children.Add(animation);
        _story.Begin();
    }

    private void Fade(double to)
    {
        var animation = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(220),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(animation, Root);
        Storyboard.SetTargetProperty(animation, "Opacity");

        var story = new Storyboard();
        story.Children.Add(animation);
        story.Begin();
    }
}
