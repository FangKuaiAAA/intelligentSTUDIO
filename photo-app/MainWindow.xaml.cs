using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using PhotoEditor.Controls;
using PhotoEditor.Services;
using PhotoEditor.Views;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;
using Windows.Storage;
using Windows.Storage.Pickers;

namespace PhotoEditor;

public sealed partial class MainWindow : Window, IEditorHost
{
    private const int DefaultWidth = 1280;
    private const int DefaultHeight = 864;

    private readonly Dictionary<string, IEditorPanel> _panels = new();
    private readonly Dictionary<string, RadioButton> _navItems = new();
    private readonly DispatcherTimer _toastTimer = new();

    private string _currentTag = "Crop";
    private bool _locked;
    private bool _restoringNav;

    public EditSession Session { get; } = new();

    public EditSurface Surface => SurfaceView;

    public Panel CanvasHost => CanvasArea;

    public bool IsGenerating => _locked;

    public MainWindow()
    {
        InitializeComponent();
        Title = "照片编辑器";

        TryEnableMica();
        TryEnableRoundedCorners();
        SetupCustomTitleBar();
        TrySetWindowIcon();
        ResizeAndCenter();

        _navItems["Crop"] = NavCrop;
        _navItems["Filter"] = NavFilter;
        _navItems["Erase"] = NavErase;
        _navItems["Expand"] = NavExpand;
        _navItems["Reframe"] = NavReframe;

        _panels["Crop"] = new CropPanel();
        _panels["Filter"] = new FilterPanel();
        _panels["Erase"] = new ErasePanel();
        _panels["Expand"] = new ExpandPanel();
        _panels["Reframe"] = new ReframePanel();

        _toastTimer.Interval = TimeSpan.FromSeconds(3);
        _toastTimer.Tick += (_, _) =>
        {
            _toastTimer.Stop();
            Toast.IsOpen = false;
        };

        RootGrid.DragOver += OnDragOver;
        RootGrid.DragLeave += (_, _) => SetDropHighlight(false);
        RootGrid.Drop += OnDrop;
        Closed += (_, _) => Session.Reset();

        Session.Committed += OnStageCommitted;

        NavCrop.IsChecked = true;
        ShowPanel("Crop", animate: false);

        ShellMenuLabel.Text = ShellIntegration.IsRegistered ? "已添加到右键菜单" : "添加到右键菜单";

        if (App.StartupImagePath is { } path)
            _ = LoadImageAsync(path);

        // 必须等窗口真正加载后再定位：未进入可视树时 TransformToVisual 会抛异常
        RootGrid.Loaded += (_, _) => MoveRailHighlight(NavCrop, animate: false);
    }

    // ---------- 导航 ----------

    private void OnNavChecked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string tag }) return;

        if (_locked && tag != _currentTag)
        {
            // 生成期间不允许离开当前工具：把选中状态还给原来那一项
            _restoringNav = true;
            if (_navItems.TryGetValue(_currentTag, out var current)) current.IsChecked = true;
            _restoringNav = false;
            return;
        }

        if (_restoringNav) return;
        ShowPanel(tag);
        MoveRailHighlight(sender as RadioButton);
    }

    // ---------- 撤销 / 恢复（仅消除、扩展、重构） ----------

    // 快照存成 PNG 而不是位图：整图位图约 48 MB 一份，20 份会把内存吃满导致卡死
    private readonly System.Collections.Generic.List<(EditStage Stage, byte[] Png)> _history = new();
    private int _historyIndex = -1;
    private bool _restoringHistory;

    private async void OnStageCommitted(EditStage stage)
    {
        try
        {
            if (_restoringHistory) return;
            if (stage is not (EditStage.Erase or EditStage.Expand or EditStage.Reframe)) return;
            if (Session.Latest is not { } latest) return;

            var png = await ImageCodec.EncodePngAsync(latest);

            // 新提交会截断前进分支
            for (var i = _history.Count - 1; i > _historyIndex; i--)
                _history.RemoveAt(i);

            _history.Add((stage, png));
            _historyIndex = _history.Count - 1;

            while (_history.Count > 20)
            {
                _history.RemoveAt(0);
                _historyIndex--;
            }

            UpdateHistoryButtons();
        }
        catch (Exception ex)
        {
            AppLog.Write("历史记录失败", $"{ex.GetType().Name}: {ex.Message}");
        }
    }

    private void ClearHistory()
    {
        _history.Clear();
        _historyIndex = -1;
        UpdateHistoryButtons();
    }

    private void UpdateHistoryButtons()
    {
        UndoButton.IsEnabled = _historyIndex >= 0;
        RedoButton.IsEnabled = _historyIndex < _history.Count - 1;
    }

    private async void OnUndoClicked(object sender, RoutedEventArgs e)
    {
        if (_historyIndex < 0) return;

        _restoringHistory = true;
        try
        {
            if (_historyIndex == 0)
            {
                // 撤销第一次提交：直接清掉该级结果，回到提交前的画面
                Session.InvalidateFrom(_history[0].Stage, disposeSelf: true);
                _historyIndex = -1;
            }
            else
            {
                _historyIndex--;
                var target = _history[_historyIndex];
                using var snapshot = await ImageCodec.DecodeAsync(target.Png);
                Session.Restore(target.Stage, snapshot);
            }
        }
        finally
        {
            _restoringHistory = false;
        }

        await SurfaceView.SetBitmapAsync(Session.Latest, preserveView: true);
        UpdateHistoryButtons();
    }

    private async void OnRedoClicked(object sender, RoutedEventArgs e)
    {
        if (_historyIndex >= _history.Count - 1) return;

        _restoringHistory = true;
        try
        {
            _historyIndex++;
            var target = _history[_historyIndex];
            using var snapshot = await ImageCodec.DecodeAsync(target.Png);
            Session.Restore(target.Stage, snapshot);
        }
        finally
        {
            _restoringHistory = false;
        }

        await SurfaceView.SetBitmapAsync(Session.Latest, preserveView: true);
        UpdateHistoryButtons();
    }

    /// <summary>把左侧的高亮块滑到当前项，而不是每项各自切换背景。</summary>
    private void MoveRailHighlight(RadioButton? item, bool animate = true)
    {
        if (item is null) return;

        double y;
        try
        {
            y = item.TransformToVisual(RailHost).TransformPoint(new Windows.Foundation.Point(0, 0)).Y;
            // 高亮块比项矮一圈，垂直居中
            y += Math.Max(0, (item.ActualHeight - RailHighlight.Height) / 2);
        }
        catch
        {
            // 目标还不在可视树中（面板尚未加载），等下一次导航再定位
            return;
        }

        // 首次定位（面板还没布局、高亮尚不可见）直接落位，不做动画
        if (!animate || RailHighlight.Opacity < 0.5)
        {
            RailHighlightShift.Y = y;
            RailHighlight.Opacity = 1;
            return;
        }

        var slide = new DoubleAnimation
        {
            To = y,
            Duration = TimeSpan.FromMilliseconds(220),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            EnableDependentAnimation = true,
        };
        Storyboard.SetTarget(slide, RailHighlightShift);
        Storyboard.SetTargetProperty(slide, "Y");

        var story = new Storyboard();
        story.Children.Add(slide);
        story.Begin();
    }

    private void ShowPanel(string tag, bool animate = false)
    {
        if (!_panels.TryGetValue(tag, out var panel)) return;

        if (_panels.TryGetValue(_currentTag, out var previous) && previous != panel)
            previous.Deactivate();

        _currentTag = tag;
        PanelTitle.Text = panel.Title;
        PanelSubtitle.Text = panel.Subtitle;
        PanelHost.Content = panel.View;
        panel.Activate(this);

        // 切换面板不做位移/淡入：内容区高度依赖实时布局，
        // 动画期间会先按 0 尺寸适配一次，看起来就是画面闪一下、图片大小跳变。
        if (!animate)
        {
            PanelShift.X = 0;
            PanelHost.Opacity = 1;
            return;
        }

        PanelShift.X = 12;
        PanelHost.Opacity = 0;

        var story = new Storyboard();
        var slide = new DoubleAnimation
        {
            To = 0,
            Duration = TimeSpan.FromMilliseconds(180),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(slide, PanelShift);
        Storyboard.SetTargetProperty(slide, "X");

        var fade = new DoubleAnimation
        {
            To = 1,
            Duration = TimeSpan.FromMilliseconds(200),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(fade, PanelHost);
        Storyboard.SetTargetProperty(fade, "Opacity");

        story.Children.Add(slide);
        story.Children.Add(fade);
        story.Begin();
    }

    // ---------- 图像载入 ----------

    private async void OnOpenClicked(object sender, RoutedEventArgs e)
    {
        var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.PicturesLibrary };
        foreach (var ext in new[] { ".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".heic" })
            picker.FileTypeFilter.Add(ext);

        WinRT.Interop.InitializeWithWindow.Initialize(picker,
            WinRT.Interop.WindowNative.GetWindowHandle(this));

        var file = await picker.PickSingleFileAsync();
        if (file is null) return;
        await LoadImageAsync(file.Path);
    }

    private async Task LoadImageAsync(string path)
    {
        try
        {
            var bitmap = await ImageCodec.DecodeAsync(path);
            Session.Open(bitmap, path);
            ClearHistory();
            await RefreshSurfaceAsync();

            ExportButton.IsEnabled = true;
            FadeEmptyState(0);

            AppLog.Info("打开照片", $"{Path.GetFileName(path)} {bitmap.PixelWidth}×{bitmap.PixelHeight}");

            ShowPanel(_currentTag, animate: false);
        }
        catch (Exception ex)
        {
            AppLog.Write("打开照片失败", $"{ex.GetType().Name}: {ex.Message}");
            ShowToast("无法打开这张照片。请换一种格式再试。", isError: true);
        }
    }

    public async Task RefreshSurfaceAsync()
    {
        await Surface.SetBitmapAsync(Session.Latest);
        Surface.ApplyFit();

    }

    private void FadeEmptyState(double to)
    {
        if (to <= 0 && EmptyState.Opacity <= 0.01) return;

        var animation = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(260),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(animation, EmptyState);
        Storyboard.SetTargetProperty(animation, "Opacity");

        var story = new Storyboard();
        story.Children.Add(animation);
        story.Completed += (_, _) =>
        {
            EmptyState.IsHitTestVisible = to > 0.5;
            EmptyState.Visibility = to > 0.5 ? Visibility.Visible : Visibility.Collapsed;
        };
        story.Begin();
    }

    // ---------- 右键菜单 ----------

    private void OnShellMenuClicked(object sender, RoutedEventArgs e)
    {
        if (ShellIntegration.IsRegistered)
        {
            ShellIntegration.Unregister();
            ShellMenuLabel.Text = "添加到右键菜单";
            ShowToast("已从右键菜单移除。");
            return;
        }

        if (ShellIntegration.Register())
        {
            ShellMenuLabel.Text = "已添加到右键菜单";
            ShowToast("已添加。右键点击图片即可使用。");
        }
        else
        {
            ShowToast("未能写入右键菜单。", isError: true);
        }
    }

    // ---------- 拖拽 ----------

    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        e.AcceptedOperation = DataPackageOperation.Copy;
        e.DragUIOverride.Caption = "打开照片";
        e.DragUIOverride.IsCaptionVisible = true;
        SetDropHighlight(true);
    }

    private void SetDropHighlight(bool active)
    {
        var animation = new DoubleAnimation
        {
            To = active ? 1 : 0,
            Duration = TimeSpan.FromMilliseconds(140),
        };
        Storyboard.SetTarget(animation, DropFrame);
        Storyboard.SetTargetProperty(animation, "Opacity");

        var story = new Storyboard();
        story.Children.Add(animation);
        story.Begin();

        DropHint.Opacity = active ? 1 : 0;
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        SetDropHighlight(false);
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;

        var items = await e.DataView.GetStorageItemsAsync();
        if (items.Count == 0 || items[0] is not StorageFile file) return;

        await LoadImageAsync(file.Path);
    }

    // ---------- 导出 ----------

    private async void OnExportClicked(object sender, RoutedEventArgs e)
    {
        if (Session.Latest is not { } bitmap) return;

        var picker = new FileSavePicker
        {
            SuggestedStartLocation = PickerLocationId.PicturesLibrary,
            SuggestedFileName = $"照片编辑_{DateTime.Now:yyyyMMdd_HHmm}",
        };
        picker.FileTypeChoices.Add("PNG 图片", new List<string> { ".png" });
        picker.FileTypeChoices.Add("JPEG 图片", new List<string> { ".jpg" });

        WinRT.Interop.InitializeWithWindow.Initialize(picker,
            WinRT.Interop.WindowNative.GetWindowHandle(this));

        var file = await picker.PickSaveFileAsync();
        if (file is null) return;

        try
        {
            await ImageCodec.WriteAsync(bitmap, file);
            AppLog.Info("导出", $"{bitmap.PixelWidth}×{bitmap.PixelHeight} {file.FileType}");
            ShowToast("已导出。");
        }
        catch (Exception ex)
        {
            AppLog.Write("导出失败", ex.GetType().Name);
            ShowToast("无法写入所选位置。请换一个文件夹重试。", isError: true);
        }
    }

    // ---------- 生成态 ----------

    public void BeginBusy(string text, bool bottom = false)
    {
        _locked = true;
        Surface.ShowBusy(text, bottom);
        ExportButton.IsEnabled = false;
    }

    public void UpdateBusy(string text, double progress)
    {
        Surface.SetBusyText(text);
        Surface.SetBusyProgress(progress);
    }

    public void EndBusy()
    {
        _locked = false;
        Surface.HideBusy();
        ExportButton.IsEnabled = Session.HasImage;
    }

    public void ShowToast(string message, bool isError = false)
    {
        Toast.Severity = isError ? InfoBarSeverity.Error : InfoBarSeverity.Success;
        Toast.Message = message;
        Toast.IsOpen = true;
        _toastTimer.Stop();
        _toastTimer.Start();
    }

    // ---------- 窗口外观 ----------

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
            var ico = Path.Combine(AppContext.BaseDirectory, "照片智能编辑器.ico");
            if (!File.Exists(ico)) return;

            AppWindow.SetIcon(ico);
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
