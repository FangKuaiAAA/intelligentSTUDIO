using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace DonySettings.Services;

/// <summary>
/// 主进程（Dony）拉起：设置页的对话记录、通知状态等功能依赖主进程，
/// 启动设置应用时若主进程未运行则静默拉起（开发态用 start-silent.bat）。
/// </summary>
public static class MainProcessService
{
    private const int AgentPort = 8767;

    public static async Task EnsureRunningAsync()
    {
        if (await IsPortOpenAsync(AgentPort)) return;
        await Task.Run(Launch);
    }

    private static Task<bool> IsPortOpenAsync(int port)
    {
        return Task.Run(() =>
        {
            try
            {
                using var client = new TcpClient();
                client.Connect("127.0.0.1", port);
                return true;
            }
            catch
            {
                return false;
            }
        });
    }

    private static void Launch()
    {
        try
        {
            var root = SettingsStore.Instance.RepoRoot;
            if (root is not null)
            {
                var silent = Path.Combine(root, "start-silent.bat");
                if (File.Exists(silent))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = $"/c \"\"{silent}\"\"",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden,
                    });
                    return;
                }
            }

            // 打包态：直接启动安装目录根的主程序（设置应用在 resources/settings/，往上两级）
            var exe = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "intelligentSTUDIO.exe"));
            if (File.Exists(exe))
            {
                Process.Start(new ProcessStartInfo { FileName = exe, UseShellExecute = true });
            }
        }
        catch
        {
            // 主进程启动失败时静默，设置页仍可独立使用
        }
    }

    /// <summary>重启主进程：先结束现有的 intelligentSTUDIO / backend 进程，再重新拉起。</summary>
    public static async Task RestartAsync()
    {
        KillProcesses("intelligentSTUDIO");
        KillProcesses("intelligentstudio-backend");
        await Task.Delay(1500);
        await Task.Run(Launch);
    }

    private static void KillProcesses(string name)
    {
        try
        {
            foreach (var p in Process.GetProcessesByName(name))
            {
                try { p.Kill(entireProcessTree: true); } catch { /* 忽略单个进程失败 */ }
            }
        }
        catch { /* 忽略查询失败 */ }
    }
}
