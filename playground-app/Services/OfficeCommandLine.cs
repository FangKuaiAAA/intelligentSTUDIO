using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ImagePlayground.Models;

namespace ImagePlayground.Services;

/// <summary>
/// 预留给 Office（Word / Excel / PowerPoint）插件的静默调用入口：
///   ImagePlayground.exe --office --prompt "…" --out "D:\a.png" [--size 1024]
///                       [--style comic] [--elements 机器人,森林] [--text "…"] [--error-out "err.txt"]
/// 命中 --office 时不创建窗口，生成完成后把图片写到 --out 并以退出码表示结果：
///   0 成功 / 1 生成失败 / 2 参数错误。结果同时以一行 JSON 打印到 stdout，便于插件解析。
/// 插件侧只需启动一次进程即可，无需常驻端口。
/// </summary>
public static class OfficeCommandLine
{
    public static bool IsOfficeInvocation(string[] args) =>
        args.Any(a => string.Equals(a, "--office", StringComparison.OrdinalIgnoreCase));

    public static async Task<int> RunAsync(string[] args)
    {
        string? errorOut = GetValue(args, "--error-out");
        try
        {
            var outPath = GetValue(args, "--out");
            if (string.IsNullOrWhiteSpace(outPath))
                return Fail("缺少 --out 参数（输出图片路径）。", errorOut, 2);

            var rawPrompt = GetValue(args, "--prompt");
            var elementArg = GetValue(args, "--elements");
            var textArg = GetValue(args, "--text");
            var styleArg = GetValue(args, "--style");
            var sizeArg = GetValue(args, "--size");

            var elements = ResolveElements(elementArg);
            var texts = SplitList(textArg);
            var style = StylePreset.All.Any(s => s.Key == styleArg)
                ? StylePreset.FromKey(styleArg)
                : StylePreset.FromName(styleArg);

            var size = 1024;
            if (!string.IsNullOrWhiteSpace(sizeArg) && int.TryParse(sizeArg, out var parsed) && parsed >= 256)
                size = parsed;

            if (string.IsNullOrWhiteSpace(rawPrompt) && elements.Count == 0 && texts.Count == 0)
                return Fail("缺少 --prompt 或 --elements，无法确定画面内容。", errorOut, 2);

            var request = new GenerationRequest
            {
                Elements = elements,
                Texts = texts,
                StyleKey = style.Key,
                Size = size,
                RawPrompt = string.IsNullOrWhiteSpace(rawPrompt) ? null : rawPrompt,
            };

            var result = await new ImageGenerationService()
                .GenerateAsync(request, null, CancellationToken.None).ConfigureAwait(false);

            var directory = Path.GetDirectoryName(Path.GetFullPath(outPath));
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            File.Copy(result.FilePath, outPath, overwrite: true);

            AppLog.Info("Office 调用成功", Path.GetFileName(outPath));

            // 明确以 UTF-8 写出，避免重定向时落到系统 ANSI 代码页（插件读到的中文会乱码）
            var json = JsonSerializer.Serialize(new
            {
                ok = true,
                file = Path.GetFullPath(outPath),
                provider = result.Provider,
                prompt = result.FinalPrompt,
            }, new JsonSerializerOptions
            {
                Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            });

            using (var writer = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)))
            {
                writer.WriteLine(json);
            }
            return 0;
        }
        catch (ImageGenerationException ex)
        {
            AppLog.Write("Office 调用失败", ex.Message);
            return Fail(ex.Message, errorOut, 1);
        }
        catch (Exception ex)
        {
            AppLog.Write("Office 调用异常", ex.GetType().Name);
            return Fail("生成失败：" + ex.Message, errorOut, 1);
        }
    }

    private static List<PlaygroundElement> ResolveElements(string? value)
    {
        var list = new List<PlaygroundElement>();
        foreach (var name in SplitList(value))
        {
            var element = ElementCatalog.FindByName(name);
            if (element is not null) list.Add(element);
        }
        return list;
    }

    private static List<string> SplitList(string? value) =>
        string.IsNullOrWhiteSpace(value)
            ? new List<string>()
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    private static int Fail(string message, string? errorOut, int code)
    {
        Console.Error.WriteLine(message);
        if (!string.IsNullOrWhiteSpace(errorOut))
        {
            try { File.WriteAllText(errorOut, message); } catch { }
        }
        return code;
    }

    /// <summary>
    /// 取参数值：从 flag 之后一直拼到下一个以 -- 开头的参数，未加引号的多词提示词也能正确取到。
    /// </summary>
    private static string? GetValue(string[] args, string name)
    {
        for (var i = 0; i < args.Length; i++)
        {
            if (!string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) continue;

            var parts = new List<string>();
            for (var j = i + 1; j < args.Length; j++)
            {
                if (args[j].StartsWith("--", StringComparison.Ordinal)) break;
                parts.Add(args[j]);
            }
            return string.Join(" ", parts);
        }
        return null;
    }
}
