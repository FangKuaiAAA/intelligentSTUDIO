using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace IntelligentStudio.Onboarding.Services;

/// <summary>
/// 主进程拉起：首次引导需要主进程提供本地服务（8767 = Agent 等）。
/// 用户直接打开 Onboarding.exe 时若主进程没在跑就静默拉起；
/// 主进程自己拉起引导时端口已在监听，这里会直接返回，不会重复启动。
/// </summary>
public static class MainProcessLauncher
{
    private const int AgentPort = 8767;

    public static async Task EnsureRunningAsync()
    {
        if (await IsPortOpenAsync(AgentPort)) return;
        await Task.Run(Launch);
    }

    private static Task<bool> IsPortOpenAsync(int port) => Task.Run(() =>
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

    private static void Launch()
    {
        try
        {
            var exe = Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "..", "intelligentSTUDIO.exe"));
            if (File.Exists(exe))
            {
                Process.Start(new ProcessStartInfo { FileName = exe, UseShellExecute = true });
                return;
            }

            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null)
            {
                var bat = Path.Combine(dir.FullName, "start-silent.bat");
                if (File.Exists(bat))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = $"/c \"\"{bat}\"\"",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden,
                    });
                    return;
                }
                dir = dir.Parent;
            }
        }
        catch
        {
            // 拉不起来也不影响引导流程本身
        }
    }
}
