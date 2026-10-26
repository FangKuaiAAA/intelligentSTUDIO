using System;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using DonySettings.Services;
using DonySettings.Views;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace DonySettings;

public sealed partial class MainWindow : Window
{
    public static MainWindow? Instance { get; private set; }

    private readonly HomePage _homePage = new();
    private readonly ModelsPage _modelsPage = new();
    private readonly McpSkillPage _mcpSkillPage = new();
    private readonly WritingAssistPage _writingAssistPage = new();
    private readonly NotificationsPage _notificationsPage = new();
    private readonly GeneralPage _generalPage = new();
    private readonly AboutPage _aboutPage = new();

    public MainWindow()
    {
        InitializeComponent();
        Instance = this;
        Title = "STUDIO设置";
        TryEnableMica();
        TryEnableRoundedCorners();
        SetupCustomTitleBar();
        TrySetWindowIcon();

        Nav.SelectedItem = Nav.MenuItems[0];
        ContentFrame.Content = _homePage;
        _ = _homePage.ReloadAsync();
    }

    /// <summary>按导航标签跳转（「关于」在 FooterMenuItems 中，两处都要查）。</summary>
    public void Navigate(string tag)
    {
        var item = Nav.MenuItems
            .Concat(Nav.FooterMenuItems)
            .OfType<NavigationViewItem>()
            .FirstOrDefault(i => (string?)i.Tag == tag);
        if (item is not null)
            Nav.SelectedItem = item;
    }

    private async void Nav_SelectionChanged(NavigationView sender,
        NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItem is not NavigationViewItem item) return;
        switch (item.Tag as string)
        {
            case "home":
                ContentFrame.Content = _homePage;
                await _homePage.ReloadAsync();
                break;
            case "models":
                ContentFrame.Content = _modelsPage;
                await _modelsPage.ReloadAsync();
                break;
            case "mcp-skill":
                ContentFrame.Content = _mcpSkillPage;
                await _mcpSkillPage.ReloadAsync();
                break;
            case "writing-assist":
                ContentFrame.Content = _writingAssistPage;
                await _writingAssistPage.ReloadAsync();
                break;
            case "notifications":
                ContentFrame.Content = _notificationsPage;
                await _notificationsPage.ReloadAsync();
                break;
            case "general":
                ContentFrame.Content = _generalPage;
                await _generalPage.ReloadAsync();
                break;
            case "about":
                ContentFrame.Content = _aboutPage;
                await _aboutPage.ReloadAsync();
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
        catch { /* 旧系统上拿不到这些 API 时忽略，退回系统标题栏 */ }
    }

    /// <summary>窗口图标（任务栏/Alt+Tab）。exe 的图标由 csproj 的 ApplicationIcon 负责，
    /// 但窗口自身要单独设一次。图标由 csproj 复制到输出目录。</summary>
    private void TrySetWindowIcon()
    {
        try
        {
            var ico = System.IO.Path.Combine(AppContext.BaseDirectory, "intelligentSTUDIO.ico");
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
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr,
        ref DwmWindowCornerPreference value, int size);
}
