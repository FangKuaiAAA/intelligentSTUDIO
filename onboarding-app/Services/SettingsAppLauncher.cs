using System;
using System.Diagnostics;
using System.IO;
using DonySettings.Services;

namespace IntelligentStudio.Onboarding.Services;

/// <summary>点「完成」后打开 STUDIO 设置：优先用已编译的 DonySettings.exe，找不到再退回仓库里的调试脚本。</summary>
public static class SettingsAppLauncher
{
    private const string RelativeExe =
        @"settings-app\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\DonySettings.exe";

    public static bool TryLaunch(out string detail)
    {
        var searched = new System.Collections.Generic.List<string>();

        var repoRoot = SettingsStore.Instance.RepoRoot;
        if (repoRoot is not null)
        {
            var exe = Path.Combine(repoRoot, RelativeExe);
            searched.Add(exe);
            if (File.Exists(exe) && TryStart(exe, Path.GetDirectoryName(exe), out detail))
                return true;

            var bat = Path.Combine(repoRoot, "run-settings-app.bat");
            searched.Add(bat);
            if (File.Exists(bat) && TryStart(bat, repoRoot, out detail))
                return true;
        }

        // 打包态：settings 子应用在 resources/settings/（与 onboarding 同属 resources）
        var resourcesDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
        var packaged = Path.Combine(resourcesDir, "settings", "DonySettings.exe");
        searched.Add(packaged);
        if (File.Exists(packaged) && TryStart(packaged, Path.GetDirectoryName(packaged), out detail))
            return true;

        // 兜底：两个应用可能放在同一层目录
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var near = Path.Combine(dir.FullName, "DonySettings.exe");
            searched.Add(near);
            if (File.Exists(near) && TryStart(near, dir.FullName, out detail))
                return true;
        }

        detail = "未找到 DonySettings.exe，已查找：" + string.Join("；", searched);
        return false;
    }

    private static bool TryStart(string fileName, string? workingDirectory, out string detail)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                UseShellExecute = true,
                WorkingDirectory = workingDirectory ?? AppContext.BaseDirectory,
            };
            using var process = Process.Start(psi);
            detail = "";
            return process is not null;
        }
        catch (Exception ex)
        {
            detail = ex.Message;
            return false;
        }
    }
}
