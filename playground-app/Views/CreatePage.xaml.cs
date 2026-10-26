using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Controls;
using ImagePlayground.Models;
using ImagePlayground.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;
using Windows.UI;

namespace ImagePlayground.Views;

/// <summary>
/// 新建页：已选元素条 → 中央画布 → 两行建议元素 → 彩虹输入框 / 风格 / 生成。
/// 生成完成后仍可增删元素并再次生成；保存会先写入历史库，再弹出系统另存对话框。
/// </summary>
public sealed partial class CreatePage : UserControl
{
    private readonly ImageGenerationService _service = new();

    private CancellationTokenSource? _cts;
    private GenerationResult? _lastResult;
    private bool _generating;

    public CreatePage()
    {
        InitializeComponent();

        foreach (var preset in StylePreset.All)
            StyleBox.Items.Add(preset);
        StyleBox.DisplayMemberPath = nameof(StylePreset.Name);
        StyleBox.SelectedIndex = 0;

        Strip.Changed += (_, _) =>
        {
            Suggestions.SetSelected(Strip.SelectedElementIds);
            UpdateGenerateButton();
        };

        Suggestions.ElementSelected += (_, element) =>
        {
            // 同一预设元素不重复添加：再次点击直接忽略
            if (Strip.ContainsElement(element.Id)) return;
            Strip.Add(ElementChipModel.FromElement(element));
        };

        Orb.ShareRequested += Orb_ShareRequested;
        Orb.SaveRequested += Orb_SaveRequested;
        Orb.RetryRequested += (_, _) => _ = GenerateAsync();

        Loaded += OnLoaded;
        UpdateGenerateButton();
    }

    /// <summary>演示模式（--demo）不读取模型配置，用内置素材走完整生成流程。</summary>
    private static bool NeedsConfiguration =>
        !App.DemoMode && !SettingsStore.Instance.HasImageModel;

    private const string ConfigureHint =
        "尚未配置图像模型\n在「STUDIO 设置」的「模型」页填写接口地址与模型名称。";

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        // 启动时不预设任何报错：未配置模型的问题在用户点「启动」后再于圆内提示
    }

    private void CanvasHost_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        // 结果方形 = 直径 × 4/3，先保证方形放得下
        var available = Math.Min(e.NewSize.Width, e.NewSize.Height) - 6;
        var diameter = Math.Min(420, available / (4.0 / 3.0));
        Orb.SetDiameter(diameter);
    }

    private void PromptInput_Submitted(object? sender, string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        Strip.Add(ElementChipModel.FromText(text));
        PromptInput.FadeRainbow();
    }

    private void Strip_Changed(object? sender, EventArgs e) => UpdateGenerateButton();

    private void UpdateGenerateButton()
    {
        if (_generating) return;
        GenerateButton.IsEnabled = true;
    }

    private async void Generate_Click(object sender, RoutedEventArgs e) => await GenerateAsync();

    private async Task GenerateAsync()
    {
        if (_generating) return;

        if (!App.DemoMode && Strip.IsEmpty && string.IsNullOrWhiteSpace(PromptInput.Text))
        {
            // 只提示，不把焦点抢到输入框（否则彩虹会被点亮，像被"唤醒"）
            ShowStatus("先选择元素，或输入描述。", warning: true);
            return;
        }

        if (NeedsConfiguration)
        {
            Orb.Fail(ConfigureHint, true);
            ShowStatus("尚未配置图像模型", warning: true);
            return;
        }

        _generating = true;
        GenerateButton.IsEnabled = false;   // 文字保持「启动」，仅按钮置灰
        PromptInput.FadeRainbow();
        ShowStatus("正在生成…");
        Orb.BeginGenerating();

        var style = StyleBox.SelectedItem as StylePreset ?? StylePreset.All[0];
        var request = new GenerationRequest
        {
            Elements = Strip.Elements.ToList(),
            Texts = Strip.Texts.ToList(),
            StyleKey = style.Key,
            Size = 1024,
        };

        var progress = new Progress<double>(p => Orb.SetProgress(p));
        _cts?.Dispose();
        _cts = new CancellationTokenSource();

        try
        {
            var result = await _service.GenerateAsync(request, progress, _cts.Token);
            _lastResult = result;
            Orb.Complete(result.FilePath);
            ShowStatus(result.Provider == "demo" ? "已生成 · 演示模式" : $"已生成 · {style.Name}");
        }
        catch (OperationCanceledException)
        {
            Orb.ShowIdle();
            ShowStatus("已取消");
        }
        catch (ImageGenerationException ex)
        {
            Orb.Fail(ex.Message, ex.IsConfigurationError);
            ShowStatus(ex.IsConfigurationError ? "尚未配置图像模型" : "生成失败。请重试。", warning: true);
        }
        catch (Exception ex)
        {
            AppLog.Write("生成异常", ex.GetType().Name);
            Orb.Fail("生成失败\n请重试。", false);
            ShowStatus("生成失败。请重试。", warning: true);
        }
        finally
        {
            _generating = false;
            GenerateButton.IsEnabled = true;
        }
    }

    private void Orb_ShareRequested(object? sender, EventArgs e)
    {
        var window = MainWindow.Instance;
        if (_lastResult is null || window is null) return;
        ShareService.ShowMenu(window, Orb.ShareAnchor, _lastResult.FilePath, "图乐园作品");
    }

    private async void Orb_SaveRequested(object? sender, EventArgs e)
    {
        var window = MainWindow.Instance;
        if (_lastResult is null || window is null) return;

        var style = StyleBox.SelectedItem as StylePreset ?? StylePreset.All[0];
        try
        {
            var entry = await HistoryStore.Instance.AddAsync(
                _lastResult.FilePath,
                _lastResult.FinalPrompt,
                style.Key,
                Strip.ElementNames,
                1024);

            var saved = await SaveService.SaveCopyAsync(
                window, _lastResult.FilePath, $"图乐园_{entry.CreatedAt:yyyyMMdd_HHmm}");

            ShowStatus(saved ? "已保存" : "已保存到历史");
        }
        catch (ImageGenerationException ex)
        {
            ShowStatus(ex.Message, warning: true);
        }
        catch (Exception ex)
        {
            AppLog.Write("保存失败", ex.GetType().Name);
            ShowStatus("保存失败。请重试。", warning: true);
        }
    }

    private void OnEscape(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        if (!_generating) return;
        _cts?.Cancel();
        args.Handled = true;
    }

    private void ShowStatus(string text, bool warning = false)
    {
        StatusText.Text = text;
        StatusText.Foreground = new SolidColorBrush(warning
            ? Color.FromArgb(255, 0xE0, 0x9A, 0x96)
            : Color.FromArgb(255, 0x7A, 0x7A, 0x82));
    }
}
