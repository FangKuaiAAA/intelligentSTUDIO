using System;
using System.Threading.Tasks;
using DonySettings.Services;
using IntelligentStudio.Onboarding.Controls;
using IntelligentStudio.Onboarding.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace IntelligentStudio.Onboarding.Views;

/// <summary>1–9 页共用的骨架：媒体（可选）→ 图标标题介绍 → 选项（可选）→ 扩展安装（可选）。</summary>
public sealed partial class StepPage : UserControl, IStepView
{
    private readonly OnboardingStep _step;
    private bool _loading;

    public StepPage(OnboardingStep step)
    {
        InitializeComponent();
        _step = step;
        Apply();
    }

    public void Reload()
    {
        switch (_step.Options)
        {
            case StepOptions.VoiceRead:
                LoadVoiceMode();
                break;
            case StepOptions.WritingDoubleCtrl:
                LoadWriting();
                break;
            case StepOptions.Notifications:
                LoadNotifications();
                break;
        }
    }

    public void PlayMedia()
    {
        if (_step.MediaKind == StepMediaKind.None) return;
        Media.Play();
    }

    public void StopMedia()
    {
        if (_step.MediaKind == StepMediaKind.None) return;
        Media.Stop();
    }

    /// <summary>选项点击即写盘，无需额外提交。</summary>
    public Task<bool> CommitAsync() => Task.FromResult(true);

    // ---------- 布置 ----------

    private void Apply()
    {
        TitleText.Text = _step.Title;
        DescText.Text = _step.Description;
        StepIcon.Source = IconSource(_step.IconFile);

        HeroBlock.Visibility = _step.ShowHero ? Visibility.Visible : Visibility.Collapsed;
        if (_step.ShowHero)
        {
            // 首页：顶部居中图标 + 居中标题与介绍，不显示左侧图标
            HeroIcon.Source = IconSource(_step.IconFile);
            StepIcon.Visibility = Visibility.Collapsed;
            ContentColumn.HorizontalAlignment = HorizontalAlignment.Center;
            TitleText.TextAlignment = TextAlignment.Center;
            TitleText.FontSize = 32;
            DescText.TextAlignment = TextAlignment.Center;
            HeaderText.MaxWidth = 680;
        }

        ConfigureMedia();

        switch (_step.Options)
        {
            case StepOptions.VoiceRead:
                VoiceOptions.Visibility = Visibility.Visible;
                LoadVoiceMode();
                break;
            case StepOptions.WritingDoubleCtrl:
                WritingOption.Visibility = Visibility.Visible;
                LoadWriting();
                break;
            case StepOptions.Notifications:
                NotifyOptions.Visibility = Visibility.Visible;
                LoadNotifications();
                break;
        }

        if (_step.Install != InstallTarget.None)
        {
            InstallBlock.Visibility = Visibility.Visible;
            InstallButton.Content = _step.Install == InstallTarget.Edge ? "准备扩展文件" : "创建共享并注册";
        }
    }

    private void ConfigureMedia()
    {
        if (_step.MediaKind == StepMediaKind.None || string.IsNullOrEmpty(_step.MediaFile))
        {
            Media.Visibility = Visibility.Collapsed;

            if (_step.ShowHero)
            {
                // 首页：整组内容在页面中段（图标 + 标题 + 介绍）
                ContentScroll.Padding = new Thickness(32, 0, 32, 8);
                ContentScroll.VerticalAlignment = VerticalAlignment.Center;
            }
            else
            {
                // 纯文字页：内容在页面中段，避开左上「上一步」
                ContentScroll.Padding = new Thickness(32, 0, 32, 8);
                ContentScroll.VerticalAlignment = VerticalAlignment.Center;
            }
            return;
        }

        var framed = _step.MediaKind is StepMediaKind.FramedImage or StepMediaKind.FramedVideo;
        var video = _step.MediaKind is StepMediaKind.FramedVideo or StepMediaKind.FullVideo;

        // 媒体统一 16:9；无框贴住上、左、右三边，下方给正文留出间距
        Media.Height = framed ? LayoutMetrics.FramedMediaHeight : LayoutMetrics.FullMediaHeight;
        Media.Margin = framed ? new Thickness(32, 24, 32, 10) : new Thickness(0, 0, 0, 18);
        ContentScroll.Padding = new Thickness(32, framed ? 6 : 4, 32, 8);
        Media.Configure(framed, video, _step.MediaFile);
    }

    private static ImageSource? IconSource(string fileName)
    {
        try
        {
            // 优先用同名 png：WinUI3 Image 对部分 ico 编码兼容性差；png 缺失时再退回 ico。
            // 非 MSIX 应用不能用 ms-appx:///，统一用 file:/// 指向 exe 同目录。
            var pngPath = System.IO.Path.Combine(
                AppContext.BaseDirectory, System.IO.Path.ChangeExtension(fileName, ".png"));
            var path = System.IO.File.Exists(pngPath)
                ? pngPath
                : System.IO.Path.Combine(AppContext.BaseDirectory, fileName);
            if (!System.IO.File.Exists(path)) return null;
            return new BitmapImage(new Uri($"file:///{path.Replace('\\', '/')}"));
        }
        catch { return null; }
    }

    // ---------- 朗读回复 ----------

    private void LoadVoiceMode()
    {
        _loading = true;
        var mode = DonyVoiceSettings.Read();
        VoiceOff.IsChecked = mode == VoiceReadMode.Off;
        VoiceAlways.IsChecked = mode == VoiceReadMode.Always;
        VoiceOnly.IsChecked = mode == VoiceReadMode.VoiceOnly;
        _loading = false;
    }

    private void VoiceMode_Checked(object sender, RoutedEventArgs e)
    {
        if (_loading) return;

        var mode = VoiceAlways.IsChecked == true ? VoiceReadMode.Always
                 : VoiceOnly.IsChecked == true ? VoiceReadMode.VoiceOnly
                 : VoiceReadMode.Off;

        try
        {
            DonyVoiceSettings.Write(mode);
            OptionsBar.IsOpen = false;
        }
        catch (Exception ex)
        {
            ShowOptionsError($"朗读设置未能保存。{ex.Message}");
        }
    }

    // ---------- 双击 Ctrl ----------

    private void LoadWriting()
    {
        _loading = true;
        WritingToggle.IsOn = SettingsStore.Instance.GetBool("WRITING_DOUBLE_CTRL", true);
        _loading = false;
    }

    private void Writing_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;

        var store = SettingsStore.Instance;
        store.Set("WRITING_DOUBLE_CTRL", WritingToggle.IsOn);
        try
        {
            store.Save();
            OptionsBar.IsOpen = false;
            _ = store.NotifyBackendAsync();
        }
        catch (Exception ex)
        {
            ShowOptionsError($"书写辅助设置未能保存。{ex.Message}");
        }
    }

    // ---------- 通知智能与勿扰 ----------

    private void LoadNotifications()
    {
        _loading = true;
        var store = SettingsStore.Instance;
        SummaryToggle.IsOn = store.GetBool("NOTIFY_SUMMARY_ENABLED");
        DndToggle.IsOn = store.GetBool("SMART_DND_ENABLED");
        _loading = false;
    }

    private void Notify_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;

        var store = SettingsStore.Instance;
        store.Set("NOTIFY_SUMMARY_ENABLED", SummaryToggle.IsOn);
        store.Set("SMART_DND_ENABLED", DndToggle.IsOn);
        try
        {
            store.Save();
            OptionsBar.IsOpen = false;
            _ = store.NotifyBackendAsync();
        }
        catch (Exception ex)
        {
            ShowOptionsError($"通知设置未能保存。{ex.Message}");
        }
    }

    private void ShowOptionsError(string message)
    {
        OptionsBar.Severity = InfoBarSeverity.Error;
        OptionsBar.Message = message;
        OptionsBar.IsOpen = true;
    }

    // ---------- 扩展安装 ----------

    private async void Install_Click(object sender, RoutedEventArgs e)
    {
        InstallButton.IsEnabled = false;
        InstallProgress.Visibility = Visibility.Visible;
        InstallProgress.IsActive = true;
        InstallHint.Text = "正在安装，可能需要几秒。";
        InstallHint.Visibility = Visibility.Visible;
        InstallBar.IsOpen = false;

        try
        {
            var outcome = await InstallCoordinator.RunAsync(_step.Install);
            var (severity, message) = InstallCoordinator.Describe(_step.Install, outcome);

            InstallBar.Severity = severity;
            InstallBar.Message = message;
            InstallBar.IsOpen = true;
            InstallHint.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            InstallBar.Severity = InfoBarSeverity.Error;
            InstallBar.Message = $"安装未能完成。{ex.Message}";
            InstallBar.IsOpen = true;
            InstallHint.Visibility = Visibility.Collapsed;
        }
        finally
        {
            InstallProgress.IsActive = false;
            InstallProgress.Visibility = Visibility.Collapsed;
            InstallButton.IsEnabled = true;
        }
    }
}
