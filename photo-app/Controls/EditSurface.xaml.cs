using System;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using PhotoEditor.Services;
using Windows.Foundation;
using Windows.Graphics.Imaging;

namespace PhotoEditor.Controls;

public enum CanvasDragMode
{
    /// <summary>左键拖拽平移画布。</summary>
    Pan,
    /// <summary>左键交给页面使用（涂抹、拖框），中键与右键仍可平移。</summary>
    Custom,
}

public sealed class CanvasPointerEventArgs
{
    public required Point ImagePoint { get; init; }
    public required Point CanvasPoint { get; init; }
    public bool IsLeftButton { get; init; }
}

/// <summary>
/// 编辑画布：以 CompositeTransform 承载缩放与平移，叠加层与控件同坐标系。
/// 图片坐标经 <see cref="ToCanvas"/> / <see cref="ToImage"/> 换算，页面只处理图片坐标。
/// </summary>
public sealed partial class EditSurface : UserControl
{
    private SoftwareBitmap? _bitmap;
    private double _fitScale = 1;
    private double _scale = 1;
    private Point _offset;
    private bool _panning;
    private bool _pointerDown;
    private Point _panStart;
    private Point _panOrigin;

    public EditSurface()
    {
        InitializeComponent();
        Root.SizeChanged += (_, _) =>
        {
            UpdateClip();
            ApplyFit();
        };
        Root.PointerWheelChanged += OnWheel;
        Root.PointerPressed += OnPressed;
        Root.PointerMoved += OnMoved;
        Root.PointerReleased += OnReleased;
        Root.PointerCaptureLost += (_, _) =>
        {
            _panning = false;

            // 正常抬起也会走到这里（释放捕获）。只有按下未抬起时才视为中断，
            // 否则每一笔都会被当成中断丢弃。
            if (!_pointerDown) return;

            _pointerDown = false;
            CanvasCancelled?.Invoke(this, EventArgs.Empty);
        };
        Root.DoubleTapped += (_, _) => ApplyFit();
    }

    public Canvas OverlayCanvas => Overlay;

    /// <summary>与照片同坐标系的图层：尺寸为图像像素，子元素按图像坐标定位。</summary>
    public Canvas MaskCanvas => MaskLayer;

    public CanvasDragMode DragMode { get; set; } = CanvasDragMode.Pan;

    public SoftwareBitmap? Bitmap => _bitmap;

    public event EventHandler<CanvasPointerEventArgs>? CanvasPressed;
    public event EventHandler<CanvasPointerEventArgs>? CanvasMoved;
    public event EventHandler<CanvasPointerEventArgs>? CanvasReleased;

    /// <summary>指针被系统夺走（切窗口、手势）时触发，用于结束正在进行的笔迹。</summary>
    public event EventHandler? CanvasCancelled;

    /// <summary>缩放或平移发生变化，覆盖层需按新变换重新定位。</summary>
    public event EventHandler? ViewChanged;

    public double ImageScale => _scale;

    /// <summary>
    /// 换图。preserveView 为真时保持当前缩放与画面中心，用于实时预览（尺寸变化不跳）。
    /// </summary>
    private int _bitmapVersion;

    public async Task SetBitmapAsync(SoftwareBitmap? bitmap, bool preserveView = false)
    {
        // 快速切换面板会并发调用本方法：旧图可能已随面板释放，且后到的结果不能覆盖新图
        var version = Interlocked.Increment(ref _bitmapVersion);

        // 必须在改写 Photo.Width 之前记录旧尺寸，否则尺寸补偿永远等于 1
        var previousWidth = Photo.Width;
        var previousHeight = Photo.Height;

        var center = new Point(
            _offset.X + previousWidth * _scale / 2,
            _offset.Y + previousHeight * _scale / 2);
        var hadBitmap = _bitmap is not null;

        _bitmap = bitmap;
        if (bitmap is null)
        {
            Photo.Source = null;
            return;
        }

        Microsoft.UI.Xaml.Media.ImageSource? source;
        try
        {
            source = await ImageCodec.ToSourceAsync(bitmap);
        }
        catch (Exception ex)
        {
            // 图已被释放（面板已切走），丢弃这次换图
            AppLog.Write("画布换图失败", $"{ex.GetType().Name}: {ex.Message}");
            return;
        }

        if (version != Volatile.Read(ref _bitmapVersion)) return;

        // 尺寸与内容必须同帧更新：先改 Width/Height 再等 Source，
        // 中间会出现旧图按新尺寸拉伸的一帧，表现为“百叶窗”与大小跳变。
        Photo.Stretch = Microsoft.UI.Xaml.Media.Stretch.Fill;
        Photo.Width = bitmap.PixelWidth;
        Photo.Height = bitmap.PixelHeight;
        Photo.Source = source;

        MaskLayer.Width = bitmap.PixelWidth;
        MaskLayer.Height = bitmap.PixelHeight;

        if (preserveView && hadBitmap)
        {
            // 预览用的是缩小版位图（滤镜只渲染长边 1600），沿用原缩放会让画面在屏幕上变小。
            // 按像素尺寸比例补偿，保证换图前后视觉大小一致。
            if (previousWidth > 0 && bitmap.PixelWidth > 0)
            {
                var factor = previousWidth / bitmap.PixelWidth;
                if (Math.Abs(factor - 1) > 0.001) _scale *= factor;
            }

            _offset = new Point(
                center.X - bitmap.PixelWidth * _scale / 2,
                center.Y - bitmap.PixelHeight * _scale / 2);
            Apply();

            AppLog.Info("画布保留视图",
                $"{bitmap.PixelWidth}×{bitmap.PixelHeight} scale={_scale:F4} offset={_offset.X:F0},{_offset.Y:F0}");
            return;
        }

        ApplyFit();
    }

    /// <summary>
    /// 裁剪到控件边界。笔迹画在覆盖层上，指针移到窗口其他区域时坐标会越界，
    /// 不做裁剪就会画到侧栏与标题栏上。
    /// </summary>
    private void UpdateClip()
    {
        if (Root.ActualWidth <= 0 || Root.ActualHeight <= 0) return;

        Root.Clip = new RectangleGeometry
        {
            Rect = new Rect(0, 0, Root.ActualWidth, Root.ActualHeight),
        };
    }

    /// <summary>适配窗口并居中。</summary>
    public void ApplyFit()
    {
        if (_bitmap is null || Root.ActualWidth < 4 || Root.ActualHeight < 4) return;

        var margin = 44.0;
        var availableWidth = Math.Max(40, Root.ActualWidth - margin * 2);
        var availableHeight = Math.Max(40, Root.ActualHeight - margin * 2);

        _fitScale = Math.Min(availableWidth / _bitmap.PixelWidth, availableHeight / _bitmap.PixelHeight);
        _fitScale = Math.Min(_fitScale, 1.0);
        _scale = _fitScale;

        AppLog.Info("画布适配",
            $"{_bitmap.PixelWidth}×{_bitmap.PixelHeight} root={Root.ActualWidth:F0}×{Root.ActualHeight:F0} scale={_scale:F4}");

        _offset = new Point(
            (Root.ActualWidth - _bitmap.PixelWidth * _scale) / 2,
            (Root.ActualHeight - _bitmap.PixelHeight * _scale) / 2);

        Apply();
    }

    public Point ToCanvas(Point imagePoint) =>
        new(imagePoint.X * _scale + _offset.X, imagePoint.Y * _scale + _offset.Y);

    public Point ToImage(Point canvasPoint) =>
        new((canvasPoint.X - _offset.X) / _scale, (canvasPoint.Y - _offset.Y) / _scale);

    /// <summary>
    /// 进入等待态。bottom 为真时只在画布下方浮出进度条、不压暗画面（扩展与重构使用）。
    /// </summary>
    public void ShowBusy(string text, bool bottom = false)
    {
        Progress.VerticalAlignment = bottom ? VerticalAlignment.Bottom : VerticalAlignment.Center;
        Progress.Margin = bottom ? new Thickness(0, 0, 0, 54) : new Thickness(0);
        BusyLayer.Background = bottom
            ? new SolidColorBrush(Microsoft.UI.Colors.Transparent)
            : new SolidColorBrush(Windows.UI.Color.FromArgb(140, 0, 0, 0));
        BusyLayer.IsHitTestVisible = !bottom;

        BusyLayer.Visibility = Visibility.Visible;
        Progress.Begin(text);
        FadeBusy(1);
    }

    public void SetBusyText(string text) => Progress.SetText(text);

    public void SetBusyProgress(double value) => Progress.SetProgress(value);

    public void HideBusy()
    {
        Progress.Complete();
        FadeBusy(0, () =>
        {
            BusyLayer.Visibility = Visibility.Collapsed;
            Progress.Hide();
        });
    }

    private void Apply()
    {
        PhotoTransform.ScaleX = _scale;
        PhotoTransform.ScaleY = _scale;
        PhotoTransform.TranslateX = _offset.X;
        PhotoTransform.TranslateY = _offset.Y;

        MaskTransform.ScaleX = _scale;
        MaskTransform.ScaleY = _scale;
        MaskTransform.TranslateX = _offset.X;
        MaskTransform.TranslateY = _offset.Y;

        // 窗口最大化/还原会改变适配比例，覆盖层必须跟着重建
        ViewChanged?.Invoke(this, EventArgs.Empty);
    }

    private void OnWheel(object sender, PointerRoutedEventArgs e)
    {
        // 照片固定按窗口适配，不支持滚轮缩放：
        // 各面板都按图像坐标交互（涂抹、裁剪框、扩展拖拽），缩放会让命中位置与选框错位。
        e.Handled = true;
    }

    private void OnPressed(object sender, PointerRoutedEventArgs e)
    {
        if (_bitmap is null) return;

        var point = e.GetCurrentPoint(Root);
        var args = new CanvasPointerEventArgs
        {
            ImagePoint = ToImage(point.Position),
            CanvasPoint = point.Position,
            IsLeftButton = point.Properties.IsLeftButtonPressed,
        };

        _pointerDown = true;

        var middleOrRight = point.Properties.IsMiddleButtonPressed || point.Properties.IsRightButtonPressed;
        if (middleOrRight || (DragMode == CanvasDragMode.Pan && point.Properties.IsLeftButtonPressed))
        {
            _panning = true;
            _panStart = point.Position;
            _panOrigin = _offset;
            Root.CapturePointer(e.Pointer);
            e.Handled = true;
            return;
        }

        // 页面接管左键时同样捕获指针，保证拖动到画布外也能收到移动与抬起
        Root.CapturePointer(e.Pointer);
        CanvasPressed?.Invoke(this, args);
    }

    private void OnMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_bitmap is null) return;
        var point = e.GetCurrentPoint(Root);

        if (_panning)
        {
            _offset = new Point(
                _panOrigin.X + (point.Position.X - _panStart.X),
                _panOrigin.Y + (point.Position.Y - _panStart.Y));
            Apply();
            e.Handled = true;
            return;
        }

        CanvasMoved?.Invoke(this, new CanvasPointerEventArgs
        {
            ImagePoint = ToImage(point.Position),
            CanvasPoint = point.Position,
            IsLeftButton = point.Properties.IsLeftButtonPressed,
        });
    }

    private void OnReleased(object sender, PointerRoutedEventArgs e)
    {
        _pointerDown = false;

        if (_panning)
        {
            _panning = false;
            Root.ReleasePointerCapture(e.Pointer);
            e.Handled = true;
            return;
        }

        var point = e.GetCurrentPoint(Root);
        Root.ReleasePointerCapture(e.Pointer);
        CanvasReleased?.Invoke(this, new CanvasPointerEventArgs
        {
            ImagePoint = ToImage(point.Position),
            CanvasPoint = point.Position,
            IsLeftButton = point.Properties.IsLeftButtonPressed,
        });
    }

    private void FadeBusy(double to, Action? completed = null)
    {
        var animation = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(180),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(animation, BusyLayer);
        Storyboard.SetTargetProperty(animation, "Opacity");

        var story = new Storyboard();
        story.Children.Add(animation);
        if (completed is not null) story.Completed += (_, _) => completed();
        story.Begin();
    }
}
