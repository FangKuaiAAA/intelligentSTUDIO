using DonySettings.Services;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace DonySettings;

public partial class App : Application
{
    public static MainWindow? MainWindow { get; private set; }

    /// <summary>单实例键：同一个用户下只允许一份 STUDIO 设置。</summary>
    private const string InstanceKey = "Dony.Settings";

    public App()
    {
        InitializeComponent();
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        // 单实例：第二次启动把激活重定向给已有实例后退出，避免两份设置页各写一次配置文件。
        var keyInstance = AppInstance.FindOrRegisterForKey(InstanceKey);
        if (!keyInstance.IsCurrent)
        {
            await keyInstance.RedirectActivationToAsync(AppInstance.GetCurrent().GetActivatedEventArgs());
            Exit();
            return;
        }

        keyInstance.Activated += (_, _) =>
        {
            MainWindow?.DispatcherQueue.TryEnqueue(() =>
            {
                if (MainWindow is null) return;
                MainWindow.Activate();
                MainWindow.AppWindow.Show(true);
            });
        };

        MainWindow = new MainWindow();
        MainWindow.Activate();

        // 设置页依赖主进程（对话记录/通知状态），未运行则静默拉起
        _ = MainProcessService.EnsureRunningAsync();
    }
}
