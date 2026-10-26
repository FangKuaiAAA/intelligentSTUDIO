using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Storage.Pickers;

namespace Dony.Views;

public sealed partial class FilesPage : Page
{
    private readonly ObservableCollection<string> _paths = new();
    private readonly List<(CheckBox Box, string Letter)> _driveBoxes = new();
    private DonySettings? _settings;

    public FilesPage()
    {
        InitializeComponent();
        PathList.ItemsSource = _paths;
    }

    public async Task ReloadAsync()
    {
        try
        {
            _settings = await MainWindow.Api.GetSettingsAsync();
            if (_settings is null) return;
            // 开关的开启含义就是「只访问指定文件夹」，说明文字固定讲开启后的效果，
            // 关闭时的默认范围不用再解释（列表随之变灰，用户自己就能推断）。
            DefaultToggle.IsOn = !_settings.UseDefaultPaths;
            _paths.Clear();
            foreach (var p in _settings.AllowedPaths) _paths.Add(p);
            BuildQuickButtons(_settings.UserFolders);
            BuildDriveButtons(_settings);
            ApplyMode();
        }
        catch (Exception ex)
        {
            ShowResult(InfoBarSeverity.Error, "无法读取文件权限", "请确认 Dony 正在运行，然后重试。");
            Debug.WriteLine($"[files] 读取失败：{ex}");
        }
    }

    /// <summary>盘符选择：系统盘标注「系统盘」，选中即允许访问。</summary>
    private void BuildDriveButtons(DonySettings s)
    {
        DriveToggle.IsOn = !s.UseDefaultDrives;   // 先定开关状态，再据此决定勾选框可用性
        DriveList.Items.Clear();
        _driveBoxes.Clear();
        foreach (var d in s.Drives)
        {
            var box = new CheckBox { Content = d.IsSystem ? $"{d.Drive}:（系统盘）" : $"{d.Drive}:" };
            box.IsChecked = s.AllowedDrives.Contains(d.Drive, StringComparer.OrdinalIgnoreCase);
            box.IsEnabled = DriveToggle.IsOn;
            _driveBoxes.Add((box, d.Drive));
            DriveList.Items.Add(box);
        }
    }

    private void BuildQuickButtons(Dictionary<string, string> folders)
    {
        QuickPanel.Items.Clear();
        foreach (var (label, path) in folders)
        {
            if (string.IsNullOrWhiteSpace(path)) continue;
            var btn = new Button { Content = label, Padding = new Thickness(10, 4, 10, 4) };
            ToolTipService.SetToolTip(btn, path);
            btn.Click += (_, _) => AddPath(path);
            QuickPanel.Items.Add(btn);
        }
    }

    private void ApplyMode()
    {
        var custom = DefaultToggle.IsOn;   // 开启 = 只访问指定文件夹
        CustomPanel.Opacity = custom ? 1.0 : 0.45;
        AddButton.IsEnabled = custom;
        ClearButton.IsEnabled = custom;
        PathList.IsEnabled = custom;
    }

    private void Default_Toggled(object sender, RoutedEventArgs e) => ApplyMode();

    private void Drive_Toggled(object sender, RoutedEventArgs e)
    {
        var on = DriveToggle.IsOn;
        foreach (var (box, _) in _driveBoxes) box.IsEnabled = on;
    }

    private void AddPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        if (!_paths.Any(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase)))
            _paths.Add(path);
    }

    private async void AddFolder_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var picker = new FolderPicker();
            picker.FileTypeFilter.Add("*");
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(MainWindow.Instance!);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);
            var folder = await picker.PickSingleFolderAsync();
            if (folder is not null) AddPath(folder.Path);
        }
        catch (Exception ex)
        {
            ShowResult(InfoBarSeverity.Error, "没能添加文件夹", "请重新选择一次。");
            Debug.WriteLine($"[files] 选择文件夹失败：{ex}");
        }
    }

    private void RemovePath_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is string path)
            _paths.Remove(path);
    }

    private void Clear_Click(object sender, RoutedEventArgs e) => _paths.Clear();

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        Busy.IsActive = true;
        SaveButton.IsEnabled = false;
        try
        {
            var patch = new SettingsPatch
            {
                UseDefaultPaths = !DefaultToggle.IsOn,
                AllowedPaths = _paths.ToList(),
            };
            if (DriveToggle.IsOn)
            {
                var drives = _driveBoxes.Where(b => b.Box.IsChecked == true)
                                        .Select(b => b.Letter).ToList();
                if (drives.Count == 0)
                {
                    ShowResult(InfoBarSeverity.Warning, "至少要勾选一个磁盘", "或者关掉「限制磁盘」。");
                    return;
                }
                patch.AllowedDrives = drives;
            }
            else
            {
                patch.UseDefaultDrives = true;
            }
            var updated = await MainWindow.Api.UpdateSettingsAsync(patch);
            if (updated is not null)
            {
                _paths.Clear();
                foreach (var p in updated.AllowedPaths) _paths.Add(p);
                DefaultToggle.IsOn = !updated.UseDefaultPaths;
                ApplyMode();
            }
            var scope = DefaultToggle.IsOn ? "列表中的文件夹" : "默认范围";
            var checkedDrives = _driveBoxes.Where(b => b.Box.IsChecked == true)
                                           .Select(b => b.Letter).ToList();
            var disks = DriveToggle.IsOn && checkedDrives.Count > 0
                ? $"和 {string.Join("、", checkedDrives)} 盘"
                : "";
            ShowResult(InfoBarSeverity.Success, "已保存", $"Dony 只能访问{scope}{disks}。");
        }
        catch (Exception ex)
        {
            ShowResult(InfoBarSeverity.Error, "没能保存", "请确认 Dony 正在运行，然后重试。");
            Debug.WriteLine($"[files] 保存失败：{ex}");
        }
        finally
        {
            Busy.IsActive = false;
            SaveButton.IsEnabled = true;
        }
    }

    private async void Reload_Click(object sender, RoutedEventArgs e) => await ReloadAsync();

    private void ShowResult(InfoBarSeverity severity, string title, string message)
    {
        Result.Severity = severity;
        Result.Title = title;
        Result.Message = message;
        Result.IsOpen = true;
    }
}
