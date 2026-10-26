using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace PhotoEditor.Services;

public sealed class SharpNodeStatus
{
    public string Stage { get; init; } = "";
    public string Message { get; init; } = "";
    public double Progress { get; init; }
    public string Backend { get; init; } = "";
}

public sealed class SharpNodeResult
{
    public required string PlyPath { get; init; }
    public required string Backend { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public double FocalPx { get; init; }
    public int SelectedGaussians { get; init; }
    public long DurationMs { get; init; }
}

/// <summary>
/// 原项目的 Node 推理后端：onnxruntime-node + WebGPU，按行 JSON 协议走 stdio。
/// 三维重建走这里；分割与修补由 Python 侧负责。
/// </summary>
public sealed class SharpNodeClient
{
    public static SharpNodeClient Instance { get; } = new();

    private readonly SemaphoreSlim _gate = new(1, 1);

    private string? RepoRoot => SettingsStore.Instance.RepoRoot;

    /// <summary>打包态：node 后端与 node.exe 随安装包放在 resources/photo-webview。</summary>
    private static string? PackagedWebviewRoot
    {
        get
        {
            var p = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "photo-webview"));
            return Directory.Exists(p) ? p : null;
        }
    }

    public string? WorkerPath
    {
        get
        {
            var root = RepoRoot;
            if (root is not null)
                return Path.Combine(root, "photo-app", "webview", "dist-backend", "worker.cjs");

            var packed = PackagedWebviewRoot;
            return packed is null ? null : Path.Combine(packed, "dist-backend", "worker.cjs");
        }
    }

    /// <summary>node 可执行文件：打包态用随包的 node.exe，开发态用 PATH 里的 node。</summary>
    private static string NodeExe
    {
        get
        {
            var packed = PackagedWebviewRoot;
            if (packed is not null)
            {
                var local = Path.Combine(packed, "node.exe");
                if (File.Exists(local)) return local;
            }
            return "node";
        }
    }

    private static string? ModelPath
    {
        get
        {
            var root = SettingsStore.Instance.RepoRoot;
            if (root is not null)
            {
                var p = Path.Combine(root, "models", "photo", "sharp_web_predictor.onnx");
                return File.Exists(p) ? p : null;
            }
            // 打包态：resources/models/photo（photo-app 在 resources/photo，往上两级）
            var packed = Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "models", "photo", "sharp_web_predictor.onnx"));
            return File.Exists(packed) ? packed : null;
        }
    }

    public bool IsAvailable
    {
        get
        {
            if (WorkerPath is not { } worker || !File.Exists(worker)) return false;
            return ModelPath is not null;
        }
    }

    private static Process StartWorker(string worker)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = NodeExe,
            Arguments = $"\"{worker}\"",
            WorkingDirectory = Path.GetDirectoryName(worker)!,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        var process = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动 Node 进程。");

        process.ErrorDataReceived += (_, args) =>
        {
            if (args.Data is { Length: > 0 } text) AppLog.Write("Node 后端", text);
        };
        process.BeginErrorReadLine();

        return process;
    }

    private static void StopWorker(Process? process)
    {
        if (process is null) return;

        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch { /* 进程已退出 */ }

        process.Dispose();
    }

    public async Task<SharpNodeResult> RunAsync(string imagePath, string outputDirectory,
        string qualityPreset, Action<SharpNodeStatus>? onStatus, CancellationToken ct)
    {
        if (!IsAvailable)
            throw new InvalidOperationException(
                "Node 推理后端未就绪。请确认 photo-app/webview/dist-backend/worker.cjs 与 models/photo 下的 SHARP 模型存在。");

        var worker = WorkerPath!;
        var modelPath = ModelPath!;
        var taskId = Guid.NewGuid().ToString("N")[..8];

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        Process? process = null;

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = NodeExe,
                Arguments = $"\"{worker}\"",
                WorkingDirectory = Path.GetDirectoryName(worker)!,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            // 打包态依赖放在 deps（electron-builder 会特殊排除 node_modules 目录名）
            var depsDir = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(worker)!, "..", "deps"));
            if (Directory.Exists(depsDir)) startInfo.Environment["NODE_PATH"] = depsDir;

            process = Process.Start(startInfo)
                      ?? throw new InvalidOperationException("无法启动 Node 进程。");

            process.ErrorDataReceived += (_, args) =>
            {
                if (args.Data is { Length: > 0 } text) AppLog.Write("Node 后端", text);
            };
            process.BeginErrorReadLine();

            var request = new
            {
                type = "run",
                taskId,
                payload = new { imagePath, qualityPreset },
                config = new
                {
                    modelPath,
                    outputDir = outputDirectory,
                    // 优先 GPU；推理内部在 GPU 失败时会自动降级到 CPU
                    preferredProviders = new[] { "webgpu", "cpu" },
                },
            };

            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(request)).ConfigureAwait(false);
            await process.StandardInput.FlushAsync().ConfigureAwait(false);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            // CPU 推理 117 万高斯明显慢于 GPU，超时按最坏情况放宽
            timeout.CancelAfter(TimeSpan.FromMinutes(15));

            while (true)
            {
                var line = await process.StandardOutput.ReadLineAsync(timeout.Token).ConfigureAwait(false);
                if (line is null)
                    throw new InvalidOperationException("Node 推理进程意外结束。");

                if (line.Length == 0) continue;

                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (!root.TryGetProperty("type", out var typeProperty)) continue;

                switch (typeProperty.GetString())
                {
                    case "status":
                    {
                        var status = root.GetProperty("status");
                        onStatus?.Invoke(new SharpNodeStatus
                        {
                            Stage = status.TryGetProperty("stage", out var stage) ? stage.GetString() ?? "" : "",
                            Message = status.TryGetProperty("message", out var message) ? message.GetString() ?? "" : "",
                            Progress = status.TryGetProperty("progress", out var progress) && progress.ValueKind == JsonValueKind.Number
                                ? progress.GetDouble()
                                : 0,
                            Backend = status.TryGetProperty("backend", out var backend) ? backend.GetString() ?? "" : "",
                        });
                        break;
                    }

                    case "result":
                    {
                        var result = root.GetProperty("result");
                        var image = result.GetProperty("image");

                        return new SharpNodeResult
                        {
                            PlyPath = result.GetProperty("plyPath").GetString() ?? "",
                            Backend = result.TryGetProperty("backend", out var backend)
                                ? backend.GetString() ?? ""
                                : "",
                            Width = image.TryGetProperty("width", out var width) ? width.GetInt32() : 0,
                            Height = image.TryGetProperty("height", out var height) ? height.GetInt32() : 0,
                            FocalPx = image.TryGetProperty("focalPx", out var focal) ? focal.GetDouble() : 0,
                            SelectedGaussians = result.TryGetProperty("selectedGaussians", out var count)
                                ? count.GetInt32()
                                : 0,
                            DurationMs = result.TryGetProperty("durationMs", out var duration)
                                ? duration.GetInt64()
                                : 0,
                        };
                    }

                    case "error":
                        throw new InvalidOperationException(
                            root.TryGetProperty("error", out var error) ? error.GetString() ?? "Node 推理失败。" : "Node 推理失败。");
                }
            }
        }
        finally
        {
            if (process is not null)
            {
                try
                {
                    if (!process.HasExited) process.Kill(entireProcessTree: true);
                }
                catch { /* 进程已退出 */ }

                process.Dispose();
            }

            _gate.Release();
        }
    }
}
