using System;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using DonySettings.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace DonySettings.Views;

public sealed partial class NotificationsPage : Page
{
    private bool _loading;

    public NotificationsPage()
    {
        InitializeComponent();
    }

    public async Task ReloadAsync()
    {
        _loading = true;
        var s = SettingsStore.Instance;
        DndToggle.IsOn = s.GetBool("SMART_DND_ENABLED");
        SummaryToggle.IsOn = s.GetBool("NOTIFY_SUMMARY_ENABLED");
        var threshold = s.GetInt("NOTIFY_SUMMARY_THRESHOLD", 3);
        ThresholdBox.Value = threshold < 2 ? 3 : threshold;
        ThresholdBar.IsOpen = false;
        _loading = false;
        await RefreshStatusAsync();
    }

    private async Task RefreshStatusAsync()
    {
        RefreshButton.IsEnabled = false;
        var status = await SettingsStore.Instance.GetNotificationStatusAsync();
        ApplyStatus(status);
        RefreshButton.IsEnabled = true;
    }

    private void ApplyStatus(JsonObject? status)
    {
        if (status is null)
        {
            SetRow(ListenerDot, ListenerText, "通知监听：未知", false);
            SetRow(FocusDot, FocusText, "系统专注模式：未知", null);
            SetRow(ClassifierDot, ClassifierText, "分类模型：未知", null);
            SetRow(ModelDot, ModelText, "摘要模型：未知", null);
            StatusHint.Text = "无法连接通知服务（127.0.0.1:8770）。请启动 intelligentSTUDIO 主程序后重试。";
            ModelBar.IsOpen = false;
            return;
        }

        var listener = status["listener"] as JsonObject;
        var running = ReadBool(listener, "running");
        var baseline = ReadInt(listener, "baseline") ?? 0;
        var error = listener?["error"]?.GetValue<string>() ?? "";
        SetRow(ListenerDot, ListenerText,
            running == true
                ? $"通知监听：运行中，启动时跳过 {baseline} 条历史通知"
                : "通知监听：未运行",
            running);
        StatusHint.Text = string.IsNullOrEmpty(error)
            ? "通知服务随 intelligentSTUDIO 主程序启动；保存后立即生效。"
            : $"通知监听异常：{error}";

        var focus = status["focus"] as JsonObject;
        var known = ReadBool(focus, "known") ?? false;
        var active = ReadBool(focus, "active") ?? false;
        var source = focus?["source"]?.GetValue<string>() ?? "none";
        var sourceText = source switch
        {
            "wnf" => "勿扰状态",
            "shell_state" => "系统安静时间",
            "focus_session" => "专注会话",
            _ => "无法读取",
        };
        SetRow(FocusDot, FocusText,
            known
                ? $"系统专注模式：{(active ? "已开启" : "已关闭")}（{sourceText}）"
                : "系统专注模式：未知（按已关闭处理）",
            known ? active : null);

        var classifier = status["classifier"] as JsonObject;
        var classifierReady = ReadBool(classifier, "ready") ?? false;
        var classifierLoaded = ReadBool(classifier, "loaded") ?? false;
        SetRow(ClassifierDot, ClassifierText,
            classifierReady
                ? $"分类模型：已就绪{(classifierLoaded ? "，当前已加载" : "，首次判断时加载")}"
                : "分类模型：缺少文件，智能勿扰模式不可用",
            classifierReady);

        var summarizer = status["model"] as JsonObject;
        var summarizerReady = ReadBool(summarizer, "ready") ?? false;
        var summarizerLoaded = ReadBool(summarizer, "loaded") ?? false;
        SetRow(ModelDot, ModelText,
            summarizerReady
                ? $"摘要模型：已就绪{(summarizerLoaded ? "，当前已加载" : "，生成首条摘要时加载")}"
                : "摘要模型：缺少文件，通知智能不可用",
            summarizerReady);

        ModelBar.IsOpen = !classifierReady || !summarizerReady;
        if (ModelBar.IsOpen)
        {
            var classifierDir = classifier?["model_dir"]?.GetValue<string>() ?? "";
            var summarizerDir = summarizer?["model_dir"]?.GetValue<string>() ?? "";
            var parts = new System.Collections.Generic.List<string>();
            if (!classifierReady) parts.Add($"分类模型目录：{classifierDir}");
            if (!summarizerReady) parts.Add($"摘要模型目录：{summarizerDir}");
            ModelBar.Message = string.Join("；", parts);
        }
    }

    private static bool? ReadBool(JsonObject? obj, string key)
    {
        if (obj?[key] is JsonValue value && value.TryGetValue<bool>(out var result))
            return result;
        return null;
    }

    private static int? ReadInt(JsonObject? obj, string key)
    {
        if (obj?[key] is JsonValue value && value.TryGetValue<int>(out var result))
            return result;
        return null;
    }

    private void SetRow(Ellipse dot, TextBlock text, string message, bool? ok)
    {
        text.Text = message;
        var key = ok is null ? "StatusIdleBrush" : ok.Value ? "StatusOkBrush" : "StatusBadBrush";
        dot.Fill = (Brush)Resources[key];
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e)
    {
        await RefreshStatusAsync();
    }

    private void Dnd_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var s = SettingsStore.Instance;
        s.Set("SMART_DND_ENABLED", DndToggle.IsOn);
        s.Save();
        _ = s.NotifyBackendAsync();
    }

    private void Summary_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var s = SettingsStore.Instance;
        s.Set("NOTIFY_SUMMARY_ENABLED", SummaryToggle.IsOn);
        s.Save();
        _ = s.NotifyBackendAsync();
    }

    private async void SaveThreshold_Click(object sender, RoutedEventArgs e)
    {
        if (double.IsNaN(ThresholdBox.Value))
        {
            InfoBarHelper.Show(ThresholdBar, InfoBarSeverity.Warning,
                "请输入 2 到 99 之间的条数。");
            return;
        }

        var value = (int)Math.Clamp(ThresholdBox.Value, 2, 99);
        SaveThresholdButton.IsEnabled = false;
        try
        {
            var s = SettingsStore.Instance;
            s.Set("NOTIFY_SUMMARY_THRESHOLD", value);
            s.Save();
            await s.NotifyBackendAsync();
            InfoBarHelper.Show(ThresholdBar, InfoBarSeverity.Success,
                $"已保存。同一应用达到 {value} 条通知时开始生成摘要。");
        }
        catch (Exception ex)
        {
            InfoBarHelper.Show(ThresholdBar, InfoBarSeverity.Error,
                $"设置未能保存。{ex.Message}");
        }
        finally
        {
            SaveThresholdButton.IsEnabled = true;
        }
    }
}
