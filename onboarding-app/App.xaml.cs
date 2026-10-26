using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace IntelligentStudio.Onboarding;

public partial class App : Application
{
    /// <summary>单实例键：同一个用户下只允许一份首次启动引导。</summary>
    private const string InstanceKey = "IntelligentStudio.Onboarding";

    public static MainWindow? Window { get; private set; }

    public App()
    {
        InitializeComponent();
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        var keyInstance = AppInstance.FindOrRegisterForKey(InstanceKey);
        if (!keyInstance.IsCurrent)
        {
            await keyInstance.RedirectActivationToAsync(AppInstance.GetCurrent().GetActivatedEventArgs());
            Exit();
            return;
        }

        keyInstance.Activated += (_, _) =>
            Window?.DispatcherQueue.TryEnqueue(() =>
            {
                if (Window is null) return;
                Window.Activate();
                Window.AppWindow.Show(true);
            });

        Window = new MainWindow(ReadStartStep());
        Window.Activate();
    }

    /// <summary>调试用：--step N 直接从第 N 页（1 基）开始。</summary>
    private static int ReadStartStep()
    {
        var args = Environment.GetCommandLineArgs();
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--step" && int.TryParse(args[i + 1], out var step))
                return Math.Max(0, step - 1);
        }
        return 0;
    }
}
