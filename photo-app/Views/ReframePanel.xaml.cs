using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.Web.WebView2.Core;
using PhotoEditor.Controls;
using PhotoEditor.Services;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;

namespace PhotoEditor.Views;

/// <summary>
/// 空间重构：直接承载原重构项目的渲染界面（three + 高斯泼溅）。
/// 宿主只负责三件事：提供当前照片、跑 SHARP 估计并给出 PLY、按需调用图像接口补全。
/// </summary>
public sealed partial class ReframePanel : UserControl, IEditorPanel
{
    private const string VirtualHost = "http://photo.local";
    private const string PlyVirtualPrefix = "/ply/";

    private IEditorHost? _host;
    private EditSurface? _surface;
    private WebView2? _webView;

    private CancellationTokenSource? _cts;
    private string? _plyDirectory;
    private string? _plyFileName;
    private double _plyFocal;
    private bool _ready;
    private bool _imageSent;
    private bool _useApi = true;

    public ReframePanel()
    {
        InitializeComponent();
    }

    public string Title => "重构";

    public string Subtitle => "由照片估计空间，并对照片重新进行构图。";

    public FrameworkElement View => this;

    public async void Activate(IEditorHost host)
    {
        _host = host;
        _surface = host.Surface;
        _surface.DragMode = CanvasDragMode.Pan;
        UpdateEngineHint();

        if (!host.Session.HasImage)
        {
            StateLabel.Text = "打开或拖入一张照片以继续";
            DetailLabel.Text = string.Empty;
            return;
        }

        if (_webView is null)
            await CreateViewerAsync();
        else if (_ready)
            await SendImageAsync();

        RebuildButton.IsEnabled = true;
    }

    public void Deactivate()
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
        _ready = false;
        RemoveViewer();
    }

    private async void OnRebuild(object sender, RoutedEventArgs e)
    {
        _cts?.Cancel();
        _plyFileName = null;
        RemoveViewer();
        await CreateViewerAsync();
    }

    // ---------- WebView2 ----------

    private async Task CreateViewerAsync()
    {
        if (_host is null) return;

        _imageSent = false;
        _ready = false;

        var folder = Path.Combine(AppContext.BaseDirectory, "Assets", "Viewer");
        if (!Directory.Exists(folder))
        {
            StateLabel.Text = "缺少场景文件";
            DetailLabel.Text = "安装目录下应包含 Assets\\Viewer。";
            return;
        }

        _plyDirectory ??= Path.Combine(Path.GetTempPath(), "photo-editor", "ply");
        Directory.CreateDirectory(_plyDirectory);

        _webView = new WebView2
        {
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            DefaultBackgroundColor = Windows.UI.Color.FromArgb(255, 20, 20, 22),
        };

        if (_host?.CanvasHost is null)
        {
            StateLabel.Text = "场景未能载入";
            DetailLabel.Text = "编辑器尚未就绪（画布容器不可用），请重新打开照片编辑器。";
            return;
        }
        _host.CanvasHost.Children.Add(_webView);

        try
        {
            // 打包后 photo-app 位于 Program Files（不可写）；WebView2 默认把用户数据放在
            // exe 目录会导致初始化失败（表现为 Object reference not set）。显式指到 %LOCALAPPDATA%。
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "intelligentSTUDIO", "photo-webview");
            Directory.CreateDirectory(userDataFolder);

            var env = await CoreWebView2Environment.CreateWithOptionsAsync(null, userDataFolder, null);
            var initialization = _webView.EnsureCoreWebView2Async(env).AsTask();
            if (await Task.WhenAny(initialization, Task.Delay(20000)) != initialization)
            {
                StateLabel.Text = "场景未能载入";
                DetailLabel.Text = "WebView2 运行时没有响应。";
                return;
            }
            await initialization;

            var core = _webView.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.WebMessageReceived += OnWebMessage;

            // 该 WebView2 SDK 未暴露控制台事件，用注入脚本捕获未处理的脚本错误
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.addEventListener('error', function (e) {"
                + "window.chrome.webview.postMessage({ type: 'js-error', message: String(e.message) + ' @ ' + e.filename + ':' + e.lineno });"
                + "});"
                + "window.addEventListener('unhandledrejection', function (e) {"
                + "window.chrome.webview.postMessage({ type: 'js-error', message: 'rejection: ' + String(e.reason) });"
                + "});");

            core.AddWebResourceRequestedFilter($"{VirtualHost}/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += async (_, args) =>
            {
                var deferral = args.GetDeferral();
                try
                {
                    await ServeAsync(core, folder, args);
                }
                finally
                {
                    deferral.Complete();
                }
            };

            core.NavigationCompleted += async (_, args) =>
            {
                AppLog.Write("场景导航", $"success={args.IsSuccess} status={args.WebErrorStatus}");
                if (!args.IsSuccess) return;

                // ready 消息可能丢失（脚本异常或加载时序），导航成功后兜底发一次照片
                await Task.Delay(1500);
                await SendImageAsync();
            };

            _webView.Source = new Uri($"{VirtualHost}/index.html");

            StateLabel.Text = "正在载入场景";
            DetailLabel.Text = "首次重建需要更长时间。";
        }
        catch (Exception ex)
        {
            AppLog.Write("场景载入失败", $"{ex.GetType().Name}: {ex.Message}");
            StateLabel.Text = "场景未能载入";
            // 如实显示异常，避免把「初始化失败」误报成「未安装运行时」
            DetailLabel.Text = $"WebView2 初始化失败：{ex.Message}";
        }
    }

    /// <summary>按正确的 Content-Type 返回 Assets\Viewer 下的文件，以及临时目录里的 PLY。</summary>
    private async Task ServeAsync(CoreWebView2 core, string folder,
        CoreWebView2WebResourceRequestedEventArgs args)
    {
        try
        {
            var uri = new Uri(args.Request.Uri);
            var relative = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');

            if (relative.StartsWith("ply/", StringComparison.OrdinalIgnoreCase))
            {
                var name = Path.GetFileName(relative);
                var plyPath = Path.Combine(_plyDirectory ?? string.Empty, name);
                if (!File.Exists(plyPath))
                {
                    args.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
                    return;
                }

                var plyStream = await FileRandomAccessStream.OpenAsync(plyPath, FileAccessMode.Read);
                args.Response = core.Environment.CreateWebResourceResponse(
                    plyStream, 200, "OK", "Content-Type: application/octet-stream");
                return;
            }

            if (string.IsNullOrEmpty(relative)) relative = "index.html";

            var root = Path.GetFullPath(folder);
            var full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', '\\')));

            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                AppLog.Write("场景资源缺失", full);
                args.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }

            var bytes = File.ReadAllBytes(full);
            var stream = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(stream))
            {
                writer.WriteBytes(bytes);
                await writer.StoreAsync();
                await writer.FlushAsync();
                writer.DetachStream();
            }
            stream.Seek(0);

            var contentType = Path.GetExtension(full).ToLowerInvariant() switch
            {
                ".html" => "text/html; charset=utf-8",
                ".js" => "text/javascript; charset=utf-8",
                ".css" => "text/css; charset=utf-8",
                ".png" => "image/png",
                ".json" => "application/json",
                ".wasm" => "application/wasm",
                _ => "application/octet-stream",
            };

            args.Response = core.Environment.CreateWebResourceResponse(
                stream, 200, "OK", $"Content-Type: {contentType}");
        }
        catch (Exception ex)
        {
            AppLog.Write("场景资源读取失败", ex.GetType().Name);
            args.Response = core.Environment.CreateWebResourceResponse(null, 500, "Error", "");
        }
    }

    private void RemoveViewer()
    {
        if (_webView is null) return;

        try
        {
            if (_webView.CoreWebView2 is { } core) core.WebMessageReceived -= OnWebMessage;
            _host?.CanvasHost.Children.Remove(_webView);
            _webView.Close();
        }
        catch { /* 关闭失败不影响流程 */ }

        _webView = null;
        _ready = false;
        _imageSent = false;
    }

    // ---------- 消息分发 ----------

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeProperty)) return;

            var messageType = typeProperty.GetString();
            if (messageType is not ("ready" or "infer-status"))
                AppLog.Info("场景消息", messageType ?? "");

            switch (messageType)
            {
                case "ready":
                    // 页面明确就绪时以它为准重发一次，覆盖导航兜底早于脚本注册的情况
                    if (_ready) break;
                    _ready = true;
                    _imageSent = false;
                    await SendImageAsync();
                    break;

                case "infer":
                    if (root.TryGetProperty("taskId", out var task))
                        _ = RunInferenceAsync(task.GetString() ?? Guid.NewGuid().ToString("N"));
                    break;

                case "infer-cancel":
                    _cts?.Cancel();
                    break;

                case "reconstruct":
                    // 必须在释放 JsonDocument 之前取出字符串，异步任务里不能再持有 JsonElement
                    _ = RunReconstructAsync(
                        root.TryGetProperty("id", out var idValue) ? idValue.GetString() : null,
                        root.TryGetProperty("image", out var imageValue) ? imageValue.GetString() : null,
                        root.TryGetProperty("mask", out var maskValue) && maskValue.ValueKind == JsonValueKind.String
                            ? maskValue.GetString()
                            : null);
                    break;

                case "save":
                    // 前端把结果交回宿主写入编辑会话，而不是自己触发浏览器下载
                    if (root.TryGetProperty("image", out var saveImage)
                        && saveImage.GetString() is { Length: > 0 } saveBase64)
                        _ = SaveReconstructionAsync(saveBase64);
                    break;

                case "js-error":
                    AppLog.Write("场景脚本错误",
                        root.TryGetProperty("message", out var message) ? message.GetString() : "");
                    break;
            }
        }
        catch (Exception ex)
        {
            AppLog.Write("场景消息解析失败", ex.GetType().Name);
        }
    }

    private async Task SaveReconstructionAsync(string base64)
    {
        if (_host is null) return;

        try
        {
            using var decoded = await ImageCodec.DecodeAsync(Convert.FromBase64String(base64));
            var result = SoftwareBitmap.Copy(decoded);

            _host.Session.Commit(EditStage.Reframe, result, null);
            await _host.RefreshSurfaceAsync();

            AppLog.Info("保存重构结果", $"{result.PixelWidth}×{result.PixelHeight}");
            _host.ShowToast("已保存重构结果，可继续编辑。");
        }
        catch (Exception ex)
        {
            AppLog.Write("保存重构结果失败", $"{ex.GetType().Name}: {ex.Message}");
            _host.ShowToast("保存失败。", isError: true);
        }
    }

    private async Task SendImageAsync()
    {
        if (_imageSent) return;
        // 基于 Latest：重构针对当前最新画面
        if (_host?.Session.Latest is not { } input) return;

        SoftwareBitmap? scaled = null;

        try
        {
            // 4032×3024 的 PNG 经 base64 后超过 WebView 消息的可靠范围，
            // 参考图只用于叠加与取色，缩到 1536 长边足够。
            var (targetWidth, targetHeight) = ImageProcessor.FitForApi(input.PixelWidth, input.PixelHeight);
            if (targetWidth != input.PixelWidth || targetHeight != input.PixelHeight)
                scaled = ImageProcessor.Resize(input, targetWidth, targetHeight);

            var bitmap = scaled ?? input;
            var png = await ImageCodec.EncodePngAsync(bitmap);
            _imageSent = true;

            AppLog.Info("照片已发送", $"{bitmap.PixelWidth}×{bitmap.PixelHeight} {png.Length / 1024} KB");

            PostJson(new
            {
                type = "image",
                data = Convert.ToBase64String(png),
                width = bitmap.PixelWidth,
                height = bitmap.PixelHeight,
            });
        }
        catch (Exception ex)
        {
            AppLog.Write("照片发送失败", $"{ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            scaled?.Dispose();
        }
    }

    private void PostJson(object payload)
    {
        try
        {
            _webView?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload));
        }
        catch (Exception ex)
        {
            AppLog.Write("消息发送失败", ex.GetType().Name);
        }
    }

    private void OnEngineClicked(object sender, RoutedEventArgs e)
    {
        if (sender is not ToggleButton button) return;

        if (button.IsChecked != true)
        {
            button.IsChecked = true;
            return;
        }

        _useApi = button.Tag as string == "api";
        EngineBuiltin.IsChecked = !_useApi;
        EngineApi.IsChecked = _useApi;
        UpdateEngineHint();
    }

    private void UpdateEngineHint()
    {
        EngineHint.Text = _useApi && !GenerationClient.Instance.IsCloudAvailable
            ? "接口未配置。"
            : string.Empty;
    }

    // ---------- SHARP 估计 ----------

    private async Task RunInferenceAsync(string taskId)
    {
        // 基于 Latest：重构针对当前最新画面
        if (_host?.Session.Latest is not { } input) return;

        // 已经算过同一张图时直接复用，避免重复等待
        if (_plyFileName is { } cached && File.Exists(Path.Combine(_plyDirectory!, cached)))
        {
            SendResult(taskId, cached, input.PixelWidth, input.PixelHeight, 0, _plyFocal);
            return;
        }

        _cts?.Cancel();
        _cts?.Dispose();
        _cts = new CancellationTokenSource();
        var token = _cts.Token;

        StateLabel.Text = "正在重建场景";
        DetailLabel.Text = "首次重建需要较长时间。";
        AppLog.Info("重建开始", $"{input.PixelWidth}×{input.PixelHeight}");

        try
        {
            // 三维重建交给原项目的 Node 后端（onnxruntime-node + WebGPU）
            var png = await ImageCodec.EncodePngAsync(input);
            var imagePath = Path.Combine(_plyDirectory!, $"input_{taskId}.png");
            await File.WriteAllBytesAsync(imagePath, png, token);

            var result = await SharpNodeClient.Instance.RunAsync(
                imagePath,
                _plyDirectory!,
                // 与原项目一致用 full（117 万高斯）。20 万高斯时点云过于稀疏，
                // 边缘留下成片空洞，会被边缘补洞逻辑拉伸成星芒与毛刷。
                "full",
                status => DispatcherQueue.TryEnqueue(() =>
                {
                    if (string.IsNullOrEmpty(status.Stage)) return;

                    StateLabel.Text = MapNodeStage(status.Stage);
                    DetailLabel.Text = string.Empty;

                    PostJson(new
                    {
                        type = "infer-status",
                        status = new
                        {
                            taskId,
                            stage = status.Stage,
                            progress = Math.Clamp(status.Progress, 1, 99),
                            message = status.Message,
                            backend = status.Backend,
                        },
                    });
                }),
                token);

            if (!File.Exists(result.PlyPath))
                throw new InvalidOperationException("Node 后端没有写出场景文件。");

            var fileName = Path.GetFileName(result.PlyPath);
            _plyFileName = fileName;
            _plyFocal = result.FocalPx;

            SendResult(taskId, fileName, result.Width, result.Height, result.SelectedGaussians, result.FocalPx);
            StateLabel.Text = "场景已就绪";
            DetailLabel.Text = $"拖动画面改变视角，确认后补全空洞。（{result.Backend} · {result.SelectedGaussians} 个高斯）";

            AppLog.Info("重建完成",
                $"{result.Backend} {result.DurationMs} ms {result.SelectedGaussians} 个高斯");
        }
        catch (OperationCanceledException)
        {
            // 切换面板或重新重建时的正常取消
        }
        catch (Exception ex)
        {
            AppLog.Write("三维重建失败", $"{ex.GetType().Name}: {ex.Message}");
            SendFailure(taskId, ex.Message);
            StateLabel.Text = "重建没有完成";
            DetailLabel.Text = ex.Message;
        }
    }

    private void SendResult(string taskId, string fileName, int width, int height, int count, double focal)
    {
        PostJson(new
        {
            type = "infer-result",
            taskId,
            plyUrl = $"{VirtualHost}{PlyVirtualPrefix}{fileName}",
            count,
            width,
            height,
            focalPx = focal,
            backend = "dml",
        });
    }

    private void SendFailure(string taskId, string message)
    {
        PostJson(new { type = "infer-result", taskId, error = message });
    }

    /// <summary>Node 后端的阶段名是英文，界面用中文。</summary>
    private static string MapNodeStage(string stage) => stage switch
    {
        "queued" => "排队中",
        "loading-model" => "加载模型",
        "preprocessing" => "准备图像",
        "running-inference" => "估计空间结构",
        "postprocessing" => "整理点云",
        "writing-ply" => "写出场景",
        "ready" => "完成",
        _ => "正在重建",
    };

    private static string MapStage(string stage)
    {
        if (stage.Contains("准备")) return "preprocessing";
        if (stage.Contains("估计") || stage.Contains("推理")) return "running-inference";
        if (stage.Contains("整理") || stage.Contains("点云")) return "postprocessing";
        return "running-inference";
    }

    // ---------- 补全 ----------

    private async Task RunReconstructAsync(string? id, string? imageBase64, string? maskBase64)
    {
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(imageBase64)) return;

        try
        {
            var png = Convert.FromBase64String(imageBase64);

            using var decoded = await ImageCodec.DecodeAsync(png);
            var width = decoded.PixelWidth;
            var height = decoded.PixelHeight;

            // 截图与遮罩按同一尺寸缩放入参，遮罩来自 repair-mask 的洋红区域
            var (apiWidth, apiHeight) = ImageProcessor.FitForApi(width, height);

            SoftwareBitmap? scaledImage = null;
            if (apiWidth != width || apiHeight != height)
                scaledImage = ImageProcessor.Resize(decoded, apiWidth, apiHeight);

            _host?.BeginBusy("正在补全…", bottom: true);
            StateLabel.Text = "正在补全";

            try
            {
                byte[]? maskPng = null;
                var canvas = scaledImage ?? decoded;
                var canvasPng = await ImageCodec.EncodePngAsync(canvas);

                if (!string.IsNullOrEmpty(maskBase64))
                {
                    using var maskBitmap = await ImageCodec.DecodeAsync(Convert.FromBase64String(maskBase64));
                    var mask = ImageProcessor.ExtractMagentaMask(maskBitmap);

                    // 先在 API 尺寸上缩放（取块内最大值），再轻微膨胀与羽化，
                    // 覆盖空洞边缘的半洋红像素，避免残留紫边。
                    var apiMask = ImageProcessor.ResizeMaskMax(
                        mask, maskBitmap.PixelWidth, maskBitmap.PixelHeight, apiWidth, apiHeight);
                    var radius = Math.Max(3, (int)Math.Round(Math.Max(apiWidth, apiHeight) * 0.005));
                    apiMask = ImageProcessor.DilateMask(apiMask, apiWidth, apiHeight, radius);
                    apiMask = ImageProcessor.FeatherMask(apiMask, apiWidth, apiHeight, 2);

                    maskPng = await ImageCodec.EncodeMaskPngAsync(apiMask, apiWidth, apiHeight);
                }

                byte[] rebuilt;
                string engine;

                if (_useApi)
                {
                    if (maskPng is not null)
                    {
                        // 构图补全交回外部图像接口：带遮罩优先，服务端不支持时自动降级为整图重绘再合成
                        var outcome = await GenerationClient.Instance.InpaintAsync(
                            canvasPng, maskPng, apiWidth, apiHeight, outpaint: true,
                            CancellationToken.None);

                        rebuilt = outcome.Png;
                        engine = outcome.EngineName;
                    }
                    else
                    {
                        var outcome = await GenerationClient.Instance.RefineAsync(
                            canvasPng, apiWidth, apiHeight, CancellationToken.None);
                        rebuilt = outcome.Png;
                        engine = outcome.EngineName;
                    }
                }
                else
                {
                    if (!await PhotoServiceClient.Instance.EnsureRunningAsync())
                        throw new InvalidOperationException("推理服务未就绪。请运行 run-photo-editor.bat 后重试。");

                    // 内置模型只接受带遮罩的重绘；没有选区时用全白遮罩重绘整图
                    var effectiveMask = maskPng;
                    if (effectiveMask is null)
                    {
                        var fullMask = new byte[Math.Max(1, apiWidth * apiHeight)];
                        Array.Fill(fullMask, (byte)255);
                        effectiveMask = await ImageCodec.EncodeMaskPngAsync(fullMask, apiWidth, apiHeight);
                    }

                    rebuilt = await PhotoServiceClient.Instance.MoebiusInpaintAsync(
                        canvasPng, effectiveMask, 20, CancellationToken.None);
                    engine = "内置";
                }

                using var produced = await ImageCodec.DecodeAsync(rebuilt);
                using var fitted = await ImageCodec.ResizeAsync(produced, width, height);

                PostJson(new
                {
                    type = "reconstruct-result",
                    id,
                    image = Convert.ToBase64String(await ImageCodec.EncodePngAsync(fitted)),
                });

                StateLabel.Text = "已补全";
                DetailLabel.Text = $"结果来自 {engine}。";
                AppLog.Info("空间重构补全完成", engine);
            }
            finally
            {
                scaledImage?.Dispose();
            }
        }
        catch (Exception ex)
        {
            AppLog.Write("空间重构补全失败", $"{ex.GetType().Name}: {ex.Message}");
            PostJson(new { type = "reconstruct-result", id, error = ex.Message });
            StateLabel.Text = "补全没有完成";
            DetailLabel.Text = ex.Message;
        }
        finally
        {
            _host?.EndBusy();
        }
    }
}
