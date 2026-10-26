using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Dony;

public partial class App : Application
{
    public static MainWindow? MainWindow { get; private set; }

    /// <summary>单实例键：同一个用户下只允许一份 Dony 对话。</summary>
    private const string InstanceKey = "Dony.MainWindow";

    public App()
    {
        InitializeComponent();
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        // ---- 单实例守卫 ----
        // 第二次启动时不再新建窗口，而是把这次激活"重定向"给已有实例，然后自己退出。
        // 不做的话会出现两份窗口：历史/语音各自连后端，互相抢设备与焦点。
        var keyInstance = AppInstance.FindOrRegisterForKey(InstanceKey);
        if (!keyInstance.IsCurrent)
        {
            await keyInstance.RedirectActivationToAsync(AppInstance.GetCurrent().GetActivatedEventArgs());
            Exit();
            return;
        }

        // 已有实例被再次启动（激活被重定向过来）：把窗口带到前台。
        // 注意必须回 UI 线程，Activated 回调不保证在 UI 线程上。
        keyInstance.Activated += (_, _) =>
        {
            MainWindow?.DispatcherQueue.TryEnqueue(() =>
            {
                if (MainWindow is null) return;
                MainWindow.Activate();
                // Activate() 不会把最小化的窗口还原，显式 Show 一次
                MainWindow.AppWindow.Show(true);
            });
        };

        MainWindow = new MainWindow();
        MainWindow.Activate();
    }
}
