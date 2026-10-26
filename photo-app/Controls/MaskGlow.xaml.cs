using System;
using System.Numerics;
using System.Threading.Tasks;
using Microsoft.UI;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using PhotoEditor.Services;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using Windows.UI;

namespace PhotoEditor.Controls;

/// <summary>
/// 元素轮廓的光效：一层彩虹缓慢流转，一层白高光沿横向扫过。
/// WinUI 3 没有 UIElement.OpacityMask，这里用 CompositionMaskBrush 把遮罩位图当作 alpha 蒙版。
/// </summary>
public sealed partial class MaskGlow : UserControl
{
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(80) };

    private Compositor? _compositor;
    private ContainerVisual? _root;
    private SpriteVisual? _rainbowVisual;
    private SpriteVisual? _highlightVisual;
    private CompositionLinearGradientBrush? _rainbowBrush;
    private CompositionLinearGradientBrush? _highlightBrush;
    private LoadedImageSurface? _maskSurface;

    private double _phase;
    private bool _running;

    public MaskGlow()
    {
        InitializeComponent();
        Loaded += (_, _) => EnsureVisuals();
        SizeChanged += (_, _) => UpdateSize();
        _timer.Tick += (_, _) => Advance();
        Opacity = 0;
    }

    private void EnsureVisuals()
    {
        if (_root is not null) return;
        if (_compositor is null && !TryCreateCompositor()) return;
        if (_compositor is null) return;

        _root = _compositor.CreateContainerVisual();
        ElementCompositionPreview.SetElementChildVisual(Host, _root);

        _rainbowBrush = BuildBrush(5);
        _highlightBrush = BuildBrush(3);

        _rainbowVisual = _compositor.CreateSpriteVisual();
        var rainbowMask = _compositor.CreateMaskBrush();
        rainbowMask.Source = _rainbowBrush;
        _rainbowVisual.Brush = rainbowMask;

        _highlightVisual = _compositor.CreateSpriteVisual();
        var highlightMask = _compositor.CreateMaskBrush();
        highlightMask.Source = _highlightBrush;
        _highlightVisual.Brush = highlightMask;

        _root.Children.InsertAtTop(_rainbowVisual);
        _root.Children.InsertAtTop(_highlightVisual);
        UpdateSize();
    }

    private bool TryCreateCompositor()
    {
        try
        {
            _compositor = ElementCompositionPreview.GetElementVisual(this).Compositor;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private CompositionLinearGradientBrush BuildBrush(int stopCount)
    {
        var brush = _compositor!.CreateLinearGradientBrush();
        brush.StartPoint = new Vector2(0, 0.5f);
        brush.EndPoint = new Vector2(1, 0.5f);

        for (var i = 0; i < stopCount; i++)
        {
            var offset = stopCount == 1 ? 0f : i / (float)(stopCount - 1);
            brush.ColorStops.Add(_compositor.CreateColorGradientStop(offset, Colors.Transparent));
        }

        return brush;
    }

    /// <summary>遮罩位图与其像素尺寸一致的控件尺寸。传 null 清空形状。</summary>
    public async Task SetMaskAsync(SoftwareBitmap? mask)
    {
        EnsureVisuals();
        if (mask is null || _compositor is null)
        {
            RemoveMask();
            return;
        }

        var png = await ImageCodec.EncodePngAsync(mask);
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream.GetOutputStreamAt(0)))
        {
            writer.WriteBytes(png);
            await writer.StoreAsync();
            await writer.FlushAsync();
        }
        stream.Seek(0);

        var surface = LoadedImageSurface.StartLoadFromStream(stream);
        _maskSurface?.Dispose();
        _maskSurface = surface;

        var surfaceBrush = _compositor.CreateSurfaceBrush(surface);
        surfaceBrush.Stretch = CompositionStretch.Fill;

        if (_rainbowVisual?.Brush is CompositionMaskBrush rainbow) rainbow.Mask = surfaceBrush;
        if (_highlightVisual?.Brush is CompositionMaskBrush highlight) highlight.Mask = surfaceBrush;

        Width = mask.PixelWidth;
        Height = mask.PixelHeight;
        UpdateSize();
    }

    private void RemoveMask()
    {
        if (_rainbowVisual?.Brush is CompositionMaskBrush rainbow) rainbow.Mask = null;
        if (_highlightVisual?.Brush is CompositionMaskBrush highlight) highlight.Mask = null;
        _maskSurface?.Dispose();
        _maskSurface = null;
    }

    public void Start()
    {
        if (_running) return;
        _running = true;
        _timer.Start();

        // 直接设不透明度：控件尚未加载时 Storyboard 会被丢弃，Opacity 停在 0，
        // 表现就是“识别成功但画面上什么都没有”。
        Opacity = 1;
    }

    public void Stop()
    {
        _running = false;
        _timer.Stop();
        Opacity = 0;
    }

    private void UpdateSize()
    {
        if (_root is null) return;

        var size = new Vector2(
            (float)Math.Max(1, ActualWidth),
            (float)Math.Max(1, ActualHeight));

        _root.Size = size;
        if (_rainbowVisual is not null) _rainbowVisual.Size = size;
        if (_highlightVisual is not null) _highlightVisual.Size = size;
    }

    private void Advance()
    {
        // 25 秒走完一圈色环；高光约 1.8 秒扫过一次
        _phase += 0.0036;

        if (_rainbowBrush is not null)
        {
            var stops = _rainbowBrush.ColorStops;
            for (var i = 0; i < stops.Count; i++)
                stops[i].Color = RainbowPalette.At((float)(_phase + i / 4.0), 0.92f);
        }

        if (_highlightBrush is not null)
        {
            var center = _phase * 14.0 % 1.0;
            var stops = _highlightBrush.ColorStops;
            for (var i = 0; i < stops.Count; i++)
            {
                var target = center + (i - 1) * 0.26;
                var offset = Math.Clamp(target, 0, 1);
                var alpha = (byte)Math.Round(255 * Math.Max(0, 1 - Math.Abs(offset - target) / 0.26));
                stops[i].Offset = (float)offset;
                stops[i].Color = Color.FromArgb(alpha, 255, 255, 255);
            }
        }
    }

    private void Fade(double to)
    {
        var animation = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(240),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(animation, this);
        Storyboard.SetTargetProperty(animation, "Opacity");

        var story = new Storyboard();
        story.Children.Add(animation);
        story.Begin();
    }
}
