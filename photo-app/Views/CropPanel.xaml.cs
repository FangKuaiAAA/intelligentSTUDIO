using System;
using System.Threading.Tasks;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using PhotoEditor.Controls;
using PhotoEditor.Services;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.UI;

namespace PhotoEditor.Views;

/// <summary>
/// 裁剪：比例、90° 旋转、微调角度、镜像。裁剪框在预览图上交互，确认时按同一组参数作用于全分辨率图。
/// </summary>
public sealed partial class CropPanel : UserControl, IEditorPanel
{
    private const int PreviewLongEdge = 1500;

    private IEditorHost? _host;
    private EditSurface? _surface;

    private SoftwareBitmap? _previewSource;
    private SoftwareBitmap? _previewOutput;

    private readonly CropSettings _settings = new();
    private readonly Rectangle[] _shades = new Rectangle[4];
    private readonly Line[] _thirds = new Line[4];
    private readonly Border[] _handles = new Border[4];
    private readonly Rectangle _frame = new();

    private double? _ratio;
    private bool _suppress;
    private bool _subscribed;
    private bool _active;

    private DragKind _drag = DragKind.None;
    private int _corner;
    private Point _dragStart;
    private CropSettings _dragOrigin = new();

    private enum DragKind { None, Move, Corner }

    public CropPanel()
    {
        InitializeComponent();
        // 首次进入不锁定比例，拖拽就是自由裁剪
        _ratio = null;
        RatioFree.IsChecked = true;
        BuildOverlayVisuals();
    }

    public string Title => "裁剪";

    public string Subtitle => "调整构图，确认后应用。";

    public FrameworkElement View => this;

    public async void Activate(IEditorHost host)
    {
        _active = true;
        _host = host;
        _surface = host.Surface;
        _surface.DragMode = CanvasDragMode.Custom;

        if (!_subscribed)
        {
            _surface.CanvasPressed += OnCanvasPressed;
            _surface.CanvasMoved += OnCanvasMoved;
            _surface.CanvasReleased += OnCanvasReleased;
            // 跟随画布的实际缩放/偏移更新，而不是等到尺寸变化：
            // 最大化后先 ApplyFit 再重排，框才不会按旧比例错位
            _surface.ViewChanged += (_, _) => UpdateOverlay();
            _subscribed = true;
        }

        if (!host.Session.HasImage)
        {
            _surface.OverlayCanvas.Children.Clear();
            return;
        }

        ResetHint.Visibility = host.Session.HasResult(EditStage.Filter)
            ? Visibility.Visible
            : Visibility.Collapsed;

        _settings.X = 0;
        _settings.Y = 0;
        _settings.Width = 1;
        _settings.Height = 1;

        // Latest 已包含此前应用的旋转/镜像，这里必须一并清零：
        // 否则 RebuildAsync 会在已旋转的图上再转一次，重新进入时画面就会错转。
        _settings.QuarterTurns = 0;
        _settings.FineAngle = 0;
        _settings.FlipHorizontal = false;
        _settings.StretchX = 1;
        _settings.StretchY = 1;

        await PrepareAsync();

        // 面板刚换上来时容器尺寸还没稳定，第一帧的适配会按旧尺寸算，
        // 图像先缩小再跳回。等布局稳定后按最终尺寸重新适配一次。
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
        {
            _surface?.ApplyFit();
            UpdateOverlay();
        });
    }

    public void Deactivate()
    {
        _active = false;

        if (_surface is not null)
        {
            _surface.CanvasPressed -= OnCanvasPressed;
            _surface.CanvasMoved -= OnCanvasMoved;
            _surface.CanvasReleased -= OnCanvasReleased;
            _surface.DragMode = CanvasDragMode.Pan;
            _surface.OverlayCanvas.Children.Clear();
        }
        _subscribed = false;
        _previewOutput?.Dispose();
        _previewOutput = null;
        _previewSource?.Dispose();
        _previewSource = null;
    }

    private async Task PrepareAsync()
    {
        // 基于 Latest：无论上一步是滤镜还是裁剪，都从当前画面继续
        if (_host?.Session.Latest is not { } input) return;

        _previewSource?.Dispose();
        _previewSource = await ImageCodec.ResizeToLongEdgeAsync(input, PreviewLongEdge);

        if (_ratio is null && _settings.IsNeutral)
        {
            // 保持自由比例：不因为原图比例而锁定拖拽
            RatioFree.IsChecked = true;
        }

        await RebuildAsync(preserveView: false);
    }

    /// <summary>预览只反映旋转、微调与镜像；裁剪与拉伸在确认时应用，避免预览被裁掉后失去参照。</summary>
    private async Task RebuildAsync(bool preserveView = true)
    {
        if (_previewSource is null || _surface is null) return;

        var source = _previewSource;
        var settings = _settings.Clone();
        settings.X = 0;
        settings.Y = 0;
        settings.Width = 1;
        settings.Height = 1;
        settings.StretchX = 1;
        settings.StretchY = 1;

        var output = await Task.Run(() => ImageProcessor.Transform(source, settings));

        // 面板已切走时丢弃结果，否则会把裁剪框重新画到别的面板上
        if (!_active)
        {
            output.Dispose();
            return;
        }

        // 先换图再释放旧位图：画布仍持有旧引用时提前释放会造成渲染异常
        var previous = _previewOutput;
        _previewOutput = output;

        await _surface.SetBitmapAsync(output, preserveView);
        UpdateOverlay();

        previous?.Dispose();
    }

    // ---------- 叠加层 ----------

    private void BuildOverlayVisuals()
    {
        _frame.Stroke = new SolidColorBrush(Colors.White);
        _frame.StrokeThickness = 1;
        _frame.Fill = new SolidColorBrush(Colors.Transparent);

        for (var i = 0; i < 4; i++)
        {
            _shades[i] = new Rectangle { Fill = new SolidColorBrush(Color.FromArgb(140, 0, 0, 0)) };
            _thirds[i] = new Line { Stroke = new SolidColorBrush(Color.FromArgb(64, 255, 255, 255)), StrokeThickness = 0.8 };
            _handles[i] = new Border
            {
                Width = 12,
                Height = 12,
                CornerRadius = new CornerRadius(6),
                Background = new SolidColorBrush(Colors.White),
                BorderThickness = new Thickness(2),
                BorderBrush = new SolidColorBrush(Color.FromArgb(90, 0, 0, 0)),
            };
        }
    }

    private void UpdateOverlay()
    {
        if (!_active || _surface is null || _previewOutput is null) return;

        var canvas = _surface.OverlayCanvas;
        if (canvas.Children.Count == 0)
        {
            canvas.Children.Add(_frame);
            foreach (var shade in _shades) canvas.Children.Add(shade);
            foreach (var line in _thirds) canvas.Children.Add(line);
            foreach (var handle in _handles) canvas.Children.Add(handle);
        }

        var width = _previewOutput.PixelWidth;
        var height = _previewOutput.PixelHeight;
        var x0 = _settings.X * width;
        var y0 = _settings.Y * height;
        var x1 = (_settings.X + _settings.Width) * width;
        var y1 = (_settings.Y + _settings.Height) * height;

        var p0 = _surface.ToCanvas(new Point(x0, y0));
        var p1 = _surface.ToCanvas(new Point(x1, y1));

        var left = p0.X;
        var top = p0.Y;
        var boxWidth = Math.Max(2, p1.X - p0.X);
        var boxHeight = Math.Max(2, p1.Y - p0.Y);

        Place(_frame, left, top, boxWidth, boxHeight);

        var surfaceWidth = _surface.ActualWidth;
        var surfaceHeight = _surface.ActualHeight;
        Place(_shades[0], 0, 0, surfaceWidth, Math.Max(0, top));
        Place(_shades[1], 0, top + boxHeight, surfaceWidth, Math.Max(0, surfaceHeight - top - boxHeight));
        Place(_shades[2], 0, top, Math.Max(0, left), boxHeight);
        Place(_shades[3], left + boxWidth, top, Math.Max(0, surfaceWidth - left - boxWidth), boxHeight);

        var thirdX1 = left + boxWidth / 3;
        var thirdX2 = left + boxWidth * 2 / 3;
        var thirdY1 = top + boxHeight / 3;
        var thirdY2 = top + boxHeight * 2 / 3;

        SetLine(_thirds[0], thirdX1, top, thirdX1, top + boxHeight);
        SetLine(_thirds[1], thirdX2, top, thirdX2, top + boxHeight);
        SetLine(_thirds[2], left, thirdY1, left + boxWidth, thirdY1);
        SetLine(_thirds[3], left, thirdY2, left + boxWidth, thirdY2);

        Place(_handles[0], left - 6, top - 6, 12, 12);
        Place(_handles[1], left + boxWidth - 6, top - 6, 12, 12);
        Place(_handles[2], left - 6, top + boxHeight - 6, 12, 12);
        Place(_handles[3], left + boxWidth - 6, top + boxHeight - 6, 12, 12);
    }

    private static void Place(FrameworkElement element, double left, double top, double width, double height)
    {
        Canvas.SetLeft(element, left);
        Canvas.SetTop(element, top);
        element.Width = width;
        element.Height = height;
    }

    private static void SetLine(Line line, double x1, double y1, double x2, double y2)
    {
        line.X1 = x1;
        line.Y1 = y1;
        line.X2 = x2;
        line.Y2 = y2;
    }

    // ---------- 拖拽 ----------

    private void OnCanvasPressed(object? sender, CanvasPointerEventArgs e)
    {
        if (_previewOutput is null || _surface is null || !e.IsLeftButton) return;

        var width = _previewOutput.PixelWidth;
        var height = _previewOutput.PixelHeight;
        var nx = Math.Clamp(e.ImagePoint.X / width, 0, 1);
        var ny = Math.Clamp(e.ImagePoint.Y / height, 0, 1);

        var x0 = _settings.X;
        var y0 = _settings.Y;
        var x1 = _settings.X + _settings.Width;
        var y1 = _settings.Y + _settings.Height;

        var corners = new[] { new Point(x0, y0), new Point(x1, y0), new Point(x0, y1), new Point(x1, y1) };
        var threshold = 18.0 / Math.Min(width, height);

        for (var i = 0; i < corners.Length; i++)
        {
            var dx = nx - corners[i].X;
            var dy = ny - corners[i].Y;
            if (Math.Sqrt(dx * dx + dy * dy) > threshold) continue;

            _drag = DragKind.Corner;
            _corner = i;
            _dragStart = new Point(nx, ny);
            _dragOrigin = _settings.Clone();
            return;
        }

        if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1)
        {
            _drag = DragKind.Move;
        }
        else
        {
            _drag = DragKind.Corner;
            _corner = 3;
            _settings.X = nx;
            _settings.Y = ny;
            _settings.Width = 0.02;
            _settings.Height = 0.02;
        }

        _dragStart = new Point(nx, ny);
        _dragOrigin = _settings.Clone();
    }

    private void OnCanvasMoved(object? sender, CanvasPointerEventArgs e)
    {
        if (_drag == DragKind.None || _previewOutput is null) return;

        var width = _previewOutput.PixelWidth;
        var height = _previewOutput.PixelHeight;
        var nx = Math.Clamp(e.ImagePoint.X / width, 0, 1);
        var ny = Math.Clamp(e.ImagePoint.Y / height, 0, 1);

        if (_drag == DragKind.Move)
        {
            var dx = nx - _dragStart.X;
            var dy = ny - _dragStart.Y;
            var x = Math.Clamp(_dragOrigin.X + dx, 0, 1 - _dragOrigin.Width);
            var y = Math.Clamp(_dragOrigin.Y + dy, 0, 1 - _dragOrigin.Height);
            _settings.X = x;
            _settings.Y = y;
            UpdateOverlay();
            return;
        }

        ResizeCorner(nx, ny, width, height);
        UpdateOverlay();
    }

    private void OnCanvasReleased(object? sender, CanvasPointerEventArgs e) => _drag = DragKind.None;

    private void ResizeCorner(double nx, double ny, double pixelWidth, double pixelHeight)
    {
        // 以对角为锚点，按当前比例约束宽高
        var anchorX = _corner is 1 or 3 ? _dragOrigin.X : _dragOrigin.X + _dragOrigin.Width;
        var anchorY = _corner is 2 or 3 ? _dragOrigin.Y : _dragOrigin.Y + _dragOrigin.Height;

        var minSize = 24.0 / Math.Min(pixelWidth, pixelHeight);
        var x0 = Math.Min(anchorX, nx);
        var y0 = Math.Min(anchorY, ny);
        var w = Math.Max(Math.Abs(nx - anchorX), minSize);
        var h = Math.Max(Math.Abs(ny - anchorY), minSize);

        if (_ratio is { } ratio)
        {
            // 比例锁定：取更贴合指针的一侧，再反推另一侧
            var byWidth = w / ratio;
            if (byWidth <= h) h = byWidth;
            else w = h * ratio;
        }

        if (nx < anchorX) x0 = anchorX - w;
        if (ny < anchorY) y0 = anchorY - h;

        if (x0 < 0) x0 = 0;
        if (y0 < 0) y0 = 0;
        if (x0 + w > 1) w = 1 - x0;
        if (y0 + h > 1) h = 1 - y0;

        _settings.X = x0;
        _settings.Y = y0;
        _settings.Width = Math.Max(minSize, w);
        _settings.Height = Math.Max(minSize, h);
    }

    // ---------- 面板操作 ----------

    private void OnRatioClicked(object sender, RoutedEventArgs e)
    {
        if (_suppress) return;
        if (sender is not ToggleButton button) return;

        // 先无条件处理互斥：即使预览尚未就绪，也必须保证同组只有当前按钮显示背景，
        // 否则点下去的按钮会留下背景，旧的背景也不会消失。
        var cancelled = button.IsChecked != true;

        _suppress = true;
        foreach (var item in new[] { RatioOriginal, Ratio1x1, Ratio4x3, Ratio3x4, Ratio16x9, Ratio9x16, Ratio3x2, Ratio2x3, RatioFree })
            item.IsChecked = !cancelled && ReferenceEquals(item, button);
        _suppress = false;

        if (cancelled)
        {
            _ratio = null;
            UpdateOverlay();
            return;
        }

        if (_previewOutput is null) return;

        var tag = button.Tag as string ?? "";

        _ratio = tag switch
        {
            "" => null,
            "0" => _previewOutput.PixelWidth / (double)_previewOutput.PixelHeight,
            _ => double.TryParse(tag, out var value) ? value : null,
        };

        if (_ratio is { } ratio) FitBoxToRatio(ratio);
        UpdateOverlay();
    }

    private void FitBoxToRatio(double ratio)
    {
        var centerX = _settings.X + _settings.Width / 2;
        var centerY = _settings.Y + _settings.Height / 2;

        var width = Math.Min(1, _settings.Width);
        var height = width / ratio;
        if (height > 1)
        {
            height = 1;
            width = height * ratio;
        }

        _settings.Width = Math.Max(0.05, width);
        _settings.Height = Math.Max(0.05, height);
        _settings.X = Math.Clamp(centerX - _settings.Width / 2, 0, 1 - _settings.Width);
        _settings.Y = Math.Clamp(centerY - _settings.Height / 2, 0, 1 - _settings.Height);
    }

    private async void OnRotateLeft(object sender, RoutedEventArgs e)
    {
        _settings.QuarterTurns = (_settings.QuarterTurns + 3) % 4;
        ResetBox();
        await RebuildAsync(preserveView: false);
    }

    private async void OnRotateRight(object sender, RoutedEventArgs e)
    {
        _settings.QuarterTurns = (_settings.QuarterTurns + 1) % 4;
        ResetBox();
        await RebuildAsync(preserveView: false);
    }

    private async void OnFlip(object sender, RoutedEventArgs e)
    {
        _settings.FlipHorizontal = !_settings.FlipHorizontal;
        await RebuildAsync();
    }

    private async void OnReset(object sender, RoutedEventArgs e)
    {
        _settings.X = 0;
        _settings.Y = 0;
        _settings.Width = 1;
        _settings.Height = 1;
        _settings.QuarterTurns = 0;
        _settings.FineAngle = 0;
        _settings.FlipHorizontal = false;
        _settings.StretchX = 1;
        _settings.StretchY = 1;

        _suppress = true;
        RatioFree.IsChecked = true;
        foreach (var item in new[] { Ratio1x1, Ratio4x3, Ratio3x4, Ratio16x9, Ratio9x16, Ratio3x2, Ratio2x3, RatioFree })
            item.IsChecked = false;
        _suppress = false;

        if (_previewOutput is not null)
            _ratio = _previewOutput.PixelWidth / (double)_previewOutput.PixelHeight;

        await RebuildAsync(preserveView: false);
    }

    private void ResetBox()
    {
        _settings.X = 0;
        _settings.Y = 0;
        _settings.Width = 1;
        _settings.Height = 1;
        if (_previewSource is not null)
            _ratio = _settings.QuarterTurns % 2 == 0
                ? _previewSource.PixelWidth / (double)_previewSource.PixelHeight
                : _previewSource.PixelHeight / (double)_previewSource.PixelWidth;
    }

    private async void OnApply(object sender, RoutedEventArgs e)
    {
        if (_host is null) return;
        // 与预览保持一致：基于当前最新结果继续裁剪
        if (_host.Session.Latest is not { } input) return;

        var settings = _settings.Clone();
        if (settings.IsNeutral)
        {
            _host.ShowToast("没有需要应用的裁剪。");
            return;
        }

        var result = await Task.Run(() => ImageProcessor.Transform(input, settings));
        _host.Session.Commit(EditStage.Crop, result, settings);

        // 应用后画布内容已换成裁剪结果，但预览源与选框还停留在裁剪前的尺寸，
        // UpdateOverlay 会按旧像素坐标换算，把框挤到左上角。
        // 这里把选框重置为全图，并让预览与画布同步到新结果。
        _settings.X = 0;
        _settings.Y = 0;
        _settings.Width = 1;
        _settings.Height = 1;

        // result 已经烘焙了旋转/镜像，继续操作时不能再叠加一次
        _settings.QuarterTurns = 0;
        _settings.FineAngle = 0;
        _settings.FlipHorizontal = false;
        _settings.StretchX = 1;
        _settings.StretchY = 1;

        _previewSource?.Dispose();
        _previewSource = await ImageCodec.ResizeToLongEdgeAsync(result, PreviewLongEdge);

        _previewOutput?.Dispose();
        _previewOutput = SoftwareBitmap.Copy(_previewSource);

        if (_surface is not null)
        {
            await _surface.SetBitmapAsync(_previewOutput);
            UpdateOverlay();
        }

        AppLog.Info("应用裁剪", $"{result.PixelWidth}×{result.PixelHeight}");
        _host.ShowToast("已应用裁剪。");
    }
}
