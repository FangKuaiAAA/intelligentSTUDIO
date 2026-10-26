using System;
using System.Diagnostics;
using System.IO;

namespace ImagePlayground.Services;

/// <summary>从图乐园打开「STUDIO 设置」，用于未配置图像模型时的引导。</summary>
public static class SettingsLauncher
{
    private const string RelativeExe = @"settings-app\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\DonySettings.exe";

    public static bool TryOpen()
    {
        try
        {
            var root = SettingsStore.Instance.RepoRoot;
            if (root is not null)
            {
                var exe = Path.Combine(root, RelativeExe);
                if (File.Exists(exe))
                {
                    Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
                    return true;
                }

                var script = Path.Combine(root, "run-settings-app.bat");
                if (File.Exists(script))
                {
                    Process.Start(new ProcessStartInfo("cmd.exe", $"/c \"{script}\"")
                    {
                        UseShellExecute = true,
                        CreateNoWindow = true,
                    });
                    return true;
                }
            }
        }
        catch (Exception ex)
        {
            AppLog.Write("打开设置失败", ex.GetType().Name);
        }
        return false;
    }
}
