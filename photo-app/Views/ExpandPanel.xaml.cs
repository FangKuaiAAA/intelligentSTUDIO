using System;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using PhotoEditor.Controls;
using PhotoEditor.Services;
using Windows.Foundation;
using Windows.Graphics.Imaging;

namespace PhotoEditor.Views;

/// <summary>
/// 扩展：拖拽条决定扩展大小，比例选项决定输出宽高比；
/// 画面上左右拖动照片即可改变它在扩展画布里的位置。
/// 预览用原图的低分辨率放大做模糊延展，确认后交给外部接口补全。
/// </summary>
public sealed partial class ExpandPanel : UserControl, IEditorPanel
{
    private const int PreviewLongEdge = 1100;
    private const int PreviewCanvasLongEdge = 1024;

    // 拖动过程中用低分辨率重建：整幅画布的逐像素拷贝与 GPU 上传量都降到四分之一，
    // 停手后再补一帧完整分辨率。
    private const int FastPreviewCanvasLongEdge = 512;

    private IEditorHost? _host;
    private EditSurface? _surface;

    private SoftwareBitmap? _previewSource;
    private SoftwareBitmap? _previewCanvas;
    private int _version;

    // 扩展大小：相对原图的整体放大倍率，0.25 表示画布边长增加 25%
    private double _scale = 0.25;

    // 输出宽高比；null 表示自由（沿用原图比例）
    private double? _targetRatio;

    // 原图在扩展画布中的归一化位置，0.5 为居中
    private double _offsetX = 0.5;
    private double _offsetY = 0.5;

    private bool _dragging;
    private bool _dragDirty;
    private bool _dragPumping;
    private bool _useApi = true;
    private Point _dragOrigin;
    private double _dragOffsetX;
    private double _dragOffsetY;
    private double _dragSpanX;
    private double _dragSpanY;
    private bool _subscribed;

    public ExpandPanel()
    {
        InitializeComponent();

        foreach (var (label, tag) in new[]
                 {
                     ("自由", "free"),
                     ("1:1 方形", "1:1"),
                     ("4:3 横向", "4:3"),
                     ("3:2 横向", "3:2"),
                     ("16:9 宽幅", "16:9"),
                     ("3:4 纵向", "3:4"),
                     ("9:16 竖屏", "9:16"),
                 })
        {
            RatioBox.Items.Add(new ComboBoxItem { Content = label, Tag = tag });
        }

        RatioBox.SelectedIndex = 0;
        UpdateLabels();
    }

    public string Title => "扩展";

    public string Subtitle => "扩展图片，拖拽以改变位置。";

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
            _subscribed = true;
        }

        if (!host.Session.HasImage) return;

        _previewCanvas?.Dispose();
        _previewCanvas = null;
        _previewSource?.Dispose();
        _previewSource = null;

        // 基于 Latest：裁剪/滤镜/消除的结果都会带进来
        if (host.Session.Latest is { } input)
            _previewSource = await ImageCodec.ResizeToLongEdgeAsync(input, PreviewLongEdge);

        UpdateEngineHint();
        UpdateLabels();

        // 扩展结果本身就是当前画面时直接显示，避免每次切回来又叠加一次扩展；
        // 否则（最后一步是裁剪/滤镜/消除）基于 Latest 重新生成预览。
        if (host.Session.ResultOf(EditStage.Expand) is { } existing
            && ReferenceEquals(existing.Bitmap, host.Session.Latest))
        {
            await _surface.SetBitmapAsync(existing.Bitmap);
            CurrentHint.Visibility = Visibility.Visible;
            CurrentHint.Text = $"已扩展到 {existing.Bitmap.PixelWidth}×{existing.Bitmap.PixelHeight}。"
                               + "调整扩展大小会按当前输入重新计算。";
            return;
        }

        CurrentHint.Visibility = Visibility.Collapsed;
        await RebuildPreviewAsync(preserveView: false);
    }

    public void Deactivate()
    {
        _dragging = false;
        if (_surface is not null && _subscribed)
        {
            _surface.CanvasPressed -= OnCanvasPressed;
            _surface.CanvasMoved -= OnCanvasMoved;
            _surface.CanvasReleased -= OnCanvasReleased;
            _subscribed = false;
        }

        _previewCanvas?.Dispose();
        _previewCanvas = null;
        _previewSource?.Dispose();
        _previewSource = null;
    }

    // ---------- 位置拖拽 ----------

    private void OnCanvasPressed(object? sender, CanvasPointerEventArgs e)
    {
        if (!e.IsLeftButton || _surface?.Bitmap is not { } bitmap) return;

        var insets = ComputeInsets(bitmap.PixelWidth, bitmap.PixelHeight);
        _dragSpanX = Math.Max(1, bitmap.PixelWidth - bitmap.PixelWidth / (1 + insets.Left + insets.Right));
        _dragSpanY = Math.Max(1, bitmap.PixelHeight - bitmap.PixelHeight / (1 + insets.Top + insets.Bottom));

        _dragOrigin = e.CanvasPoint;
        _dragOffsetX = _offsetX;
        _dragOffsetY = _offsetY;
        _dragging = true;
    }

    private void OnCanvasMoved(object? sender, CanvasPointerEventArgs e)
    {
        if (!_dragging || _surface is null) return;

        var scale = Math.Max(0.0001, _surface.ImageScale);
        var dx = (e.CanvasPoint.X - _dragOrigin.X) / scale;
        var dy = (e.CanvasPoint.Y - _dragOrigin.Y) / scale;

        _offsetX = Math.Clamp(_dragOffsetX + dx / _dragSpanX, 0, 1);
        _offsetY = Math.Clamp(_dragOffsetY + dy / _dragSpanY, 0, 1);

        UpdateLabels();

        // 拖动中必须持续出帧，否则只有松手后画面才跳到新位置。
        // 用串行渲染循环而不是防抖：防抖在连续移动时永远等不到「停手」。
        _dragDirty = true;
        _ = PumpDragRenderAsync();
    }

    private async void OnCanvasReleased(object? sender, CanvasPointerEventArgs e)
    {
        if (!_dragging) return;
        _dragging = false;
        _dragDirty = false;

        // 等拖动循环把手上这帧画完，再补完整分辨率，避免低清帧后到覆盖
        while (_dragPumping) await Task.Delay(16);

        await RebuildPreviewAsync(preserveView: true);
    }

    private async Task PumpDragRenderAsync()
    {
        if (_dragPumping) return;
        _dragPumping = true;

        try
        {
            while (_dragDirty && _dragging)
            {
                _dragDirty = false;
                await RebuildPreviewAsync(preserveView: true, fast: true);
            }
        }
        finally
        {
            _dragPumping = false;
        }
    }

    // ---------- 尺寸计算 ----------

    /// <summary>
    /// 由扩展大小、目标比例与归一化位置推导四边扩展量（相对原图）。
    /// 画布始终保证完整容纳原图。
    /// </summary>
    private (double Left, double Top, double Right, double Bottom) ComputeInsets(int width, int height)
    {
        var canvasWidth = width * (1 + _scale);
        var canvasHeight = height * (1 + _scale);

        if (_targetRatio is { } target && target > 0)
        {
            var current = canvasWidth / canvasHeight;
            if (current < target) canvasWidth = canvasHeight * target;
            else if (current > target) canvasHeight = canvasWidth / target;
        }

        // 至少留 2% 余量，避免比例为原图比例时画布没有扩展区
        canvasWidth = Math.Max(canvasWidth, width * 1.02);
        canvasHeight = Math.Max(canvasHeight, height * 1.02);

        var offsetX = _offsetX * (canvasWidth - width);
        var offsetY = _offsetY * (canvasHeight - height);

        return (
            offsetX / width,
            offsetY / height,
            (canvasWidth - width - offsetX) / width,
            (canvasHeight - height - offsetY) / height);
    }

    private void UpdateLabels()
    {
        ExpandLabel.Text = $"{_scale * 100:F0}%";

        var source = _previewSource;
        if (source is null) return;

        var insets = ComputeInsets(source.PixelWidth, source.PixelHeight);
        LeftLabel.Text = $"{insets.Left * 100:F0}%";
        RightLabel.Text = $"{insets.Right * 100:F0}%";
        TopLabel.Text = $"{insets.Top * 100:F0}%";
        BottomLabel.Text = $"{insets.Bottom * 100:F0}%";

        var width = (int)Math.Round(source.PixelWidth * (1 + insets.Left + insets.Right));
        var height = (int)Math.Round(source.PixelHeight * (1 + insets.Top + insets.Bottom));
        SizeLabel.Text = $"输出尺寸约 {width}×{height}";
    }

    // ---------- 预览 ----------

    private void OnExpandChanged(object sender, RangeBaseValueChangedEventArgs e)
    {
        _scale = Math.Max(0.04, e.NewValue / 100.0);
        UpdateLabels();
        ScheduleRebuild();
    }

    private async void ScheduleRebuild()
    {
        var version = ++_version;
        await Task.Delay(90);
        if (version != _version) return;

        // 拖动期间先出一帧低分辨率预览，保证跟手
        await RebuildPreviewAsync(preserveView: true, fast: true);

        // 停手后补一帧完整分辨率，避免画面停在低清
        await Task.Delay(220);
        if (version != _version) return;

        await RebuildPreviewAsync(preserveView: true);
    }

    private async Task RebuildPreviewAsync(bool preserveView, bool fast = false)
    {
        if (_previewSource is null || _surface is null) return;

        var version = _version;
        var source = _previewSource;
        var insets = ComputeInsets(source.PixelWidth, source.PixelHeight);
        var longEdge = fast ? FastPreviewCanvasLongEdge : PreviewCanvasLongEdge;

        var (canvas, _) = await Task.Run(() => ImageProcessor.ComposeOutpaint(
            source, insets.Left, insets.Top, insets.Right, insets.Bottom, longEdge));

        // 低分辨率帧比完整帧先发起，可能后完成；过期就丢弃，不能把画面退回低清
        if (fast && version != _version)
        {
            canvas.Dispose();
            return;
        }

        _previewCanvas?.Dispose();
        _previewCanvas = canvas;

        await _surface.SetBitmapAsync(canvas, preserveView);
    }

    // ---------- 比例 ----------

    private void OnRatioChanged(object sender, SelectionChangedEventArgs e)
    {
        var tag = (RatioBox.SelectedItem as ComboBoxItem)?.Tag as string ?? "free";

        if (tag == "free")
        {
            _targetRatio = null;
        }
        else
        {
            var parts = tag.Split(':');
            if (parts.Length != 2
                || !double.TryParse(parts[0], out var targetWidth)
                || !double.TryParse(parts[1], out var targetHeight)
                || targetHeight <= 0)
                return;

            _targetRatio = targetWidth / targetHeight;
        }

        UpdateLabels();

        if (_surface is not null && _previewSource is not null)
            _ = RebuildPreviewAsync(preserveView: false);
    }

    private void OnResetInsets(object sender, RoutedEventArgs e)
    {
        _scale = 0.25;
        _offsetX = 0.5;
        _offsetY = 0.5;
        _targetRatio = null;
        ExpandSlider.Value = 25;
        RatioBox.SelectedIndex = 0;

        UpdateLabels();
        _ = RebuildPreviewAsync(preserveView: false);
    }

    // ---------- 确认 ----------

    private async void OnExpandClicked(object sender, RoutedEventArgs e)
    {
        if (_host is null) return;
        // 基于 Latest：扩展叠加在裁剪/滤镜之后的结果上
        if (_host.Session.Latest is not { } input) return;

        var insets = ComputeInsets(input.PixelWidth, input.PixelHeight);

        var (canvas, mask) = await Task.Run(() => ImageProcessor.ComposeOutpaint(
            input, insets.Left, insets.Top, insets.Right, insets.Bottom));

        // 提交前把扩展区挖成中性灰：模糊延展会被模型当成已有内容而原样保留
        using var filled = await Task.Run(() => ImageProcessor.FillMasked(canvas, mask));

        var canvasWidth = filled.PixelWidth;
        var canvasHeight = filled.PixelHeight;

        var canvasPng = await ImageCodec.EncodePngAsync(filled);
        var maskPng = await ImageCodec.EncodeMaskPngAsync(mask, canvasWidth, canvasHeight);

        _host.BeginBusy("正在扩展…", bottom: true);
        _host.UpdateBusy("正在扩展…", 0.12);

        try
        {
            byte[] repaired;

            if (_useApi)
            {
                var outcome = await GenerationClient.Instance.InpaintAsync(
                    canvasPng, maskPng, canvasWidth, canvasHeight, outpaint: true,
                    System.Threading.CancellationToken.None);
                repaired = outcome.Png;
            }
            else
            {
                if (!await PhotoServiceClient.Instance.EnsureRunningAsync())
                    throw new InvalidOperationException("推理服务未就绪。请运行 run-photo-editor.bat 后重试。");

                repaired = await PhotoServiceClient.Instance.MoebiusInpaintAsync(
                    canvasPng, maskPng, 20, System.Threading.CancellationToken.None);
            }

            using var returned = await ImageCodec.DecodeAsync(repaired);
            var result = await ImageCodec.ResizeAsync(returned, canvasWidth, canvasHeight);

            _host.Session.Commit(EditStage.Expand, result, insets);
            await _host.RefreshSurfaceAsync();

            AppLog.Info("扩展完成", $"{canvasWidth}×{canvasHeight} {(_useApi ? "接口" : "内置")}");
            _host.ShowToast($"已扩展到 {canvasWidth}×{canvasHeight}。");
        }
        catch (ImageApiException api)
        {
            AppLog.Write("扩展失败", api.Message);
            _host.ShowToast(api.Message, isError: true);
        }
        catch (Exception ex)
        {
            AppLog.Write("扩展失败", $"{ex.GetType().Name}: {ex.Message}");
            _host.ShowToast("扩展没有完成。请稍后重试。", isError: true);
        }
        finally
        {
            _host.EndBusy();
            canvas.Dispose();
        }
    }

    private void OnEngineClicked(object sender, RoutedEventArgs e)
    {
        if (sender is not ToggleButton button) return;

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
