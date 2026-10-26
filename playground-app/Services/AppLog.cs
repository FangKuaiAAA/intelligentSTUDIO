using System;
using System.IO;

namespace ImagePlayground.Services;

/// <summary>
/// 轻量运行日志：只记录时间、阶段、HTTP 状态与异常类型。
/// 绝不写入 API Key，也不写入完整提示词（用户输入可能含隐私）。
/// </summary>
public static class AppLog
{
    private static readonly object Gate = new();

    public static string Directory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "IntelligentStudio", "图乐园");

    public static string FilePath => Path.Combine(Directory, "log.txt");

    /// <summary>信息级日志：默认**不落盘**（正常操作不产生日志）。
    /// 排查时设环境变量 DONY_LOG_VERBOSE=1，即可把这些信息行也写进同一个文件。</summary>
    public static void Info(string stage, string? detail = null)
    {
        var verbose = Environment.GetEnvironmentVariable("DONY_LOG_VERBOSE");
        if (!string.IsNullOrEmpty(verbose) && verbose != "0")
            Write(stage, detail);
    }

    public static void Write(string stage, string? detail = null)
    {
        try
        {
            lock (Gate)
            {
                System.IO.Directory.CreateDirectory(Directory);
                var file = new FileInfo(FilePath);
                if (file.Exists && file.Length > 256 * 1024)
                {
                    var bak = FilePath + ".1";
                    if (File.Exists(bak)) File.Delete(bak);
                    File.Move(FilePath, bak);
                }
                var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}  {stage}"
                           + (string.IsNullOrEmpty(detail) ? "" : $"  {detail}");
                File.AppendAllText(FilePath, line + Environment.NewLine);
            }
        }
        catch { /* 日志失败不影响功能 */ }
    }
}
