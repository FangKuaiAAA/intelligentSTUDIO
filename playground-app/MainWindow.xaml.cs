using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using ImagePlayground.Views;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics;

namespace ImagePlayground;

public sealed partial class MainWindow : Window
{
    private const int DefaultWidth = 1240;
    private const int DefaultHeight = 900;

    private readonly CreatePage _createPage = new();
    private readonly HistoryPage _historyPage = new();

    private string _currentTag = "";

    public static MainWindow? Instance { get; private set; }

    public MainWindow()
    {
        InitializeComponent();
        Instance = this;
        Title = "图乐园";

        TryEnableMica();
        TryEnableRoundedCorners();
        SetupCustomTitleBar();
        TrySetWindowIcon();
        ResizeAndCenter();

        // IsChecked 在 XAML 字面量赋值会触发 ToggleButton 的属性设置异常，这里改用代码设置
        NavNew.IsChecked = true;
        ShowPage("new", animate: false);
    }

    /// <summary>供页面请求切换（历史页空态里的「去新建」使用）。</summary>
    public void Navigate(string tag)
    {
        if (tag == "new") NavNew.IsChecked = true;
        else if (tag == "history") NavHistory.IsChecked = true;
    }

    private void NavNew_Checked(object sender, RoutedEventArgs e) => ShowPage("new");
    private void NavHistory_Checked(object sender, RoutedEventArgs e) => ShowPage("history");

    private void ShowPage(string tag, bool animate = true)
    {
        if (_currentTag == tag) return;
        var direction = tag == "history" ? 1 : -1;
        _currentTag = tag;

        FrameworkElement page;
        if (tag == "history")
        {
            page = _historyPage;
            _ = _historyPage.ReloadAsync();
        }
        else
        {
            page = _createPage;
        }

        PageHost.Content = page;
        if (animate) AnimatePageIn(direction);
        else
        {
            PageShift.X = 0;
            PageHost.Opacity = 1;
        }
    }

    /// <summary>
    /// 页面切换：横向 18px 位移 + 淡入，280ms 指数减速。
    /// 注意：不能对页面宿主做 Composition Offset 动画 —— 那是布局偏移，覆盖后页面会跑到窗口左上角。
    /// </summary>
    private void AnimatePageIn(int direction)
    {
        PageShift.X = direction * 18;
        PageHost.Opacity = 0;

        var story = new Storyboard();
        var slide = new DoubleAnimation
        {
            To = 0,
            Duration = TimeSpan.FromMilliseconds(300),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(slide, PageShift);
        Storyboard.SetTargetProperty(slide, "X");

        var fade = new DoubleAnimation
        {
            To = 1,
            Duration = TimeSpan.FromMilliseconds(230),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(fade, PageHost);
        Storyboard.SetTargetProperty(fade, "Opacity");

        story.Children.Add(slide);
        story.Children.Add(fade);
        story.Begin();
    }

    private void TryEnableMica()
    {
        try
        {
            if (MicaController.IsSupported())
                SystemBackdrop = new MicaBackdrop();
        }
        catch { /* 不支持则退回默认背景 */ }
    }

    private void ResizeAndCenter()
    {
        try
        {
            AppWindow.Resize(new SizeInt32(DefaultWidth, DefaultHeight));
            var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
            var work = area.WorkArea;
            var x = work.X + Math.Max(0, (work.Width - DefaultWidth) / 2);
            var y = work.Y + Math.Max(0, (work.Height - DefaultHeight) / 2);
            AppWindow.Move(new PointInt32(x, y));
        }
        catch { /* 忽略 */ }
    }

    private void SetupCustomTitleBar()
    {
        try
        {
            var barHeight = AppWindow.TitleBar.Height;
            AppTitleBar.Height = barHeight > 0 ? barHeight : 32;

            var inset = AppWindow.TitleBar.RightInset;
            AppTitleBar.Margin = new Thickness(0, 0, inset > 0 ? inset : 138, 0);

            ExtendsContentIntoTitleBar = true;
            SetTitleBar(AppTitleBar);

            var tb = AppWindow.TitleBar;
            tb.ButtonBackgroundColor = Microsoft.UI.Colors.Transparent;
            tb.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
            tb.ButtonHoverBackgroundColor = Windows.UI.Color.FromArgb(28, 128, 128, 128);
            tb.ButtonPressedBackgroundColor = Windows.UI.Color.FromArgb(44, 128, 128, 128);
        }
        catch { /* 旧系统上忽略 */ }
    }

    private void TrySetWindowIcon()
    {
        try
        {
            var ico = System.IO.Path.Combine(AppContext.BaseDirectory, "图乐园.ico");
            if (!System.IO.File.Exists(ico)) return;

            AppWindow.SetIcon(ico);

            // 标题栏图标走绝对路径，避免解包应用下 ms-appx 解析中文文件名失败
            TitleIcon.Source = new BitmapImage(new Uri(ico));
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
}
