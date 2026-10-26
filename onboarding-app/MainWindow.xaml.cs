using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using IntelligentStudio.Onboarding.Services;
using IntelligentStudio.Onboarding.Views;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.Graphics;
using Windows.UI.ViewManagement;

namespace IntelligentStudio.Onboarding;

public sealed partial class MainWindow : Window
{
    /// <summary>顶部浮层高度：标题栏按钮与拖动区域都以它为基准。</summary>
    private const int TopBarHeight = 52;

    private readonly IReadOnlyList<OnboardingStep> _steps = StepCatalog.Create();
    private readonly Dictionary<int, FrameworkElement> _views = new();
    private readonly UISettings _uiSettings = new();

    private int _index;
    private FrameworkElement? _currentView;
    private bool _transitioning;

    private readonly int _startIndex;

    /// <param name="startIndex">调试用起始页（0 基）；由 --step 参数指定。</param>
    public MainWindow(int startIndex = 0)
    {
        _startIndex = Math.Clamp(startIndex, 0, StepCatalog.Create().Count - 1);
        InitializeComponent();
        Title = "intelligentSTUDIO";
        ConfigureWindow();
        RootGrid.Loaded += RootGrid_Loaded;
    }

    private async void RootGrid_Loaded(object sender, RoutedEventArgs e)
    {
        RootGrid.Loaded -= RootGrid_Loaded;
        _index = _startIndex;
        await GoToAsync(_startIndex, animate: false);
        if (AnimationsEnabled)
        {
            RootGrid.Opacity = 0;
            await FadeAsync(RootGrid, 0, 1, 180);
        }
    }

    // ---------- 窗口外观 ----------

    private void ConfigureWindow()
    {
        var width = LayoutMetrics.WindowWidth;
        var height = LayoutMetrics.WindowHeight;

        // 低分辨率屏幕放不下整窗时按工作区收缩，媒体高度随之按内容区收缩
        try
        {
            var workArea = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
            width = Math.Min(width, Math.Max(760, workArea.Width - 24));
            height = Math.Min(height, Math.Max(560, workArea.Height - 24));
        }
        catch { /* 取不到工作区时按设计尺寸 */ }

        try
        {
            var scale = DpiScale();
            AppWindow.Resize(new SizeInt32(
                (int)Math.Round(width * scale),
                (int)Math.Round(height * scale)));

            if (AppWindow.Presenter is OverlappedPresenter presenter)
            {
                presenter.IsResizable = false;
                presenter.IsMaximizable = false;
                presenter.IsMinimizable = false;
            }
        }
        catch { /* 拿不到窗口尺寸时退回默认尺寸，不影响流程 */ }

        LayoutMetrics.ApplyContentHeight(height - LayoutMetrics.FooterHeight);

        SetupChrome();
        TryEnableMica();
        TryEnableRoundedCorners();
        TrySetWindowIcon();
    }

    private double DpiScale()
    {
        try
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
            var dpi = GetDpiForWindow(hwnd);
            return dpi > 0 ? dpi / 96.0 : 1.0;
        }
        catch { return 1.0; }
    }

    /// <summary>
    /// 去掉系统标题栏与系统按钮，只保留边框与圆角；拖动区域由非客户区「标题栏」矩形提供，
    /// 并避开左上「上一步」与右上关闭，避免按钮被非客户区吞掉点击。
    /// </summary>
    private void SetupChrome()
    {
        var custom = false;
        try
        {
            if (AppWindow.Presenter is OverlappedPresenter presenter)
            {
                presenter.SetBorderAndTitleBar(true, false);

                var scale = DpiScale();
                var left = (int)Math.Round(152 * scale);
                var right = (int)Math.Round(56 * scale);
                var width = Math.Max(0, AppWindow.Size.Width - left - right);
                if (width > 0)
                {
                    var region = new RectInt32(left, 0, width, (int)Math.Round(TopBarHeight * scale));
                    InputNonClientPointerSource.GetForWindowId(AppWindow.Id)
                        .SetRegionRects(NonClientRegionKind.Caption, new[] { region });
                    custom = true;
                }
            }
        }
        catch { custom = false; }

        if (custom) return;

        // 老系统：退回「内容延伸到标题栏」，此时系统按钮仍存在，隐藏自绘关闭按钮避免重复
        try
        {
            ExtendsContentIntoTitleBar = true;
            SetTitleBar(DragBar);
            DragBar.IsHitTestVisible = true;
            CloseButton.Visibility = Visibility.Collapsed;
            BackButton.Margin = new Thickness(0);
        }
        catch { /* 两种方案都不可用时保留自绘按钮，窗口不可拖动 */ }
    }

    private void TryEnableMica()
    {
        try
        {
            if (MicaController.IsSupported())
            {
                SystemBackdrop = new MicaBackdrop();
                return;
            }
        }
        catch { /* 忽略 */ }

        // 不支持 Mica 时给一层实色底，避免透出桌面
        try
        {
            RootGrid.Background = (Brush)Application.Current.Resources["ApplicationPageBackgroundThemeBrush"];
        }
        catch { /* 忽略 */ }
    }

    private void TryEnableRoundedCorners()
    {
        try
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
            var pref = DwmWindowCornerPreference.Round;
            _ = DwmSetWindowAttribute(hwnd, DwmwaWindowCornerPreference, ref pref, sizeof(int));
        }
        catch { /* 旧系统忽略 */ }
    }

    private void TrySetWindowIcon()
    {
        try
        {
            var ico = System.IO.Path.Combine(AppContext.BaseDirectory, "intelligentSTUDIO.ico");
            if (System.IO.File.Exists(ico)) AppWindow.SetIcon(ico);
        }
        catch { /* 忽略 */ }
    }

    // ---------- 步骤切换 ----------

    private FrameworkElement GetOrCreateView(int index)
    {
        if (_views.TryGetValue(index, out var cached))
        {
            (cached as IStepView)?.Reload();
            return cached;
        }

        var step = _steps[index];
        FrameworkElement view = step.Kind switch
        {
            StepKind.Welcome => new WelcomeStepPage(step),
            StepKind.Models => new ModelStepPage(step),
            _ => new StepPage(step),
        };
        _views[index] = view;
        return view;
    }

    private async Task GoToAsync(int index, bool animate)
    {
        if (_transitioning) return;
        _transitioning = true;
        PrimaryButton.IsEnabled = false;
        BackButton.IsEnabled = false;
        try
        {
            (_currentView as IStepView)?.StopMedia();

            if (animate && _currentView is not null && AnimationsEnabled)
                await AnimateOutAsync(_currentView);

            var view = GetOrCreateView(index);
            StepHost.Children.Clear();
            StepHost.Children.Add(view);
            _currentView = view;
            _index = index;
            UpdateChrome();

            if (animate && AnimationsEnabled)
                await AnimateInAsync(view);
            else
            {
                view.Opacity = 1;
                if (view.RenderTransform is TranslateTransform reset) reset.Y = 0;
            }

            (view as IStepView)?.PlayMedia();
        }
        catch
        {
            // 切换失败不影响下一次导航：视图仍在容器里，按钮已恢复可用
        }
        finally
        {
            _transitioning = false;
            PrimaryButton.IsEnabled = true;
            BackButton.IsEnabled = true;
        }
    }

    private void UpdateChrome()
    {
        var isLast = _index == _steps.Count - 1;
        BackButton.Visibility = _index > 0 && !isLast ? Visibility.Visible : Visibility.Collapsed;
        PrimaryButton.Content = isLast ? "完成" : "继续";
    }

    private async void Back_Click(object sender, RoutedEventArgs e)
        => await GoToAsync(_index - 1, animate: true);

    private async void Primary_Click(object sender, RoutedEventArgs e)
    {
        if (_transitioning) return;

        var view = _currentView as IStepView;
        if (view is not null)
        {
            _transitioning = true;
            PrimaryButton.IsEnabled = false;
            bool committed;
            try { committed = await view.CommitAsync(); }
            catch { committed = false; }
            finally
            {
                _transitioning = false;
                PrimaryButton.IsEnabled = true;
            }
            if (!committed) return;
        }

        if (_index == _steps.Count - 1)
        {
            await FinishAsync();
            return;
        }

        await GoToAsync(_index + 1, animate: true);
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    // ---------- 完成 ----------

    private async Task FinishAsync()
    {
        try { OnboardingState.MarkCompleted(); }
        catch { /* 标记写不进去不阻断流程 */ }

        if (!SettingsAppLauncher.TryLaunch(out var detail))
            await ShowLaunchFailureAsync(detail);

        if (AnimationsEnabled) await FadeAsync(RootGrid, 1, 0, 140);
        Close();
    }

    private async Task ShowLaunchFailureAsync(string detail)
    {
        try
        {
            var dialog = new ContentDialog
            {
                Title = "未能打开 STUDIO 设置",
                Content = new TextBlock
                {
                    TextWrapping = TextWrapping.Wrap,
                    Text = "引导已完成，但设置窗口没有启动。请在开始菜单打开「STUDIO 设置」，或重新运行智能工作室安装程序。\n\n" + detail,
                },
                CloseButtonText = "知道了",
                DefaultButton = ContentDialogButton.Close,
                XamlRoot = RootGrid.XamlRoot,
            };
            await dialog.ShowAsync();
        }
        catch { /* 对话框失败时直接关闭窗口 */ }
    }

    // ---------- 动效 ----------

    private bool AnimationsEnabled
    {
        get
        {
            try { return _uiSettings.AnimationsEnabled; }
            catch { return true; }
        }
    }

    private static Task AnimateInAsync(UIElement element)
    {
        var transform = new TranslateTransform { Y = 18 };
        element.RenderTransform = transform;
        element.Opacity = 0;

        var ease = new ExponentialEase { EasingMode = EasingMode.EaseOut, Exponent = 6 };

        var storyboard = new Storyboard();
        var fade = new DoubleAnimation
        {
            To = 1,
            Duration = TimeSpan.FromMilliseconds(230),
            EasingFunction = ease,
        };
        Storyboard.SetTarget(fade, element);
        Storyboard.SetTargetProperty(fade, "Opacity");

        var slide = new DoubleAnimation
        {
            To = 0,
            Duration = TimeSpan.FromMilliseconds(250),
            EasingFunction = ease,
        };
        Storyboard.SetTarget(slide, transform);
        Storyboard.SetTargetProperty(slide, "Y");

        storyboard.Children.Add(fade);
        storyboard.Children.Add(slide);
        return RunAsync(storyboard);
    }

    private static Task AnimateOutAsync(UIElement element)
    {
        if (element.RenderTransform is not TranslateTransform transform)
        {
            transform = new TranslateTransform();
            element.RenderTransform = transform;
        }

        var ease = new CubicEase { EasingMode = EasingMode.EaseIn };

        var storyboard = new Storyboard();
        var fade = new DoubleAnimation
        {
            To = 0,
            Duration = TimeSpan.FromMilliseconds(90),
            EasingFunction = ease,
        };
        Storyboard.SetTarget(fade, element);
        Storyboard.SetTargetProperty(fade, "Opacity");

        var slide = new DoubleAnimation
        {
            To = -8,
            Duration = TimeSpan.FromMilliseconds(90),
            EasingFunction = ease,
        };
        Storyboard.SetTarget(slide, transform);
        Storyboard.SetTargetProperty(slide, "Y");

        storyboard.Children.Add(fade);
        storyboard.Children.Add(slide);
        return RunAsync(storyboard);
    }

    private static Task FadeAsync(UIElement element, double from, double to, int milliseconds)
    {
        element.Opacity = from;
        var animation = new DoubleAnimation
        {
            From = from,
            To = to,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(animation, element);
        Storyboard.SetTargetProperty(animation, "Opacity");

        var storyboard = new Storyboard();
        storyboard.Children.Add(animation);
        return RunAsync(storyboard);
    }

    /// <summary>动画完成回调缺失时也不让导航卡住。</summary>
    private static async Task RunAsync(Storyboard storyboard)
    {
        var completion = new TaskCompletionSource<object?>();
        storyboard.Completed += (_, _) => completion.TrySetResult(null);
        storyboard.Begin();
        await Task.WhenAny(completion.Task, Task.Delay(700));
    }

    // ---------- 原生窗口 API ----------

    private const int DwmwaWindowCornerPreference = 33;

    private enum DwmWindowCornerPreference
    {
        Default = 0,
        DoNotRound = 1,
        Round = 2,
        RoundSmall = 3,
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr,
        ref DwmWindowCornerPreference value, int size);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);
}
