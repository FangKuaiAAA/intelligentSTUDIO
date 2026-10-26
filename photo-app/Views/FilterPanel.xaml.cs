using System;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using PhotoEditor.Controls;
using PhotoEditor.Services;
using Windows.Graphics.Imaging;

namespace PhotoEditor.Views;

/// <summary>
/// 滤镜：六条滑块与八种预设。预览走降采样图，确认时对全分辨率重算一次。
/// </summary>
public sealed partial class FilterPanel : UserControl, IEditorPanel
{
    private const int PreviewLongEdge = 1400;

    private IEditorHost? _host;
    private EditSurface? _surface;

    private SoftwareBitmap? _previewSource;
    private SoftwareBitmap? _previewOutput;
    private FilterSettings _settings = new();

    private bool _suppress;
    private int _version;

    public FilterPanel()
    {
        InitializeComponent();
    }

    public string Title => "滤镜";

    public string Subtitle => "调整明暗与色彩，或套用预设。";

    public FrameworkElement View => this;

    public async void Activate(IEditorHost host)
    {
        _host = host;
        _surface = host.Surface;
        _surface.DragMode = CanvasDragMode.Pan;

        if (!host.Session.HasImage) return;

        _previewOutput?.Dispose();
        _previewOutput = null;
        _previewSource?.Dispose();
        _previewSource = null;

        // 基于 Latest：上一步裁剪的结果会带进来，滤镜预览才看得到裁剪
        if (host.Session.Latest is { } input)
            _previewSource = await ImageCodec.ResizeToLongEdgeAsync(input, PreviewLongEdge);

        if (host.Session.ResultOf(EditStage.Filter)?.Parameters is FilterSettings saved)
            _settings = saved.Clone();
        else
            _settings = new FilterSettings();

        LoadSliders(_settings);

        await _surface.SetBitmapAsync(host.Session.Latest);
    }

    public void Deactivate()
    {
        _previewOutput?.Dispose();
        _previewOutput = null;
        _previewSource?.Dispose();
        _previewSource = null;
    }

    private void LoadSliders(FilterSettings settings)
    {
        _suppress = true;
        BrightnessSlider.Value = settings.Brightness;
        ContrastSlider.Value = settings.Contrast;
        SaturationSlider.Value = settings.Saturation;
        TemperatureSlider.Value = settings.Temperature;
        SharpenSlider.Value = settings.Sharpen;
        VignetteSlider.Value = settings.Vignette;
        _suppress = false;

        UpdateLabels();
    }

    private void UpdateLabels()
    {
        BrightnessLabel.Text = Format(_settings.Brightness);
        ContrastLabel.Text = Format(_settings.Contrast);
        SaturationLabel.Text = Format(_settings.Saturation);
        TemperatureLabel.Text = Format(_settings.Temperature);
        SharpenLabel.Text = Format(_settings.Sharpen);
        VignetteLabel.Text = Format(_settings.Vignette);
    }

    private static string Format(double value) =>
        value > 0 ? $"+{value:0}" : $"{value:0}";

    private void ReadSliders()
    {
        _settings.Brightness = BrightnessSlider.Value;
        _settings.Contrast = ContrastSlider.Value;
        _settings.Saturation = SaturationSlider.Value;
        _settings.Temperature = TemperatureSlider.Value;
        _settings.Sharpen = SharpenSlider.Value;
        _settings.Vignette = VignetteSlider.Value;
        UpdateLabels();
    }

    private async void OnSliderChanged(object sender, RangeBaseValueChangedEventArgs e)
    {
        if (_suppress || _surface is null) return;

        ReadSliders();

        // 连续拖动时只渲染最后一帧：版本号丢弃过期任务
        var version = ++_version;
        await Task.Delay(70);
        if (version != _version) return;

        await RebuildPreviewAsync(version);
    }

    private async Task RebuildPreviewAsync(int version)
    {
        if (_previewSource is null || _surface is null) return;

        var settings = _settings.Clone();
        var width = _previewSource.PixelWidth;
        var height = _previewSource.PixelHeight;

        var copy = SoftwareBitmap.Copy(_previewSource);
        await Task.Run(() =>
        {
            ImageCodec.WithPixels(copy, (pixels, stride, _) =>
                ImageProcessor.ApplyFilters(pixels, stride, width, height, settings));
        });

        // 拖动过程中可能有多次预览并发，只允许最后一次替换画面
        if (version != _version)
        {
            copy.Dispose();
            return;
        }

        // 先换图再释放旧位图，避免画布仍引用已释放对象
        var previous = _previewOutput;
        _previewOutput = copy;

        await _surface.SetBitmapAsync(copy, preserveView: true);

        if (_previewOutput == copy) previous?.Dispose();
    }

    private async void OnPresetClicked(object sender, RoutedEventArgs e)
    {
        if (_suppress) return;
        if (sender is not ToggleButton button) return;

        // 再次点击已选中的预设：取消选中，参数保持不变。
        // ToggleButton 已自行把 IsChecked 置回 false，这里不能再强行回选。
        if (button.IsChecked != true)
        {
            _suppress = true;
            foreach (var item in new[] { PresetNone, PresetVivid, PresetSoft, PresetMono, PresetVintage, PresetCool, PresetWarm, PresetDrama })
                item.IsChecked = false;
            _suppress = false;
            return;
        }

        var tag = button.Tag as string ?? "none";

        _suppress = true;
        foreach (var item in new[] { PresetNone, PresetVivid, PresetSoft, PresetMono, PresetVintage, PresetCool, PresetWarm, PresetDrama })
            item.IsChecked = ReferenceEquals(item, button);
        _suppress = false;

        _settings = Preset(tag);
        LoadSliders(_settings);
        await RebuildPreviewAsync(++_version);
    }

    private static FilterSettings Preset(string tag) => tag switch
    {
        "vivid" => new FilterSettings { Brightness = 4, Contrast = 18, Saturation = 28, Sharpen = 25, Vignette = 8 },
        "soft" => new FilterSettings { Brightness = 8, Contrast = -14, Saturation = -6, Vignette = 18 },
        "mono" => new FilterSettings { Saturation = -100, Contrast = 12 },
        "vintage" => new FilterSettings { Brightness = 4, Contrast = -8, Saturation = -32, Temperature = 22, Vignette = 22 },
        "cool" => new FilterSettings { Contrast = 6, Saturation = 6, Temperature = -32 },
        "warm" => new FilterSettings { Saturation = 8, Temperature = 30 },
        "drama" => new FilterSettings { Contrast = 30, Saturation = -12, Sharpen = 40, Vignette = 26 },
        _ => new FilterSettings(),
    };

    private async void OnReset(object sender, RoutedEventArgs e)
    {
        _settings = new FilterSettings();
        LoadSliders(_settings);

        _suppress = true;
        PresetNone.IsChecked = true;
        foreach (var item in new[] { PresetVivid, PresetSoft, PresetMono, PresetVintage, PresetCool, PresetWarm, PresetDrama })
            item.IsChecked = false;
        _suppress = false;

        await RebuildPreviewAsync(++_version);
    }

    private async void OnApply(object sender, RoutedEventArgs e)
    {
        if (_host is null) return;
        // 基于 Latest：裁剪之后再调色也能叠加
        if (_host.Session.Latest is not { } input) return;

        if (_settings.IsNeutral)
        {
            _host.ShowToast("没有需要应用的调整。");
            return;
        }

        var settings = _settings.Clone();
        var width = input.PixelWidth;
        var height = input.PixelHeight;
        var copy = SoftwareBitmap.Copy(input);

        await Task.Run(() =>
        {
            ImageCodec.WithPixels(copy, (pixels, stride, _) =>
                ImageProcessor.ApplyFilters(pixels, stride, width, height, settings));
        });

        _host.Session.Commit(EditStage.Filter, copy, settings);
        await _host.RefreshSurfaceAsync();

        AppLog.Info("应用滤镜", $"亮度{settings.Brightness:0} 对比度{settings.Contrast:0} 饱和度{settings.Saturation:0}");
        _host.ShowToast("已应用调整。");
    }
}
