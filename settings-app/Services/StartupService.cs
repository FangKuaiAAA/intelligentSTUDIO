using System;
using System.IO;
using Microsoft.Win32;

namespace DonySettings.Services;

/// <summary>
/// 开机启动：写 HKCU\...\CurrentVersion\Run 的 intelligentSTUDIO 项，指向主进程启动器。
/// 开发态指向仓库根的 start-silent.bat，安装态指向安装目录主程序；开关状态另存于配置文件。
/// </summary>
public static class StartupService
{
    /// <summary>配置文件中的键名（与主进程共用）。</summary>
    public const string ConfigKey = "START_AT_LOGIN";

    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "intelligentSTUDIO";

    public static bool IsEnabled() => SettingsStore.Instance.GetBool(ConfigKey);

    public static bool SetEnabled(bool enabled)
    {
        try
        {
            var store = SettingsStore.Instance;
            store.Set(ConfigKey, enabled);
            store.Save();
            ApplyRunKey(enabled);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void ApplyRunKey(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            if (key is null) return;

            if (enabled)
            {
                var launcher = ResolveLauncherPath();
                if (launcher is not null)
                    key.SetValue(RunValueName, $"\"{launcher}\"");
            }
            else
            {
                key.DeleteValue(RunValueName, throwOnMissingValue: false);
            }
        }
        catch
        {
            // 注册表不可写时静默：开关状态仍保存在配置文件，后续启动时可重试
        }
    }

    /// <summary>自启目标：开发态用 start-silent.bat，安装态用同目录主程序 exe。</summary>
    private static string? ResolveLauncherPath()
    {
        var repoRoot = SettingsStore.Instance.RepoRoot;
        if (repoRoot is not null)
        {
            var silent = Path.Combine(repoRoot, "start-silent.bat");
            if (File.Exists(silent)) return silent;
        }

        // 设置应用在 resources/settings/，主程序在安装目录根（往上两级）
        var mainExe = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "intelligentSTUDIO.exe"));
        return File.Exists(mainExe) ? mainExe : null;
    }
}
