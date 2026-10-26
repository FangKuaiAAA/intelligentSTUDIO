using System;
using System.Collections.Generic;
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
/// 消除：涂抹 → 分割模型把笔迹扩张为单个元素 → 掩码外扩后交补全模型。
/// 笔迹与元素轮廓共用一套彩虹流转语言，补全完成后一起消失。
/// </summary>
public sealed partial class ErasePanel : UserControl, IEditorPanel
{
    private readonly Polyline _rainbowStroke = new()
    {
        StrokeThickness = 26,
        StrokeLineJoin = PenLineJoin.Round,
        StrokeStartLineCap = PenLineCap.Round,
        StrokeEndLineCap = PenLineCap.Round,
        Opacity = 0.55,
        IsHitTestVisible = false,
    };

    private readonly Polyline _whiteStroke = new()
    {
        StrokeThickness = 9,
        StrokeLineJoin = PenLineJoin.Round,
        StrokeStartLineCap = PenLineCap.Round,
        StrokeEndLineCap = PenLineCap.Round,
        Opacity = 0.9,
        IsHitTestVisible = false,
    };

    private readonly LinearGradientBrush _rainbowBrush = new()
    {
        StartPoint = new Point(0, 0.5),
        EndPoint = new Point(1, 0.5),
    };

    private readonly LinearGradientBrush _whiteBrush = new()
    {
        StartPoint = new Point(0, 0.5),
        EndPoint = new Point(1, 0.5),
    };

    private readonly DispatcherTimer _animTimer = new() { Interval = TimeSpan.FromMilliseconds(80) };
    private readonly DispatcherTimer _progressTimer = new() { Interval = TimeSpan.FromMilliseconds(420) };

    private readonly List<Point> _imagePoints = new();
    private readonly List<Point> _canvasPoints = new();

    private IEditorHost? _host;
    private EditSurface? _surface;
    private MaskGlow? _glow;

    private string? _sessionId;
    private SoftwareBitmap? _sessionSource;
    private byte[]? _maskPng;
    private bool _useApi;
    private int _maskVersion;
    private int _segmentVersion;
    private double _phase;
    private double _progressValue;
    private bool _drawing;
    private bool _subscribed;
    private bool _prepared;

    public ErasePanel()
    {
        InitializeComponent();

        for (var i = 0; i < 4; i++)
            _rainbowBrush.GradientStops.Add(new GradientStop { Color = Colors.Transparent, Offset = i / 3.0 });
        for (var i = 0; i < 3; i++)
            _whiteBrush.GradientStops.Add(new GradientStop { Color = Colors.Transparent, Offset = i / 2.0 });

        _rainbowStroke.Stroke = _rainbowBrush;
        _whiteStroke.Stroke = _whiteBrush;

        _animTimer.Tick += (_, _) => AdvanceStroke();
        _progressTimer.Tick += (_, _) =>
        {
            _progressValue = Math.Min(0.9, _progressValue + 0.03);
            _host?.UpdateBusy("正在消除…", _progressValue);
        };

        UpdateEngineHint();
    }

    public string Title => "消除";

    public string Subtitle => "在图片上轻点，轻刷以选取物体元素，边缘轮廓将被自动描绘。";

    public FrameworkElement View => this;

    public async void Activate(IEditorHost host)
    {
        _host = host;
        _surface = host.Surface;
        _surface.DragMode = CanvasDragMode.Custom;

        if (!_subscribed)
        {
            _surface.CanvasPressed += OnCanvasPressed;
            _surface.CanvasMoved += OnCanvasMoved;
            _surface.CanvasReleased += OnCanvasReleased;
            // 指针被系统夺走时按已画轨迹提交，否则笔画会停在半路
            _surface.CanvasCancelled += OnCanvasCancelled;
            _subscribed = true;
        }

        if (!host.Session.HasImage)
        {
            EraseButton.IsEnabled = false;
            return;
        }

        _surface.OverlayCanvas.Children.Clear();
        _surface.OverlayCanvas.Children.Add(_rainbowStroke);
        _surface.OverlayCanvas.Children.Add(_whiteStroke);

        // 基于 Latest：无论上一步是裁剪、滤镜还是扩展，都从当前画面继续
        await _surface.SetBitmapAsync(host.Session.Latest);

        // 总是检查一次：输入换过（尺寸/内容变化）时会重建分割会话
        await EnsureSessionAsync();
    }

    public void Deactivate()
    {
        _animTimer.Stop();
        _progressTimer.Stop();

        if (_surface is not null)
        {
            _surface.CanvasPressed -= OnCanvasPressed;
            _surface.CanvasMoved -= OnCanvasMoved;
            _surface.CanvasReleased -= OnCanvasReleased;
            _surface.CanvasCancelled -= OnCanvasCancelled;
            _surface.DragMode = CanvasDragMode.Pan;
            _surface.OverlayCanvas.Children.Clear();
            // MaskCanvas 是所有面板共用的图层，必须整层清空：
            // 只移除 _glow 会漏掉此前因版本过期而没被回收的轮廓。
            _surface.MaskCanvas.Children.Clear();
            RemoveGlow();
        }

        _subscribed = false;
        // 分割会话在服务端是常驻的，切面板不必重建；
        // 之前每次清空导致回到面板后前几秒涂不上，必须先点一下触发重建。
        ResetWork();
    }

    private async Task EnsureSessionAsync()
    {
        if (_host?.Session.Latest is not { } input) return;

        // 输入换了（裁剪/滤镜/扩展之后），旧会话的坐标系已经对不上，
        // 必须按新画面重建，否则涂抹位置会整体偏移。
        if (_prepared && _sessionId is not null && ReferenceEquals(input, _sessionSource))
            return;

        _prepared = false;
        _sessionId = null;
        _sessionSource = input;

        EraseButton.IsEnabled = false;

        if (!await PhotoServiceClient.Instance.EnsureRunningAsync())
        {
            EngineHint.Text = "推理服务未启动。运行 run-photo-editor.bat 后再试。";
            return;
        }

        try
        {
            var png = await ImageCodec.EncodePngAsync(input);
            _sessionId = await PhotoServiceClient.Instance.CreateSessionAsync(png);
            _prepared = true;
            EraseButton.IsEnabled = true;
            AppLog.Info("分割会话就绪", $"{_sessionId[..8]} {input.PixelWidth}×{input.PixelHeight}");
            UpdateEngineHint();
        }
        catch (Exception ex)
        {
            AppLog.Write("建立分割会话失败", ex.GetType().Name);
            EngineHint.Text = "分割模型未能载入。请检查模型文件后重试。";
        }
    }

    // ---------- 笔迹 ----------

    private void OnCanvasPressed(object? sender, CanvasPointerEventArgs e)
    {
        AppLog.Info("画布按下", $"left={e.IsLeftButton} session={(_sessionId is null ? "无" : "有")}");

        // 会话可能还在建立，先把笔迹画出来，松手时再等待会话
        if (_surface is null || !e.IsLeftButton) return;

        _drawing = true;
        _imagePoints.Clear();
        _canvasPoints.Clear();
        _rainbowStroke.Points.Clear();
        _whiteStroke.Points.Clear();
        RemoveGlow();

        AppendPoint(e);
        ApplyBrushWidth();
        _animTimer.Start();
    }

    private void OnCanvasMoved(object? sender, CanvasPointerEventArgs e)
    {
        if (!_drawing || _surface is null) return;
        if (_canvasPoints.Count > 0)
        {
            var last = _canvasPoints[^1];
            var dx = e.CanvasPoint.X - last.X;
            var dy = e.CanvasPoint.Y - last.Y;
            if (dx * dx + dy * dy < 9) return;
        }

        if (_canvasPoints.Count == 1) AppLog.Info("画布移动", $"{e.ImagePoint.X:F0},{e.ImagePoint.Y:F0}");
        AppendPoint(e);
    }

    private async void OnCanvasReleased(object? sender, CanvasPointerEventArgs e)
    {
        if (!_drawing) return;
        _drawing = false;
        _animTimer.Stop();
        await SegmentAsync();
    }

    private void OnCanvasCancelled(object? sender, EventArgs e)
    {
        if (!_drawing) return;

        // 指针被系统夺走时只丢弃这一笔：半截轨迹提交给分割模型会命中无关区域，
        // 比丢失一次涂抹更糟。
        _drawing = false;
        _animTimer.Stop();
        _imagePoints.Clear();
        _canvasPoints.Clear();
        _rainbowStroke.Points.Clear();
        _whiteStroke.Points.Clear();
    }

    private void AppendPoint(CanvasPointerEventArgs e)
    {
        if (_surface is null) return;

        var imagePoint = e.ImagePoint;
        var canvasPoint = _surface.ToCanvas(imagePoint);

        _imagePoints.Add(new Point(
            Math.Clamp(imagePoint.X, 0, _surface.Bitmap?.PixelWidth ?? imagePoint.X),
            Math.Clamp(imagePoint.Y, 0, _surface.Bitmap?.PixelHeight ?? imagePoint.Y)));
        _canvasPoints.Add(canvasPoint);

        _rainbowStroke.Points.Add(canvasPoint);
        _whiteStroke.Points.Add(canvasPoint);
    }

    private void ApplyBrushWidth()
    {
        var size = BrushSlider.Value;
        _rainbowStroke.StrokeThickness = size * 0.72;
        _whiteStroke.StrokeThickness = Math.Max(4, size * 0.26);
    }

    private void OnBrushChanged(object sender, RangeBaseValueChangedEventArgs e)
    {
        BrushLabel.Text = $"{(int)e.NewValue}";
        ApplyBrushWidth();
    }

    private void AdvanceStroke()
    {
        _phase += 0.006;

        for (var i = 0; i < _rainbowBrush.GradientStops.Count; i++)
            _rainbowBrush.GradientStops[i].Color = RainbowPalette.At((float)(_phase + i / 3.0), 0.85f);

        var center = (_phase * 9.0) % 1.0;
        for (var i = 0; i < _whiteBrush.GradientStops.Count; i++)
        {
            var offset = Math.Clamp(center + (i - 1) * 0.24, 0, 1);
            var distance = Math.Abs(offset - (center + (i - 1) * 0.24));
            var alpha = (byte)Math.Round(255 * Math.Max(0, 1 - distance / 0.24));
            _whiteBrush.GradientStops[i].Offset = offset;
            _whiteBrush.GradientStops[i].Color = Color.FromArgb(alpha, 255, 255, 255);
        }
    }

    // ---------- 分割 ----------

    private async Task SegmentAsync()
    {
        if (_surface?.Bitmap is null || _imagePoints.Count < 1) return;

        // 连续涂抹时会有多次请求在途，只让最后发起的那次落地
        var version = ++_segmentVersion;

        if (_sessionId is null)
        {
            await EnsureSessionAsync();
            if (_sessionId is null) return;
        }

        // 单点也交给分割模型，满足「点选一个物体」的用法
        var samples = Sample(_imagePoints, 14);

        try
        {
            AppLog.Info("提交分割", $"{samples.Count} 点");

            var response = await PhotoServiceClient.Instance.SegmentAsync(_sessionId, samples, null);
            if (version != _segmentVersion) return;

            AppLog.Info("分割返回", $"found={response.Found} mask={(string.IsNullOrEmpty(response.Mask) ? "空" : "有")}");

            if (!response.Found || string.IsNullOrEmpty(response.Mask))
            {
                _host?.ShowToast("未识别到完整物体。请扩大涂选范围后重试。");
                return;
            }

            _maskPng = Convert.FromBase64String(response.Mask);
            await ShowGlowAsync(_maskPng);

            _rainbowStroke.Points.Clear();
            _whiteStroke.Points.Clear();
        }
        catch (Exception ex)
        {
            AppLog.Write("分割失败", ex.GetType().Name);
            _host?.ShowToast("识别失败。请扩大涂选范围后重试。", isError: true);
        }
    }

    private async Task ShowGlowAsync(byte[] maskPng)
    {
        if (_surface is null) return;

        using var maskBitmap = await ImageCodec.DecodeAsync(maskPng);
        var width = maskBitmap.PixelWidth;
        var height = maskBitmap.PixelHeight;

        var mask = await ImageCodec.DecodeMaskAsync(maskPng, width, height);
        var thickness = Math.Max(3, Math.Max(width, height) / 340);
        var outline = ImageProcessor.MaskOutline(mask, width, height, thickness);
        var rgba = ImageProcessor.MaskToRgba(outline, width, height, 255, 255, 255, 255);

        using var outlineBitmap = ImageCodec.FromBgra(width, height, rgba);

        RemoveGlow();

        // 遮罩生成期间用户可能已经开始下一笔，过期的轮廓不能再显示
        var version = ++_maskVersion;
        var glow = new MaskGlow();
        _glow = glow;

        Canvas.SetLeft(glow, 0);
        Canvas.SetTop(glow, 0);
        _surface.MaskCanvas.Children.Add(glow);

        await glow.SetMaskAsync(outlineBitmap);
        if (version != _maskVersion || _glow != glow)
        {
            // 已过期：轮廓在上一步就挂到了共享层上，必须移除，
            // 否则会变成无人认领的"元素选框"留在画布上。
            _surface.MaskCanvas.Children.Remove(glow);
            return;
        }

        glow.Start();
    }

    private void RemoveGlow()
    {
        _maskVersion++;
        if (_glow is null) return;
        _glow.Stop();
        _surface?.MaskCanvas.Children.Remove(_glow);
        _glow = null;
    }

    private static List<Point> Sample(List<Point> points, int max)
    {
        if (points.Count <= max) return new List<Point>(points);

        var result = new List<Point>(max);
        var step = (points.Count - 1) / (double)(max - 1);
        for (var i = 0; i < max; i++)
            result.Add(points[(int)Math.Round(i * step)]);
        return result;
    }

    // ---------- 补全 ----------

    private async void OnEraseClicked(object sender, RoutedEventArgs e)
    {
        if (_host is null || _maskPng is null)
        {
            AppLog.Info("消除被跳过", $"host={_host is not null} mask={_maskPng is not null}");
            _host?.ShowToast("先在照片上涂抹要去掉的内容。");
            return;
        }

        // 基于 Latest：连续消除在上一次结果上叠加，也承接裁剪/滤镜
        if (_host.Session.Latest is not { } input) return;

        var width = input.PixelWidth;
        var height = input.PixelHeight;

        var mask = await ImageCodec.DecodeMaskAsync(_maskPng, width, height);

        // 先在 API 尺寸上缩放（取块内最大值，细线不丢），再膨胀与羽化。
        // 反过来（原图尺寸膨胀后再缩小）会让膨胀量被缩放稀释约 2/3，
        // 物体边缘的半透明像素漏在遮罩外，消除后留下鬼影。
        var (apiWidth, apiHeight) = ImageProcessor.FitForApi(width, height, 1536);

        var apiMask = ImageProcessor.ResizeMaskMax(mask, width, height, apiWidth, apiHeight);
        var radius = Math.Max(3, (int)Math.Round(Math.Max(apiWidth, apiHeight) * 0.006));
        apiMask = ImageProcessor.DilateMask(apiMask, apiWidth, apiHeight, radius);
        apiMask = ImageProcessor.FeatherMask(apiMask, apiWidth, apiHeight, 2);

        SoftwareBitmap? scaled = null;
        if (apiWidth != width || apiHeight != height)
            scaled = ImageProcessor.Resize(input, apiWidth, apiHeight);

        var maskPng = await ImageCodec.EncodeMaskPngAsync(apiMask, apiWidth, apiHeight);
        var imagePng = await ImageCodec.EncodePngAsync(scaled ?? input);

        _host.BeginBusy("正在消除…");
        _progressValue = 0.12;
        _progressTimer.Start();

        try
        {
            byte[] repaired;

            if (_useApi)
            {
                var outcome = await GenerationClient.Instance.InpaintAsync(
                    imagePng, maskPng, apiWidth, apiHeight, outpaint: false,
                    System.Threading.CancellationToken.None);
                repaired = outcome.Png;
            }
            else
            {
                if (!await PhotoServiceClient.Instance.EnsureRunningAsync())
                    throw new InvalidOperationException("推理服务未就绪。请运行 run-photo-editor.bat 后重试。");

                // 内置模型不需要提示词，直接按遮罩局部重绘
                repaired = await PhotoServiceClient.Instance.MoebiusInpaintAsync(
                    imagePng, maskPng, 20, System.Threading.CancellationToken.None);
            }

            using var returned = await ImageCodec.DecodeAsync(repaired);
            var result = await ImageCodec.ResizeAsync(returned, width, height);

            _host.Session.Commit(EditStage.Erase, result, null);
            await _host.RefreshSurfaceAsync();

            AppLog.Info("消除完成", _useApi ? "接口" : "内置");
            _host.ShowToast("已消除所选内容。");
        }
        catch (Exception ex)
        {
            AppLog.Write("消除失败", $"{ex.GetType().Name}: {ex.Message}");
            _host.ShowToast($"消除没有完成：{ex.Message}", isError: true);
        }
        finally
        {
            scaled?.Dispose();
            _progressTimer.Stop();
            _host.EndBusy();
            ResetWork();
        }
    }

    private void OnClearClicked(object sender, RoutedEventArgs e)
    {
        ResetWork();
    }

    private void ResetWork()
    {
        _drawing = false;
        _animTimer.Stop();
        _imagePoints.Clear();
        _canvasPoints.Clear();
        _rainbowStroke.Points.Clear();
        _whiteStroke.Points.Clear();
        _maskPng = null;
        RemoveGlow();
    }

    private void OnEngineClicked(object sender, RoutedEventArgs e)
    {
        if (sender is not ToggleButton button) return;

        // 两个选项必须保留一个，点击已选中的不取消
        if (button.IsChecked != true)
        {
            button.IsChecked = true;
            return;
        }

        _useApi = button.Tag as string == "api";
        EngineBuiltin.IsChecked = !_useApi;
        EngineApi.IsChecked = _useApi;
        UpdateEngineHint();
    }

    private void UpdateEngineHint()
    {
        EngineHint.Text = _useApi && !GenerationClient.Instance.IsCloudAvailable
            ? "接口未配置。"
            : string.Empty;
    }
}
