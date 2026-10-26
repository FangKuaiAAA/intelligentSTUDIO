using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace DonySettings.Services;

public enum InstallResult
{
    Completed,
    /// <summary>已经装过（版本一致），无需重新安装。</summary>
    AlreadyInstalled,
    /// <summary>安装脚本尚未提供（预留接口）。</summary>
    NotReady,
    Failed,
}

/// <summary>安装结果 + 原因。Detail 面向用户（失败时给可读原因）；
/// Reason 取自脚本的 REASON=（copied / version_changed / installed / running），用来挑不同的提示语。</summary>
public readonly record struct InstallOutcome(InstallResult Result, string Detail = "", string Reason = "");

/// <summary>把安装脚本的结果翻成统一提示文案：向导与设置页共用同一套措辞。</summary>
public static class InstallPresenter
{
    public static (Microsoft.UI.Xaml.Controls.InfoBarSeverity Severity, string Message) Describe(
        bool isEdge, InstallOutcome outcome)
    {
        var what = isEdge ? "Edge 扩展" : "Office 插件";
        var detail = string.IsNullOrWhiteSpace(outcome.Detail) ? "" : $"\n{outcome.Detail}";
        return outcome.Result switch
        {
            InstallResult.Completed when isEdge && outcome.Reason == "version_changed" =>
                (Microsoft.UI.Xaml.Controls.InfoBarSeverity.Success,
                 "Edge 扩展已更新到新版本：在已打开的 edge://extensions 里对本扩展点一次「重新加载」即可。"),
            InstallResult.Completed when isEdge =>
                (Microsoft.UI.Xaml.Controls.InfoBarSeverity.Informational,
                 "扩展文件已准备好。请在 Edge 的 edge://extensions 页面手动安装：" +
                 "打开「开发人员模式」→「加载解压缩的扩展」→ 粘贴剪贴板中的路径。"),
            InstallResult.Completed =>
                (Microsoft.UI.Xaml.Controls.InfoBarSeverity.Success,
                 "Office 插件已安装。重新打开 Word 或 Excel，功能区右侧会出现 intelligentSTUDIO 选项卡；" +
                 "若没有，关闭全部 Office 窗口后重开一次。"),
            InstallResult.AlreadyInstalled =>
                (Microsoft.UI.Xaml.Controls.InfoBarSeverity.Success, $"{what}已安装且版本一致，无需重新安装。"),
            InstallResult.NotReady =>
                (Microsoft.UI.Xaml.Controls.InfoBarSeverity.Warning, $"{what}的安装脚本尚未就绪。{detail}"),
            _ =>
                (Microsoft.UI.Xaml.Controls.InfoBarSeverity.Error, $"{what}安装未完成。{detail}"),
        };
    }
}

/// <summary>重新安装 Edge 扩展与 Office 插件。
/// 脚本位于 scripts\install-edge-extension.ps1 与 scripts\install-office-addin.ps1；
/// Edge 脚本会打印 STATUS=ALREADY_INSTALLED / READY / FAILED，这里据此区分「已装过」与「刚装好」。</summary>
public static class ExtensionInstallService
{
    public static Task<InstallOutcome> ReinstallEdgeExtensionAsync()
        => RunAsync("install-edge-extension.ps1", passRepoRoot: true);

    public static Task<InstallOutcome> ReinstallOfficeAddInAsync()
        => RunAsync("install-office-addin.ps1", passRepoRoot: false);

    /// <summary>脚本查找顺序：仓库根 → 安装目录上溯（打包后） → 用户目录副本。</summary>
    private static string? FindScript(string name, out List<string> searched)
    {
        searched = new List<string>();

        var root = SettingsStore.Instance.RepoRoot;
        if (root is not null)
        {
            var inRepo = Path.Combine(root, "scripts", name);
            searched.Add(inRepo);
            if (File.Exists(inRepo)) return inRepo;
        }

        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var near = Path.Combine(dir.FullName, "scripts", name);
            searched.Add(near);
            if (File.Exists(near)) return near;
        }

        var userCopy = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "intelligentSTUDIO", "scripts", name);
        searched.Add(userCopy);
        return File.Exists(userCopy) ? userCopy : null;
    }

    private static async Task<InstallOutcome> RunAsync(string scriptName, bool passRepoRoot)
    {
        var script = FindScript(scriptName, out var searched);
        if (script is null)
            return new InstallOutcome(InstallResult.NotReady,
                "未找到安装脚本，已查找：" + string.Join("；", searched));

        try
        {
            var arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{script}\"";
            var root = SettingsStore.Instance.RepoRoot;
            if (passRepoRoot && root is not null)
                arguments += $" -RepoRoot \"{root}\"";

            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = root ?? Path.GetDirectoryName(script)!,
            };

            using var process = Process.Start(psi);
            if (process is null)
                return new InstallOutcome(InstallResult.Failed, "无法启动 powershell.exe");

            // 两路都先开始读：只读一路会在大输出时把管道塞住，进程永远退不出来
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            var output = await stdout;
            var errors = await stderr;

            var reason = ReadField(output, "REASON=");

            if (output.Contains("STATUS=ALREADY_INSTALLED", StringComparison.OrdinalIgnoreCase))
                return new InstallOutcome(InstallResult.AlreadyInstalled, "", reason ?? "");
            if (output.Contains("STATUS=READY", StringComparison.OrdinalIgnoreCase))
                return new InstallOutcome(InstallResult.Completed, "", reason ?? "");
            if (output.Contains("STATUS=FAILED", StringComparison.OrdinalIgnoreCase))
                return new InstallOutcome(InstallResult.Failed,
                    reason ?? Tail(output + " " + errors), reason ?? "");

            return process.ExitCode == 0
                ? new InstallOutcome(InstallResult.Completed)
                : new InstallOutcome(InstallResult.Failed,
                    $"脚本退出码 {process.ExitCode}：{Tail(output + " " + errors)}");
        }
        catch (Exception e)
        {
            return new InstallOutcome(InstallResult.Failed, e.Message);
        }
    }

    /// <summary>读取脚本输出里的 KEY=VALUE 行（脚本协议用，例如 REASON=）。</summary>
    private static string? ReadField(string output, string key)
    {
        foreach (var line in output.Split('\n'))
        {
            var text = line.Trim();
            if (text.StartsWith(key, StringComparison.OrdinalIgnoreCase))
                return text[key.Length..].Trim();
        }
        return null;
    }

    /// <summary>取最后一段非空输出，供提示框显示（压成一行，限长）。</summary>
    private static string Tail(string text, int max = 200)
    {
        var lines = text.Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .ToArray();
        if (lines.Length == 0) return "（脚本没有输出）";
        var last = string.Join(" / ", lines.TakeLast(3));
        return last.Length <= max ? last : "…" + last[^max..];
    }
}
