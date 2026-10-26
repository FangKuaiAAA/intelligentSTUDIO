using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace PhotoEditor.Services;

/// <summary>外部图像接口返回的可读错误：区分配置缺失与调用失败，便于界面给出准确提示。</summary>
public sealed class ImageApiException : Exception
{
    public ImageApiException(string message, bool isConfigurationError = false) : base(message) =>
        IsConfigurationError = isConfigurationError;

    public bool IsConfigurationError { get; }
}

public sealed class InpaintOutcome
{
    public required byte[] Png { get; init; }
    public required string EngineName { get; init; }
}

/// <summary>
/// 补全：全部走外部图像接口（与图乐园共用 .appx_config.json 的 IMAGE_* 四项）。
/// 不再本地兜底，调用失败直接抛错，避免把无效结果当成补全完成写回画布。
/// </summary>
public sealed class GenerationClient
{
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    public static GenerationClient Instance { get; } = new();

    /// <summary>FLUX Fill 或支持 mask 的 OpenAI edits 视为可用。</summary>
    public bool IsCloudAvailable
    {
        get
        {
            var settings = SettingsStore.Instance;
            if (!settings.HasEditModel) return false;

            var provider = settings.EditProvider.ToLowerInvariant();
            var baseUrl = settings.EditApiBase.ToLowerInvariant();
            var model = settings.EditModel.ToLowerInvariant();

            if (provider is "filledit" or "fluxfill" or "flux-fill") return true;
            if (provider == "openai") return SupportsOpenAiEdits(model);
            if (provider == "dashscope") return false;

            // FLUX Fill 服务固定监听 8686，接口为 POST /v1/edit
            if (baseUrl.Contains(":8686")) return true;
            return SupportsOpenAiEdits(model);
        }
    }

    public string CloudName
    {
        get
        {
            var settings = SettingsStore.Instance;
            var provider = settings.EditProvider.ToLowerInvariant();
            var baseUrl = settings.EditApiBase.ToLowerInvariant();
            if (provider is "filledit" or "fluxfill" or "flux-fill") return "FLUX Fill";
            if (provider == "openai") return "图像编辑接口";
            if (baseUrl.Contains(":8686")) return "FLUX Fill";
            return "图像编辑接口";
        }
    }

    private static bool SupportsOpenAiEdits(string model) =>
        model.Contains("gpt-image") || model.Contains("dall-e-2") || model.Contains("dalle")
        || model.Contains("flux") || model.Contains("qwen-image");

    /// <summary>
    /// 补全指定区域。mask 为白色区域 = 需要重绘。
    /// <paramref name="outpaint"/> 用于选择扩图专用的保底模板。
    /// </summary>
    public async Task<InpaintOutcome> InpaintAsync(byte[] imagePng, byte[] maskPng,
        int width, int height, bool outpaint, CancellationToken ct)
    {
        if (!IsCloudAvailable)
        {
            throw new ImageApiException(
                "尚未配置可用的图像模型。请在「STUDIO 设置 → 模型」填写图像接口地址与模型名。",
                isConfigurationError: true);
        }

        var settings = SettingsStore.Instance;
        var baseUrl = settings.EditApiBase.TrimEnd('/');
        var provider = settings.EditProvider.ToLowerInvariant();

        var isFluxFill = provider is "filledit" or "fluxfill" or "flux-fill"
                         || baseUrl.Contains(":8686");

        if (!isFluxFill && provider == "dashscope")
        {
            throw new ImageApiException(
                "当前图像渠道不支持局部重绘。请改用 FLUX Fill 或支持 images/edits 的接口。",
                isConfigurationError: true);
        }

        // 出图可能排队；给足 180 秒，超时按失败处理，不写回画布
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(180));
        var token = timeout.Token;

        // 不调用视觉模型撰写提示词，统一用固定模板。
        // FLUX Fill 收到空 prompt 会返回 500（argmax of zero-size array），
        // 因此这里始终发送非空的描述性文本。
        var prompt = PromptComposer.Fallback(outpaint ? PromptTask.Outpaint : PromptTask.Erase);

        AppLog.Info("补全提示词", prompt.Length == 0 ? "(空)" : prompt);

        // 服务端对过大 body 会在读取阶段直接 400（队列里看不到任务），先压成 JPEG
        var payloadImage = await ImageCodec.ReencodeAsJpegAsync(imagePng).ConfigureAwait(false);

        try
        {
            if (isFluxFill)
            {
                var edited = await FluxFillEditAsync(baseUrl, payloadImage, maskPng, prompt, token)
                    .ConfigureAwait(false);
                return new InpaintOutcome { Png = edited, EngineName = CloudName };
            }

            var openAiEdited = await OpenAiEditAsync(baseUrl, settings.EditApiKey, settings.EditModel,
                payloadImage, maskPng, prompt, width, height, token).ConfigureAwait(false);
            return new InpaintOutcome { Png = openAiEdited, EngineName = CloudName };
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ImageApiException($"图像接口超时（{CloudName}）。请稍后重试或降低输出尺寸。");
        }
    }

    /// <summary>
    /// 只做整体重绘（不带遮罩），用于修补高斯渲染的空洞与拉丝：
    /// 与原项目「把当前视角截图交给图像模型修复」的语义一致。
    /// </summary>
    public async Task<InpaintOutcome> RefineAsync(byte[] imagePng, int width, int height, CancellationToken ct)
    {
        if (!IsCloudAvailable)
        {
            throw new ImageApiException(
                "尚未配置可用的图像模型。请在「STUDIO 设置 → 模型」填写图像接口地址与模型名。",
                isConfigurationError: true);
        }

        var settings = SettingsStore.Instance;
        var baseUrl = settings.EditApiBase.TrimEnd('/');
        var provider = settings.EditProvider.ToLowerInvariant();

        var isFluxFill = provider is "filledit" or "fluxfill" or "flux-fill"
                         || baseUrl.Contains(":8686");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(180));

        var payloadImage = await ImageCodec.ReencodeAsJpegAsync(imagePng).ConfigureAwait(false);

        try
        {
            if (isFluxFill)
            {
                // 服务只接受带遮罩的重绘：整体修复用全白遮罩，让模型重绘全图
                var fullMask = new byte[Math.Max(1, width * height)];
                Array.Fill(fullMask, (byte)255);

                var fullMaskPng = await ImageCodec.EncodeMaskPngAsync(fullMask, width, height)
                    .ConfigureAwait(false);

                var repaired = await FluxFillEditAsync(baseUrl, payloadImage, fullMaskPng,
                    "repair holes and smeared streaks, keep the original composition, "
                    + "same lighting, same textures, photorealistic", timeout.Token)
                    .ConfigureAwait(false);

                return new InpaintOutcome { Png = repaired, EngineName = CloudName };
            }

            var png = await OpenAiRefineAsync(baseUrl, settings.EditApiKey, settings.EditModel,
                payloadImage, width, height, timeout.Token).ConfigureAwait(false);

            return new InpaintOutcome { Png = png, EngineName = CloudName };
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ImageApiException($"图像接口超时（{CloudName}）。请稍后重试或降低输出尺寸。");
        }
    }

    private static async Task<byte[]> OpenAiRefineAsync(string baseUrl, string apiKey, string model,
        byte[] imagePng, int width, int height, CancellationToken ct)
    {
        var root = baseUrl.Contains("/v1") ? baseUrl : $"{baseUrl}/v1";
        var endpoint = $"{root}/images/edits";

        using var form = new MultipartFormDataContent();
        var imageContent = new ByteArrayContent(imagePng);
        imageContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        form.Add(imageContent, "image", "image.png");
        form.Add(new StringContent(string.IsNullOrWhiteSpace(model) ? "gpt-image-1" : model), "model");
        form.Add(new StringContent("fill the missing areas and remove rendering artifacts, keep the composition"),
            "prompt");
        form.Add(new StringContent("1"), "n");
        form.Add(new StringContent($"{width}x{height}"), "size");

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = form };
        if (!string.IsNullOrWhiteSpace(apiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        using var response = await Http.SendAsync(request, ct).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
            throw new ImageApiException($"图像接口返回 {(int)response.StatusCode}：{ReadError(body)}");

        var parsed = JsonSerializer.Deserialize<OpenAiResponse>(body);
        var item = parsed?.Data is { Count: > 0 } data ? data[0] : null;

        if (!string.IsNullOrEmpty(item?.B64Json))
            return Convert.FromBase64String(StripDataUri(item!.B64Json!));

        if (!string.IsNullOrEmpty(item?.Url))
        {
            using var download = await Http.GetAsync(item!.Url, ct).ConfigureAwait(false);
            download.EnsureSuccessStatusCode();
            return await download.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        }

        throw new ImageApiException("图像接口没有返回图像。");
    }

    private static async Task<byte[]> OpenAiEditAsync(string baseUrl, string apiKey, string model,
        byte[] imagePng, byte[] maskPng, string prompt, int width, int height, CancellationToken ct)
    {
        var root = baseUrl.Contains("/v1") ? baseUrl : $"{baseUrl}/v1";
        var endpoint = $"{root}/images/edits";

        // images/edits 的遮罩语义是「透明 = 重绘」，与内部黑白遮罩相反，必须转换
        var editMask = await ImageCodec.EncodeEditMaskPngAsync(maskPng, width, height)
            .ConfigureAwait(false);

        using var form = new MultipartFormDataContent();

        var imageContent = new ByteArrayContent(imagePng);
        imageContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        form.Add(imageContent, "image", "image.png");

        var maskContent = new ByteArrayContent(editMask);
        maskContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        form.Add(maskContent, "mask", "mask.png");

        form.Add(new StringContent(string.IsNullOrWhiteSpace(model) ? "gpt-image-1" : model), "model");
        form.Add(new StringContent(prompt), "prompt");
        form.Add(new StringContent("1"), "n");
        form.Add(new StringContent($"{width}x{height}"), "size");

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = form };
        if (!string.IsNullOrWhiteSpace(apiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        using var response = await Http.SendAsync(request, ct).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
            throw new ImageApiException($"图像接口返回 {(int)response.StatusCode}：{ReadError(body)}");

        var parsed = JsonSerializer.Deserialize<OpenAiResponse>(body);
        var item = parsed?.Data is { Count: > 0 } data ? data[0] : null;

        if (!string.IsNullOrEmpty(item?.B64Json))
            return Convert.FromBase64String(StripDataUri(item!.B64Json!));

        if (!string.IsNullOrEmpty(item?.Url))
        {
            using var download = await Http.GetAsync(item!.Url, ct).ConfigureAwait(false);
            download.EnsureSuccessStatusCode();
            return await download.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        }

        throw new ImageApiException("图像接口没有返回图像。");
    }

    /// <summary>
    /// FLUX Fill 蒙版重绘：POST {base}/v1/edit，multipart（image / mask / prompt），
    /// 直接返回图片二进制。遮罩语义为「白色 = 需要重绘」，与内部黑白遮罩一致，无需反转。
    /// </summary>
    private static async Task<byte[]> FluxFillEditAsync(string baseUrl, byte[] imageBytes,
        byte[] maskPng, string prompt, CancellationToken ct)
    {
        var root = baseUrl.TrimEnd('/');
        var endpoint = root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)
            ? $"{root}/edit"
            : $"{root}/v1/edit";

        using var form = new MultipartFormDataContent();

        var imageContent = new ByteArrayContent(imageBytes);
        imageContent.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
        form.Add(imageContent, "image", "image.jpg");

        var maskContent = new ByteArrayContent(maskPng);
        maskContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        form.Add(maskContent, "mask", "mask.png");

        // prompt 留空时服务按上下文自然填补
        form.Add(new StringContent(prompt ?? string.Empty), "prompt");

        using var response = await Http.PostAsync(endpoint, form, ct).ConfigureAwait(false);
        var bytes = await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            throw new ImageApiException(
                $"图像服务返回 {(int)response.StatusCode}：{ReadError(Encoding.UTF8.GetString(bytes))}");
        }

        if (bytes.Length == 0)
            throw new ImageApiException("图像服务没有返回结果。");

        // 正常路径直接是图片；若服务包了一层 JSON，兜底解析 base64
        var mediaType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
        if (mediaType.Contains("json", StringComparison.OrdinalIgnoreCase))
        {
            using var document = JsonDocument.Parse(Encoding.UTF8.GetString(bytes));
            var rootElement = document.RootElement;

            foreach (var key in new[] { "image", "b64_json", "data" })
            {
                if (!rootElement.TryGetProperty(key, out var node)) continue;
                if (node.ValueKind == JsonValueKind.String)
                    return Convert.FromBase64String(StripDataUri(node.GetString() ?? string.Empty));
            }

            throw new ImageApiException("图像服务没有返回图片数据。");
        }

        return bytes;
    }

    /// <summary>从错误响应里取出可读信息，避免只给状态码。</summary>
    private static string ReadError(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "无响应内容。";

        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.String) return error.GetString() ?? body;
                if (error.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String)
                    return message.GetString() ?? body;
            }
            if (root.TryGetProperty("detail", out var detail))
            {
                if (detail.ValueKind == JsonValueKind.String) return detail.GetString() ?? body;
                return detail.ToString();
            }
        }
        catch (JsonException)
        {
            // 非 JSON 响应直接截断展示
        }

        return body.Length > 240 ? body[..240] + "…" : body;
    }

    private static string StripDataUri(string value)
    {
        var index = value.IndexOf("base64,", StringComparison.OrdinalIgnoreCase);
        return index >= 0 ? value[(index + 7)..] : value;
    }

    private sealed class OpenAiResponse
    {
        [JsonPropertyName("data")] public System.Collections.Generic.List<OpenAiItem>? Data { get; set; }
    }

    private sealed class OpenAiItem
    {
        [JsonPropertyName("b64_json")] public string? B64Json { get; set; }
        [JsonPropertyName("url")] public string? Url { get; set; }
    }
}
