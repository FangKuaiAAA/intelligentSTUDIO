using System;
using System.IO;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using PhotoEditor.Services;

namespace PhotoEditor;

public partial class App : Application
{
    public static MainWindow? MainWindow { get; private set; }

    /// <summary>命令行传入的图片路径（资源管理器右键菜单或拖到 exe 上）。</summary>
    public static string? StartupImagePath { get; private set; }

    /// <summary>单实例键：同一个用户下只允许一份照片编辑器窗口。</summary>
    private const string InstanceKey = "Dony.PhotoEditor";

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            var detail = e.Exception.Message;
            if (detail.Length > 300) detail = detail[..300];

            var trace = e.Exception.StackTrace ?? "";
            if (trace.Length > 900) trace = trace[..900];

            AppLog.Write("未处理异常", $"{e.Exception.GetType().Name}: {detail}\n{trace}");

            // 切换面板一类的 UI 异常不该让整个编辑器退出：记录后继续运行
            e.Handled = true;
        };
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        // 跳过可执行文件自身与开关，只接受受支持的图片扩展名
        var arguments = Environment.GetCommandLineArgs();
        for (var i = 1; i < arguments.Length; i++)
        {
            var raw = arguments[i];
            if (raw.StartsWith('-') || !File.Exists(raw)) continue;

            var extension = Path.GetExtension(raw).ToLowerInvariant();
            if (extension is not (".jpg" or ".jpeg" or ".png" or ".bmp" or ".tif" or ".tiff" or ".webp" or ".heic"))
                continue;

            StartupImagePath = raw;
            break;
        }

        // 单实例：第二次启动把激活重定向给已有实例后退出。
        // ⚠ 目前只把已有窗口带到前台；第二次启动带进来的图片路径**不会**转发过去。
        //   若需要"再开一张图就换到已有窗口里打开"，得另外加一条激活参数转发通道。
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
