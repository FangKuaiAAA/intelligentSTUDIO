using System;
using System.Collections.Generic;
using System.Numerics;
using ImagePlayground.Services;
using Microsoft.UI;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.UI;

namespace ImagePlayground.Controls;

/// <summary>
/// 中央画布：白色磨砂大圆 → 生成中的蓝色进度条 + 呼吸的彩色光边 → 扩为圆角方形展示结果。
///
/// 光边与输入框同一套逻辑，只是半径更大：逐层同心圆、浓度 100% → 0 线性衰减、
/// 整圈同一颜色缓慢换色，再叠加呼吸灯（透明度与尺寸同步涨落）。
/// 圆到方的形变靠 CompositionRoundedRectangleGeometry 的 Size/Offset/CornerRadius 关键帧动画。
/// </summary>
public sealed partial class CanvasOrb : UserControl
{
    private const double ExpandRatio = 4.0 / 3.0;
    private const double BaseDiameter = 420;

    private Compositor? _comp;
    private ContainerVisual? _edgeRoot;
    private ContainerVisual? _edgeFade;
    private CompositionRoundedRectangleGeometry? _clipGeometry;
    private Visual? _resultVisual;

    private double _diameter = BaseDiameter;
    private double _expanded = Math.Round(BaseDiameter * ExpandRatio);

    public CanvasOrb()
    {
        InitializeComponent();
        Loaded += OnLoaded;

        ShareButton.Click += (_, _) => ShareRequested?.Invoke(this, EventArgs.Empty);
        SaveButton.Click += (_, _) => SaveRequested?.Invoke(this, EventArgs.Empty);
        RetryButton.Click += (_, _) => RetryRequested?.Invoke(this, EventArgs.Empty);
        OpenSettingsButton.Click += (_, _) => SettingsLauncher.TryOpen();
    }

    public event EventHandler? ShareRequested;
    public event EventHandler? SaveRequested;
    public event EventHandler? RetryRequested;

    public bool HasResult { get; private set; }

    public string? ResultPath { get; private set; }

    /// <summary>分享菜单的锚点（空状态下也指向不存在的按钮时退回整个控件）。</summary>
    public FrameworkElement ShareAnchor => ActionPanel.Visibility == Visibility.Visible ? ShareButton : this;

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_comp is not null) return;
        _comp = ElementCompositionPreview.GetElementVisual(Stage).Compositor;

        _resultVisual = ElementCompositionPreview.GetElementVisual(ResultHost);
        _clipGeometry = _comp.CreateRoundedRectangleGeometry();
        _resultVisual.Clip = _comp.CreateGeometricClip(_clipGeometry);
        ResetClip();

        _edgeRoot = _comp.CreateContainerVisual();
        ElementCompositionPreview.SetElementChildVisual(EdgeHost, _edgeRoot);
        _edgeFade = _comp.CreateContainerVisual();
        _edgeFade.Opacity = 0f;
        _edgeRoot.Children.InsertAtTop(_edgeFade);

        ApplySizes();
    }

    /// <summary>页面按可用高度设置圆直径（结果方形 = 直径 × 4/3）。</summary>
    public void SetDiameter(double diameter)
    {
        if (diameter < 240) diameter = 240;
        if (diameter > BaseDiameter) diameter = BaseDiameter;
        if (Math.Abs(diameter - _diameter) < 1) return;
        _diameter = Math.Round(diameter);
        _expanded = Math.Round(_diameter * ExpandRatio);
        if (_comp is not null) ApplySizes();
    }

    private void ApplySizes()
    {
        Root.Width = Root.Height = _expanded;
        Stage.Width = Stage.Height = _expanded;

        CircleShadow.Width = CircleShadow.Height = _diameter;
        CircleShadow.CornerRadius = new CornerRadius(_diameter / 2);

        ShadowPool.Width = ShadowPool.Height = _diameter * 1.24;

        CircleLayer.Width = CircleLayer.Height = _diameter;

        Surface.Width = Surface.Height = _expanded;
        Surface.CornerRadius = new CornerRadius(_expanded * 0.0714);

        ResultHost.Width = ResultHost.Height = _expanded;
        ResultImage.Width = ResultImage.Height = _expanded;

        if (!HasResult) ResetClip();
        BuildEdgeRings();
    }

    private void ResetClip()
    {
        if (_clipGeometry is null) return;
        _clipGeometry.StopAnimation("Size");
        _clipGeometry.StopAnimation("Offset");
        _clipGeometry.StopAnimation("CornerRadius");
        _clipGeometry.Size = new Vector2((float)_diameter, (float)_diameter);
        _clipGeometry.Offset = new Vector2((float)((_expanded - _diameter) / 2), (float)((_expanded - _diameter) / 2));
        _clipGeometry.CornerRadius = new Vector2((float)_diameter / 2, (float)_diameter / 2);
    }

    // ---------- 光边 ----------
    /// <summary>
    /// 与输入框同一套光晕逻辑，只是半径更大：逐层外扩、浓度 100% → 0 线性衰减、
    /// 整圈同一颜色缓慢换色；再叠一层呼吸灯（透明度与尺寸同步轻微涨落）。
    /// </summary>
    private void BuildEdgeRings()
    {
        if (_comp is null || _edgeFade is null) return;
        _edgeFade.Children.RemoveAll();

        var size = (float)_expanded;
        var center = new Vector2(size / 2f, size / 2f);
        var baseRadius = (float)_diameter / 2f;

        var holder = _comp.CreateContainerVisual();
        holder.Size = new Vector2(size, size);
        holder.CenterPoint = new Vector3(center.X, center.Y, 0f);

        var shapes = _comp.CreateShapeVisual();
        shapes.Size = new Vector2(size, size);

        // 与输入框同一套参数：逐层透明度反解，叠加后从 80% 线性降到 0，只是围着更大的圆
        const int ringCount = 16;
        const float spacing = 0.65f;
        var alphas = RainbowPalette.LayerAlphas(ringCount, 0.8f);

        for (var i = 1; i <= ringCount; i++)
        {
            var radius = baseRadius + i * spacing;
            var alpha = alphas[i - 1];

            var geometry = _comp.CreateEllipseGeometry();
            geometry.Center = center;
            geometry.Radius = new Vector2(radius, radius);

            var shape = _comp.CreateSpriteShape(geometry);
            var brush = _comp.CreateColorBrush(RainbowPalette.At(0f, alpha));
            shape.FillBrush = brush;
            shapes.Shapes.Add(shape);

            StartColorCycle(brush, alpha);
        }

        holder.Children.InsertAtTop(shapes);
        _edgeFade.Children.InsertAtTop(holder);

        StartBreathing(holder);
        _edgeRoot!.Size = new Vector2(size, size);
        _edgeFade.Size = new Vector2(size, size);
    }

    /// <summary>整圈同一颜色，与输入框共用节奏：每种颜色 5 秒，一圈 25 秒。</summary>
    private void StartColorCycle(CompositionColorBrush brush, float alpha)
    {
        if (_comp is null) return;
        try
        {
            const int steps = 5;
            var anim = _comp.CreateColorKeyFrameAnimation();
            for (var i = 0; i <= steps; i++)
                anim.InsertKeyFrame(i / (float)steps, RainbowPalette.At(i / (float)steps, alpha));

            anim.Duration = TimeSpan.FromSeconds(RainbowPalette.ColorCycleSeconds);
            anim.IterationBehavior = AnimationIterationBehavior.Forever;
            brush.StartAnimation(nameof(CompositionColorBrush.Color), anim);
        }
        catch { /* 忽略 */ }
    }

    /// <summary>
    /// 呼吸灯：6 秒一个周期。取值按余弦采样（0 → 峰 → 0，两端速度为零），
    /// 因此放大与缩小之间是连续过渡，不会在最高点出现折角。
    /// </summary>
    private void StartBreathing(ContainerVisual visual)
    {
        if (_comp is null) return;
        try
        {
            var seconds = RainbowPalette.BreathSeconds;

            var opacity = _comp.CreateScalarKeyFrameAnimation();
            var scale = _comp.CreateVector3KeyFrameAnimation();

            const int steps = 24;
            for (var i = 0; i <= steps; i++)
            {
                var t = i / (float)steps;
                var wave = 0.5f - 0.5f * MathF.Cos(t * MathF.PI * 2f);   // 0 → 1 → 0

                opacity.InsertKeyFrame(t, 0.45f + 0.55f * wave);

                var s = 1f + 0.07f * wave;
                scale.InsertKeyFrame(t, new Vector3(s, s, 1f));
            }

            opacity.Duration = TimeSpan.FromSeconds(seconds);
            opacity.IterationBehavior = AnimationIterationBehavior.Forever;
            scale.Duration = TimeSpan.FromSeconds(seconds);
            scale.IterationBehavior = AnimationIterationBehavior.Forever;

            visual.StartAnimation(nameof(Visual.Opacity), opacity);
            visual.StartAnimation("Scale", scale);
        }
        catch { /* 忽略 */ }
    }

    private void ShowEdge()
    {
        if (_edgeFade is null) return;
        FadeVisual(_edgeFade, 1f, 520);
    }

    private void HideEdge()
    {
        if (_edgeFade is null) return;
        FadeVisual(_edgeFade, 0f, 380);
    }

    // ---------- 对外状态 ----------
    public void ShowIdle()
    {
        HideError();
        HideProgress();
        HideEdge();
        HideActions();
        HideResult();
        Fade(ShadowPool, 1, 300);
        ShowEmptyHint();
    }

    public void BeginGenerating()
    {
        HideError();
        HideActions();
        HideResult();
        HideEmptyHint();
        Fade(ShadowPool, 1, 300);

        ProgressPanel.Visibility = Visibility.Visible;
        Fade(ProgressPanel, 1, 240);
        SetProgress(0.02);
        ShowEdge();
    }

    public void SetProgress(double value)
    {
        value = Math.Clamp(value, 0, 1);
        var story = new Storyboard();
        var anim = new DoubleAnimation
        {
            To = value,
            Duration = TimeSpan.FromMilliseconds(380),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(anim, ProgressScale);
        Storyboard.SetTargetProperty(anim, "ScaleX");
        story.Children.Add(anim);
        story.Begin();
    }

    public void Complete(string imagePath)
    {
        HasResult = true;
        ResultPath = imagePath;

        HideProgress();
        HideEdge();
        HideError();

        try
        {
            ResultImage.Source = new BitmapImage(new Uri(imagePath));
        }
        catch (Exception ex)
        {
            AppLog.Write("结果图加载失败", ex.GetType().Name);
        }

        ResetClip();
        ResultHost.Visibility = Visibility.Visible;
        ResultHost.Opacity = 0;
        Fade(ResultHost, 1, 220);
        AnimateExpand();
        Fade(ShadowPool, 0.35, 460);
        ShowActions();
    }

    public void Fail(string message, bool configurationError)
    {
        // 先收起旧结果（HideResult 内部会重置 HasResult），再显示错误，顺序不能反
        HideResult();
        HasResult = false;
        ResultPath = null;
        HideProgress();
        HideEdge();
        HideActions();
        HideEmptyHint();
        ShowError(message, configurationError);
    }

    private void AnimateExpand()
    {
        if (_comp is null || _clipGeometry is null) return;
        try
        {
            var ease = _comp.CreateCubicBezierEasingFunction(new Vector2(0.22f, 1f), new Vector2(0.36f, 1f));
            var duration = TimeSpan.FromMilliseconds(480);

            var sizeAnim = _comp.CreateVector2KeyFrameAnimation();
            sizeAnim.InsertKeyFrame(0f, new Vector2((float)_diameter, (float)_diameter));
            sizeAnim.InsertKeyFrame(1f, new Vector2((float)_expanded, (float)_expanded), ease);
            sizeAnim.Duration = duration;

            var offsetAnim = _comp.CreateVector2KeyFrameAnimation();
            offsetAnim.InsertKeyFrame(0f, new Vector2((float)((_expanded - _diameter) / 2), (float)((_expanded - _diameter) / 2)));
            offsetAnim.InsertKeyFrame(1f, Vector2.Zero, ease);
            offsetAnim.Duration = duration;

            var radiusAnim = _comp.CreateVector2KeyFrameAnimation();
            radiusAnim.InsertKeyFrame(0f, new Vector2((float)_diameter / 2, (float)_diameter / 2));
            radiusAnim.InsertKeyFrame(1f, new Vector2((float)(_expanded * 0.0714), (float)(_expanded * 0.0714)), ease);
            radiusAnim.Duration = duration;

            _clipGeometry.StartAnimation("Size", sizeAnim);
            _clipGeometry.StartAnimation("Offset", offsetAnim);
            _clipGeometry.StartAnimation("CornerRadius", radiusAnim);
        }
        catch
        {
            _clipGeometry.Size = new Vector2((float)_expanded, (float)_expanded);
            _clipGeometry.Offset = Vector2.Zero;
            _clipGeometry.CornerRadius = new Vector2((float)(_expanded * 0.0714), (float)(_expanded * 0.0714));
        }
    }

    private void HideResult()
    {
        if (!HasResult)
        {
            ResultHost.Visibility = Visibility.Collapsed;
            return;
        }

        HasResult = false;
        ResultPath = null;
        Fade(ResultHost, 0, 190, () =>
        {
            ResultHost.Visibility = Visibility.Collapsed;
            ResultImage.Source = null;
            ResetClip();
        });
    }

    private void ShowEmptyHint()
    {
        EmptyHint.Visibility = Visibility.Visible;
        Fade(EmptyHint, 1, 260);
    }

    private void HideEmptyHint()
    {
        if (EmptyHint.Visibility != Visibility.Visible) return;
        Fade(EmptyHint, 0, 180, () => EmptyHint.Visibility = Visibility.Collapsed);
    }

    private void ShowError(string message, bool configurationError)
    {
        ErrorText.Text = message;
        OpenSettingsButton.Visibility = configurationError ? Visibility.Visible : Visibility.Collapsed;
        ErrorPanel.Visibility = Visibility.Visible;
        Fade(ErrorPanel, 1, 240);
    }

    private void HideError()
    {
        if (ErrorPanel.Visibility != Visibility.Visible) return;
        Fade(ErrorPanel, 0, 180, () => ErrorPanel.Visibility = Visibility.Collapsed);
    }

    private void HideProgress()
    {
        if (ProgressPanel.Visibility != Visibility.Visible) return;
        Fade(ProgressPanel, 0, 180, () => ProgressPanel.Visibility = Visibility.Collapsed);
    }

    private void ShowActions()
    {
        ActionPanel.IsHitTestVisible = true;
        Fade(ActionPanel, 1, 280);
        var story = new Storyboard();
        var slide = new DoubleAnimation
        {
            To = 0,
            Duration = TimeSpan.FromMilliseconds(320),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(slide, ActionShift);
        Storyboard.SetTargetProperty(slide, "X");
        story.Children.Add(slide);
        story.Begin();
    }

    private void HideActions()
    {
        ActionPanel.IsHitTestVisible = false;
        if (ActionPanel.Opacity <= 0.01) return;
        Fade(ActionPanel, 0, 180);
        ActionShift.X = 12;
    }

    // ---------- 动画小工具 ----------
    private static void Fade(UIElement element, double to, double milliseconds, Action? completed = null)
    {
        var story = new Storyboard();
        var anim = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(anim, element);
        Storyboard.SetTargetProperty(anim, "Opacity");
        story.Children.Add(anim);
        if (completed is not null) story.Completed += (_, _) => completed();
        story.Begin();
    }

    private static void FadeVisual(Visual visual, float to, double milliseconds)
    {
        try
        {
            var comp = visual.Compositor;
            var anim = comp.CreateScalarKeyFrameAnimation();
            anim.InsertKeyFrame(1f, to,
                comp.CreateCubicBezierEasingFunction(new Vector2(0.16f, 1f), new Vector2(0.3f, 1f)));
            anim.Duration = TimeSpan.FromMilliseconds(milliseconds);
            visual.StartAnimation(nameof(Visual.Opacity), anim);
        }
        catch { /* 忽略 */ }
    }
}
