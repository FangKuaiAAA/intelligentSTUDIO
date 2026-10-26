using System;
using System.Threading.Tasks;
using ImagePlayground.Services;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace ImagePlayground;

public partial class App : Application
{
    public static MainWindow? MainWindow { get; private set; }

    /// <summary>--demo：用内置素材模拟一次生成，便于在没有模型时预览动画。</summary>
    public static bool DemoMode { get; private set; }

    /// <summary>单实例键：同一个用户下只允许一份图乐园窗口。</summary>
    private const string InstanceKey = "Dony.ImagePlayground";

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            var detail = e.Exception.Message;
            if (detail.Length > 300) detail = detail[..300];
            AppLog.Write("未处理异常", $"{e.Exception.GetType().Name}: {detail}");
            e.Handled = false;
        };
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        var commandLine = Environment.GetCommandLineArgs();

        DemoMode = Array.Exists(commandLine,
            a => string.Equals(a, "--demo", StringComparison.OrdinalIgnoreCase));

        // Office 插件调用：不创建窗口，生成完成后直接退出进程。
        // ⚠ 这条路径**不参与单实例**：它是"无窗口的一次性任务"，
        //   若被重定向到正在运行的 UI 实例，任务根本不会执行。
        if (OfficeCommandLine.IsOfficeInvocation(commandLine))
        {
            var exitCode = Task.Run(() => OfficeCommandLine.RunAsync(commandLine))
                .GetAwaiter().GetResult();
            Environment.Exit(exitCode);
            return;
        }

        // 正常 UI 启动：单实例守卫。
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
    }
}
