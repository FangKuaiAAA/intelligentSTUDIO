using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace Dony.Services;

/// <summary>
/// 主进程拉起：Dony 对话、图乐园、照片编辑器、设置都依赖 intelligentSTUDIO.exe 提供的本地服务
/// （8767 = Agent，8769 = 应用 API 等）。打开任一子应用时若主进程没在跑就静默拉起它，
/// 否则用户看到的是「服务不可用 / 点了没反应」，而不是一个能自愈的界面。
///
/// 与设置页的 MainProcessService 保持同一套路径推断（打包态往上两级是安装根，
/// 开发态向上找 start-silent.bat），只是这里不需要 Restart/Kill 那些管理能力。
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
            // 打包态：子应用在 resources/<name>/，往上两级就是安装根目录
            var exe = Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "..", "intelligentSTUDIO.exe"));
            if (File.Exists(exe))
            {
                Process.Start(new ProcessStartInfo { FileName = exe, UseShellExecute = true });
                return;
            }

            // 开发态：从输出目录往上找仓库根下的 start-silent.bat
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
            // 拉不起来也不影响子应用自身的其它功能
        }
    }
}
