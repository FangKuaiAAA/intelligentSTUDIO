using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace PhotoEditor.Services;

/// <summary>
/// 主进程拉起：照片编辑器依赖 intelligentSTUDIO.exe 提供的本地服务（8767 = Agent 等）。
/// 打开编辑器时若主进程没在跑就静默拉起，避免用户看到「服务不可用 / 点了没反应」。
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
            // 拉不起来也不影响编辑器自身的其它功能
        }
    }
}
