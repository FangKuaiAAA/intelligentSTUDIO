using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Dony.Services;
using Dony.Views;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Dony;

public sealed partial class MainWindow : Window
{
    public static DonyApiClient Api { get; } = new();
    public static MainWindow? Instance { get; private set; }

    private readonly HistoryPage _historyPage = new();
    private readonly VoicePage _voicePage = new();
    private readonly FilesPage _filesPage = new();

    public MainWindow()
    {
        InitializeComponent();
        Instance = this;
        Title = "Dony对话";
        TryEnableMica();
        TryEnableRoundedCorners();
        SetupCustomTitleBar();
        TrySetWindowIcon();

        Nav.SelectedItem = Nav.MenuItems[0];
        ContentFrame.Content = _historyPage;

        _ = CheckBackendAsync();
    }

    /// <summary>检查后端是否可用，并刷新当前页面。</summary>
    public async Task<bool> CheckBackendAsync()
    {
        var ok = await Api.PingAsync();
        ConnBar.IsOpen = !ok;
        if (ok)
            await _historyPage.ReloadAsync();
        return ok;
    }

    private async void Retry_Click(object sender, RoutedEventArgs e)
    {
        var ok = await CheckBackendAsync();
        if (ok)
            await ReloadCurrentPageAsync();
    }

    private async Task ReloadCurrentPageAsync()
    {
        if (ContentFrame.Content is HistoryPage h) await h.ReloadAsync();
        else if (ContentFrame.Content is VoicePage v) await v.ReloadAsync();
        else if (ContentFrame.Content is FilesPage f) await f.ReloadAsync();
    }

    private async void Nav_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItem is not NavigationViewItem item) return;
        switch (item.Tag as string)
        {
            case "history":
                ContentFrame.Content = _historyPage;
                await _historyPage.ReloadAsync();
                break;
            case "voice":
                ContentFrame.Content = _voicePage;
                await _voicePage.ReloadAsync();
                break;
            case "files":
                ContentFrame.Content = _filesPage;
                await _filesPage.ReloadAsync();
                break;
        }
    }

    private void TryEnableMica()
    {
        try
        {
            if (MicaController.IsSupported())
                SystemBackdrop = new MicaBackdrop();
        }
        catch { /* 不支持则忽略 */ }
    }

    /// <summary>自绘标题栏：去掉系统标题栏、把内容延伸到标题栏区域，
    /// 并把 XAML 里那条 AppTitleBar 指定为拖动区（系统按钮仍留在右上角）。</summary>
    private void SetupCustomTitleBar()
    {
        try
        {
            // 标题栏高度：与系统对齐，视觉上才不会比系统窗口"高一截"。
            // ⚠ 某些环境（旧系统 / 取不到）TitleBar.Height 会返回 0 —— 那样这一行的
            // 高度就是 0，页面内容会顶到窗口最上边，系统的三个窗口按钮就"压进"了
            // 软件界面里。所以给一个下限兜住。
            var barHeight = AppWindow.TitleBar.Height;
            AppTitleBar.Height = barHeight > 0 ? barHeight : 32;

            // 右侧给系统的三个窗口按钮让位：用系统给的真实占位宽度（写死数值在
            // 不同 DPI/语言下会不对），取不到时退回 138。
            var inset = AppWindow.TitleBar.RightInset;
            AppTitleBar.Margin = new Thickness(0, 0, inset > 0 ? inset : 138, 0);

            ExtendsContentIntoTitleBar = true;
            SetTitleBar(AppTitleBar);

            // 按钮背景透明：配合 Mica/亚克力底，避免标题栏出现一条灰色带
            var tb = AppWindow.TitleBar;
            tb.ButtonBackgroundColor = Microsoft.UI.Colors.Transparent;
            tb.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
            tb.ButtonHoverBackgroundColor = Windows.UI.Color.FromArgb(28, 128, 128, 128);
            tb.ButtonPressedBackgroundColor = Windows.UI.Color.FromArgb(44, 128, 128, 128);
        }
        catch { /* 旧系统上拿不到这些 API 时忽略，退回系统标题栏 */ }
    }

    /// <summary>窗口图标（任务栏/Alt+Tab）。exe 的图标由 csproj 的 ApplicationIcon 负责，
    /// 但窗口自身要单独设一次。图标由 csproj 复制到输出目录。</summary>
    private void TrySetWindowIcon()
    {
        try
        {
            var ico = System.IO.Path.Combine(AppContext.BaseDirectory, "Dony.ico");
            if (System.IO.File.Exists(ico)) AppWindow.SetIcon(ico);
        }
        catch { /* 忽略 */ }
    }

    // 圆角窗口（Windows 11）
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
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref DwmWindowCornerPreference value, int size);
}
