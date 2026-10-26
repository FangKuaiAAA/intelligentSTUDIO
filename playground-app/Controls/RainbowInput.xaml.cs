using System;
using System.Collections.Generic;
using System.Numerics;
using ImagePlayground.Models;
using ImagePlayground.Services;
using Microsoft.UI;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Windows.System;
using Windows.UI;

namespace ImagePlayground.Controls;

/// <summary>
/// 彩虹输入框：标准 WinUI 矩形输入框，背后叠 5 层圆角矩形彩虹，由内向外逐层变暗并轻微游移，
/// 形成向外渐变消散的绒毛感。聚焦或有内容时 1 秒淡入，失焦且为空时 1 秒淡出。
/// WinUI3 没有 conic-gradient 与高斯模糊，这里用 5 层不同周期、不同旋向的线性渐变叠加近似。
/// </summary>
public sealed partial class RainbowInput : UserControl
{
    private sealed class RainbowLayer
    {
        public ShapeVisual Visual = null!;
        public CompositionRoundedRectangleGeometry Geometry = null!;
        public CompositionSpriteShape Shape = null!;
        public float Inset;
    }

    private readonly List<RainbowLayer> _layers = new();
    private Compositor? _comp;
    private ContainerVisual? _host;
    private bool _ready;
    private bool _deleteButtonHidden;
    private double _lastW, _lastH, _lastShellW, _lastShellH;

    public RainbowInput()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        SizeChanged += (_, _) => UpdateGeometry();
    }

    public event EventHandler<string>? Submitted;

    public string Text
    {
        get => Input.Text;
        set
        {
            Input.Text = value ?? "";
            Input.SelectionStart = Input.Text.Length;
        }
    }

    public string Placeholder
    {
        get => Input.PlaceholderText;
        set => Input.PlaceholderText = value;
    }

    public void FocusInput() => Input.Focus(FocusState.Programmatic);

    /// <summary>生成开始时淡出彩虹（1 秒）。</summary>
    public void FadeRainbow() => SetRainbowVisible(false);

    public void SetRainbowVisible(bool visible, double seconds = 1.0)
    {
        if (_comp is null || _host is null) return;
        try
        {
            var anim = _comp.CreateScalarKeyFrameAnimation();
            anim.InsertKeyFrame(1f, visible ? 1f : 0f,
                _comp.CreateCubicBezierEasingFunction(new Vector2(0.33f, 0f), new Vector2(0.2f, 1f)));
            anim.Duration = TimeSpan.FromSeconds(seconds);
            _host.StartAnimation(nameof(Visual.Opacity), anim);
        }
        catch { /* 忽略 */ }
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        SetupComposition();
        UpdateGeometry();
        UpdateGlow();
        HideClearButton();
    }

    /// <summary>
    /// 折叠 TextBox 模板自带的清除按钮：它与右侧发送箭头位置重合，且本控件只保留一个出口。
    /// 模板在首次布局后才有实体，因此放在 Loaded 与首次文本变化时各检查一次。
    /// </summary>
    private void HideClearButton()
    {
        if (_deleteButtonHidden) return;
        try
        {
            var button = FindDescendant<Button>(Input, "DeleteButton");
            if (button is null) return;

            // 注意：模板的视觉状态会强制把 Visibility 改回 Visible，
            // 因此这里同时把尺寸压到 0 并隐藏不透明度，视觉状态无法覆盖这两项。
            button.Visibility = Visibility.Collapsed;
            button.Opacity = 0;
            button.Width = 0;
            button.MinWidth = 0;
            button.Padding = new Thickness(0);
            button.Margin = new Thickness(0);
            button.IsHitTestVisible = false;
            button.IsTabStop = false;
            _deleteButtonHidden = true;
        }
        catch { /* 模板差异时忽略 */ }
    }

    private static T? FindDescendant<T>(DependencyObject root, string name) where T : FrameworkElement
    {
        var count = VisualTreeHelper.GetChildrenCount(root);
        for (var i = 0; i < count; i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is T typed && typed.Name == name) return typed;

            var found = FindDescendant<T>(child, name);
            if (found is not null) return found;
        }
        return null;
    }

    private void SetupComposition()
    {
        if (_comp is not null) return;
        _comp = ElementCompositionPreview.GetElementVisual(GlowHost).Compositor;

        _host = _comp.CreateContainerVisual();
        _host.Opacity = 0f;
        ElementCompositionPreview.SetElementChildVisual(GlowHost, _host);

        // 多层透明度渐变：16 层、层距 0.4px（总外扩约 6.4px）。
        // 每层透明度由目标曲线反解（叠加后正好是从 80% 线性降到 0），因此渐变铺满整条光晕，
        // 只有最内侧极窄的一条接近 80%，不会出现一大段实色。
        // 同一时刻所有层共用一种颜色，颜色随时间缓慢地在五色间过渡。
        const int layerCount = 16;
        const float spacing = 0.4f;
        var alphas = RainbowPalette.LayerAlphas(layerCount, 0.6f);

        for (var i = 1; i <= layerCount; i++)
        {
            var inset = i * spacing;
            var alpha = alphas[i - 1];

            var layer = new RainbowLayer { Inset = inset };
            layer.Visual = _comp.CreateShapeVisual();
            layer.Geometry = _comp.CreateRoundedRectangleGeometry();
            layer.Shape = _comp.CreateSpriteShape(layer.Geometry);

            var brush = _comp.CreateColorBrush(ColorAt(0f, alpha));
            layer.Shape.FillBrush = brush;
            layer.Visual.Shapes.Add(layer.Shape);
            _host.Children.InsertAtTop(layer.Visual);
            _layers.Add(layer);

            StartColorCycle(brush, alpha);
        }

        _ready = true;
    }

    /// <summary>单色刷子的颜色沿色环缓慢过渡：每种颜色 5 秒，一圈 25 秒，首尾同色循环无缝。</summary>
    private void StartColorCycle(CompositionColorBrush brush, float alpha)
    {
        if (_comp is null) return;
        try
        {
            const int steps = 5;   // 五色，走完一圈回到起点
            var anim = _comp.CreateColorKeyFrameAnimation();
            for (var i = 0; i <= steps; i++)
                anim.InsertKeyFrame(i / (float)steps, ColorAt(i / (float)steps, alpha));

            anim.Duration = TimeSpan.FromSeconds(RainbowPalette.ColorCycleSeconds);
            anim.IterationBehavior = AnimationIterationBehavior.Forever;
            brush.StartAnimation(nameof(CompositionColorBrush.Color), anim);
        }
        catch { /* 忽略 */ }
    }

    /// <summary>在五色之间线性取样，并写入该层的浓度。</summary>
    private static Color ColorAt(float t, float alpha) => RainbowPalette.At(t, alpha);

    private void UpdateGeometry()
    {
        if (!_ready || _comp is null) return;

        var w = GlowHost.ActualWidth;
        var h = GlowHost.ActualHeight;
        var shellW = Shell.ActualWidth;
        var shellH = Shell.ActualHeight;
        if (w < 40 || h < 24 || shellW < 40 || shellH < 24) return;
        if (Math.Abs(w - _lastW) < 0.5 && Math.Abs(h - _lastH) < 0.5
            && Math.Abs(shellW - _lastShellW) < 0.5 && Math.Abs(shellH - _lastShellH) < 0.5)
            return;
        _lastW = w; _lastH = h; _lastShellW = shellW; _lastShellH = shellH;

        var origin = Shell.TransformToVisual(GlowHost).TransformPoint(new Point(0, 0));
        var canvas = new Vector2((float)w, (float)h);

        foreach (var layer in _layers)
        {
            var inset = layer.Inset;
            layer.Geometry.Size = new Vector2((float)shellW + inset * 2, (float)shellH + inset * 2);

            // 外层圆角随外扩一起增大，轮廓向外逐渐"软"下来
            var radius = 10 + inset;
            layer.Geometry.CornerRadius = new Vector2(radius, radius);
            layer.Shape.Offset = new Vector2((float)origin.X - inset, (float)origin.Y - inset);
            layer.Visual.Size = canvas;
        }
    }

    // ---------- 交互 ----------
    private void UpdateGlow()
    {
        var visible = Input.FocusState != FocusState.Unfocused
                      || !string.IsNullOrWhiteSpace(Input.Text);
        SetRainbowVisible(visible);
    }

    private void Input_TextChanged(object sender, TextChangedEventArgs e)
    {
        HideClearButton();
        UpdateGlow();
    }

    private void Input_GotFocus(object sender, RoutedEventArgs e) => UpdateGlow();

    private void Input_LostFocus(object sender, RoutedEventArgs e) => UpdateGlow();

    private void Input_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        e.Handled = true;
        TrySubmit();
    }

    private void Send_Click(object sender, RoutedEventArgs e) => TrySubmit();

    private void TrySubmit()
    {
        var text = Input.Text?.Trim();
        if (string.IsNullOrEmpty(text)) return;
        Submitted?.Invoke(this, text);
        Input.Text = "";
    }
}
