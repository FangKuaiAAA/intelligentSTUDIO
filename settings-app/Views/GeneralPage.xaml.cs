using System.Threading.Tasks;
using DonySettings.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DonySettings.Views;

public sealed partial class GeneralPage : Page
{
    private bool _loading;

    public GeneralPage()
    {
        InitializeComponent();
    }

    public async Task ReloadAsync()
    {
        _loading = true;
        StartupToggle.IsOn = StartupService.IsEnabled();
        _loading = false;
        await Task.CompletedTask;
    }

    private void Startup_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        if (!StartupService.SetEnabled(StartupToggle.IsOn))
            InfoBarHelper.Show(Result, InfoBarSeverity.Warning, "开机启动设置未能保存，请确认当前用户有写入权限。");
    }

    private async void ReinstallEdge_Click(object sender, RoutedEventArgs e)
        => await ReinstallAsync(ExtensionInstallService.ReinstallEdgeExtensionAsync(), isEdge: true);

    private async void ReinstallOffice_Click(object sender, RoutedEventArgs e)
        => await ReinstallAsync(ExtensionInstallService.ReinstallOfficeAddInAsync(), isEdge: false);

    private async void OfficeGuide_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new ContentDialog
        {
            Title = "安装 Office 插件",
            Content = new TextBlock
            {
                TextWrapping = TextWrapping.Wrap,
                Text =
                    "1. 关闭所有 Word / Excel / PowerPoint 窗口。\n\n" +
                    "2. 点「重新安装」。它会写入加载项登记、创建本地共享目录并登记" +
                    "受信任目录；首次创建共享会弹一次 UAC，允许即可。\n\n" +
                    "3. 重新打开 Word 或 Excel，功能区右侧出现 intelligentSTUDIO 选项卡：" +
                    "快速改写、智能插图、书写辅助、图乐园、复原。\n\n" +
                    "4. 若选项卡没有出现：关闭全部 Office 窗口后重开一次；仍没有时，到 " +
                    "插入 → 我的加载项 → 共享文件夹 → 选中 intelligentSTUDIO → 添加，" +
                    "再重开 Office。\n\n" +
                    "5. 任务窗格需要本机服务在运行（Dony 应用内置），" +
                    "窗格底部显示「已连接」即可使用。\n\n" +
                    "说明：加载项按宿主分别生效，Word、Excel、PowerPoint 各自首次打开时" +
                    "读取一次登记。",
            },
            CloseButtonText = "知道了",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = XamlRoot,
        };
        await dialog.ShowAsync();
    }

    private async Task ReinstallAsync(System.Threading.Tasks.Task<InstallOutcome> task, bool isEdge)
    {
        var outcome = await task;
        var (severity, message) = InstallPresenter.Describe(isEdge, outcome);
        InfoBarHelper.Show(Result, severity, message);
    }

    private async void ClearHistory_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new ContentDialog
        {
            Title = "清空 Dony 对话记录？",
            Content = "全部对话记录将被删除，无法恢复。",
            PrimaryButtonText = "清空",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = XamlRoot,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;

        ClearHistoryButton.IsEnabled = false;
        try
        {
            var removed = await HistoryService.ClearAllAsync();
            InfoBarHelper.Show(Result, InfoBarSeverity.Success,
                removed > 0 ? $"已清空 {removed} 条对话记录。" : "没有可清空的对话记录。");
        }
        catch (System.Net.Http.HttpRequestException)
        {
            InfoBarHelper.Show(Result, InfoBarSeverity.Error,
                "无法连接 STUDIO，对话记录未清空。启动 STUDIO 后重试。");
        }
        catch (System.Threading.Tasks.TaskCanceledException)
        {
            InfoBarHelper.Show(Result, InfoBarSeverity.Error,
                "清空请求超时，对话记录未清空。请重试。");
        }
        catch (Exception ex)
        {
            InfoBarHelper.Show(Result, InfoBarSeverity.Error, $"对话记录未能清空。{ex.Message}");
        }
        finally
        {
            ClearHistoryButton.IsEnabled = true;
        }
    }

    /// <summary>清空个人数据：配置、技能、MCP、Dony 上下文，然后重启主进程回到设置向导。</summary>
    private async void ClearAllData_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new ContentDialog
        {
            Title = "清空个人数据并重置？",
            Content = "将清空全部模型配置、技能、MCP、Dony 对话上下文，并重启主进程回到设置向导。此操作无法撤销。",
            PrimaryButtonText = "清空并重置",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = XamlRoot,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;

        try
        {
            // 1) 清空 Dony 会话（后端接口，未运行时忽略）
            try { await HistoryService.ClearAllAsync(); } catch { }

            // 2) 删除配置文件（模型 / 技能 / MCP 都在其中）
            try
            {
                var cfg = SettingsStore.Instance.ConfigPath;
                if (System.IO.File.Exists(cfg)) System.IO.File.Delete(cfg);
            }
            catch { }

            // 3) 删除 Dony 数据目录（history + settings.json）
            try
            {
                var dony = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Dony");
                if (System.IO.Directory.Exists(dony)) System.IO.Directory.Delete(dony, true);
            }
            catch { }

            // 4) 删除 Edge 扩展副本
            try
            {
                var edge = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "intelligentSTUDIO", "edge-extension");
                if (System.IO.Directory.Exists(edge)) System.IO.Directory.Delete(edge, true);
            }
            catch { }

            // 5) 重启主进程：配置缺失 → 未完成引导 → 弹出设置向导
            await MainProcessService.RestartAsync();
            InfoBarHelper.Show(Result, InfoBarSeverity.Success,
                "已清空个人数据并重启主进程；主进程会进入设置向导。请重新打开 STUDIO 设置以继续。");
        }
        catch (Exception ex)
        {
            InfoBarHelper.Show(Result, InfoBarSeverity.Error, $"清空失败：{ex.Message}");
        }
    }

    private async void RestartMainProcess_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await MainProcessService.RestartAsync();
            InfoBarHelper.Show(Result, InfoBarSeverity.Success, "已重启 intelligentSTUDIO 主进程。");
        }
        catch (Exception ex)
        {
            InfoBarHelper.Show(Result, InfoBarSeverity.Error, $"重启失败：{ex.Message}");
        }
    }
}
