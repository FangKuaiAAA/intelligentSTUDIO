using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Dony.Views;

public sealed partial class HistoryPage : Page
{
    private string? _currentId;
    private string _currentTitle = "";
    private bool _busy;

    public HistoryPage()
    {
        InitializeComponent();
    }

    // ---------- 加载 ----------
    public async Task ReloadAsync()
    {
        try
        {
            var sessions = await MainWindow.Api.GetSessionsAsync();
            SessionList.ItemsSource = sessions;
            EmptyHint.Visibility = sessions.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            if (_currentId is not null)
            {
                var keep = sessions.Find(s => s.Id == _currentId);
                if (keep is not null)
                    SessionList.SelectedItem = keep;
            }
        }
        catch (Exception ex)
        {
            DetailMeta.Text = "无法读取对话记录。请确认 Dony 正在运行，然后重试。";
            Debug.WriteLine($"[history] 读取失败：{ex}");
        }
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await ReloadAsync();

    private async void Session_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (SessionList.SelectedItem is not SessionSummary item) return;
        _currentId = item.Id;
        _currentTitle = item.Title;
        SetEmptyWatermark(false);      // 打开对话后收起空态水印
        await ShowSessionAsync(item);
    }

    /// <summary>空态水印：只在"没有打开任何对话"时显示（启动时、删除当前对话后）。</summary>
    private void SetEmptyWatermark(bool show)
        => EmptyWatermark.Visibility = show ? Visibility.Visible : Visibility.Collapsed;

    private async Task ShowSessionAsync(SessionSummary item)
    {
        try
        {
            var detail = await MainWindow.Api.GetSessionAsync(item.Id);
            _currentTitle = detail?.Title ?? item.Title;
            DetailTitle.Text = _currentTitle;
            DetailMeta.Text = $"{item.UpdatedText} · {detail?.Turns.Count ?? 0} 条消息";
            RenameButton.IsEnabled = true;
            ChatBox.IsEnabled = true;

            MsgPanel.Children.Clear();
            if (detail is null || detail.Turns.Count == 0)
            {
                AddInfoText("这条对话还没有内容。");
            }
            else
            {
                foreach (var turn in detail.Turns)
                    AddBubble(turn.Role == "user", turn.Content, turn.Cards, turn.Operations);
            }
            ScrollToEnd();
        }
        catch (Exception ex)
        {
            DetailMeta.Text = "无法打开这条对话。请重新选择一次。";
            Debug.WriteLine($"[history] 打开失败：{ex}");
        }
    }

    // ---------- 继续对话 ----------
    private async void ChatBox_Submitted(object? sender, string text)
    {
        if (_busy || _currentId is null) return;
        var sessionId = _currentId;
        _busy = true;
        ChatBox.Text = "";
        ChatBox.IsLoading = true;

        AddBubble(true, text, null);
        var answerText = AddBubble(false, "", null);
        var cardsPanel = (Panel)answerText.Tag;
        var parts = new StringBuilder();

        try
        {
            await foreach (var ev in MainWindow.Api.ChatAsync(sessionId, text))
            {
                switch (ev.Type)
                {
                    // —— 流式文本（与主界面同一协议）——
                    case "text-chunk":
                        parts.Append(ev.Delta);
                        answerText.Text = parts.ToString();
                        ScrollToEnd();
                        break;
                    case "delta":            // 兼容旧协议
                        parts.Append(ev.Text);
                        answerText.Text = parts.ToString();
                        ScrollToEnd();
                        break;
                    case "text-reset":       // 模型文字后紧跟工具调用：撤销已转发内容
                        parts.Clear();
                        answerText.Text = "";
                        break;

                    // —— 模式与任务计划 ——
                    case "mode":
                        ChatBox.SetStatus(ev.Mode == "task" ? "正在执行任务" : "");
                        break;
                    case "plan":
                        if (ev.Steps.Count > 0)
                        {
                            AddCard(cardsPanel, $"任务计划 · {ev.Steps.Count} 步",
                                    string.Join(" → ", ev.Steps));
                            ChatBox.SetStatus($"正在执行 {ev.Steps.Count} 个步骤");
                            ScrollToEnd();
                        }
                        break;

                    // —— 工具执行 ——
                    case "tool-start":
                    case "tool":             // 后者为旧协议
                        ChatBox.SetStatus($"正在执行：{ev.Label}");
                        // 记下这一步：等 tool-end 拿到结果后落成一行“执行的操作”
                        _pendingOp = string.IsNullOrWhiteSpace(ev.Op) ? ev.Label : ev.Op;
                        break;
                    case "tool-end":
                        if (string.IsNullOrWhiteSpace(_pendingOp))
                            _pendingOp = ev.Label;
                        if (!string.IsNullOrWhiteSpace(_pendingOp))
                        {
                            AddOperation(cardsPanel, ev.Ok ? _pendingOp! : $"{_pendingOp}（未成功）");
                            ScrollToEnd();
                        }
                        _pendingOp = null;
                        ChatBox.SetStatus("");
                        break;
                    case "cards":
                        foreach (var c in ev.Cards) AddCard(cardsPanel, c.Title, c.SubtitleWithDetails);
                        ScrollToEnd();
                        break;
                    case "card":             // 兼容旧协议
                        if (ev.Card is not null)
                            AddCard(cardsPanel, ev.Card.Title, ev.Card.SubtitleWithDetails);
                        ScrollToEnd();
                        break;

                    // —— 需要用户当场确认 / 补充信息 ——
                    case "ask":
                        await HandleAskAsync(sessionId, ev);
                        break;

                    case "done":
                        parts.Clear();
                        parts.Append(ev.Text);
                        answerText.Text = ev.Text;
                        foreach (var c in ev.Cards) AddCard(cardsPanel, c.Title, c.SubtitleWithDetails);
                        ChatBox.SetStatus("");
                        ScrollToEnd();
                        break;
                    case "error":
                        var why = string.IsNullOrEmpty(ev.Message) ? ev.Text : ev.Message;
                        answerText.Text = string.IsNullOrEmpty(why)
                            ? "这一步没完成，可以再试一次。"
                            : $"未能完成：{why}";
                        ChatBox.SetStatus("");
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            answerText.Text = "与 Dony 的连接中断了，请再试一次。";
            Debug.WriteLine($"[history] 对话中断：{ex}");
        }
        finally
        {
            _busy = false;
            ChatBox.IsLoading = false;
            await ReloadAsync();
        }
    }

    /// <summary>
    /// 处理 ask 事件：confirm = 敏感操作确认（允许/不允许），question = 模型反问（输入回答）。
    /// 结果通过 POST 回填给后端正在进行的那一轮对话。
    /// </summary>
    private async Task HandleAskAsync(string sessionId, ChatEvent ev)
    {
        try
        {
            if (ev.Kind == "confirm")
            {
                var dialog = new ContentDialog
                {
                    Title = "确认操作",
                    Content = new TextBlock { Text = ev.Text, TextWrapping = TextWrapping.Wrap },
                    PrimaryButtonText = "允许",
                    CloseButtonText = "不允许",
                    DefaultButton = ContentDialogButton.Close,
                    XamlRoot = XamlRoot,
                };
                var result = await dialog.ShowAsync();
                await MainWindow.Api.RespondAskAsync(sessionId, ev.AskId,
                    approved: result == ContentDialogResult.Primary);
                return;
            }

            var input = new TextBox
            {
                PlaceholderText = "输入回答",
                AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap,
                MinHeight = 64,
            };
            var panel = new StackPanel { Spacing = 8 };
            panel.Children.Add(new TextBlock { Text = ev.Text, TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(input);
            var askDialog = new ContentDialog
            {
                Title = "Dony 需要更多信息",
                Content = panel,
                PrimaryButtonText = "回答",
                CloseButtonText = "跳过",
                DefaultButton = ContentDialogButton.Primary,
                XamlRoot = XamlRoot,
            };
            var askResult = await askDialog.ShowAsync();
            var answer = askResult == ContentDialogResult.Primary
                ? (input.Text?.Trim() ?? "")
                : "（用户没有回答，请按缺少信息的情况处理或结束任务）";
            await MainWindow.Api.RespondAskAsync(sessionId, ev.AskId, text: answer);
        }
        catch (Exception ex)
        {
            DetailMeta.Text = "回答没能送达 Dony，请再试一次。";
            Debug.WriteLine($"[history] 应答失败：{ex}");
        }
        finally
        {
            ChatBox.SetStatus("");
        }
    }

    private async void Rename_Click(object sender, RoutedEventArgs e)
    {
        if (_currentId is null) return;
        var box = new TextBox { Text = _currentTitle, SelectionStart = _currentTitle.Length };
        var dialog = new ContentDialog
        {
            Title = "重命名对话",
            Content = box,
            PrimaryButtonText = "保存",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = XamlRoot,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        try
        {
            await MainWindow.Api.RenameSessionAsync(_currentId, box.Text?.Trim() ?? "");
            DetailTitle.Text = box.Text?.Trim() ?? "";
            _currentTitle = DetailTitle.Text;
            await ReloadAsync();
        }
        catch (Exception ex)
        {
            DetailMeta.Text = "重命名没有生效，请再试一次。";
            Debug.WriteLine($"[history] 重命名失败：{ex}");
        }
    }

    private async void DeleteSession_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not SessionSummary item) return;
        var dialog = new ContentDialog
        {
            Title = "删除对话",
            Content = $"删除「{item.Title}」？此操作无法撤销。",
            PrimaryButtonText = "删除",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = XamlRoot,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        try
        {
            await MainWindow.Api.DeleteSessionAsync(item.Id);
            if (_currentId == item.Id)
            {
                _currentId = null;
                MsgPanel.Children.Clear();
                MsgPanel.Children.Add(new TextBlock
                {
                    Text = "已删除。",
                    Opacity = 0.6,
                    FontSize = 13,
                });
                DetailTitle.Text = "选择一条对话";
                DetailMeta.Text = "";
                ChatBox.IsEnabled = false;
                RenameButton.IsEnabled = false;
                SetEmptyWatermark(true);
            }
            await ReloadAsync();
        }
        catch (Exception ex)
        {
            DetailMeta.Text = "没能删除这条对话，请再试一次。";
            Debug.WriteLine($"[history] 删除失败：{ex}");
        }
    }

    // ---------- 消息气泡 ----------
    /// <summary>这一轮正在执行的操作用来描述（tool-start 记下，tool-end 落盘）。</summary>
    private string? _pendingOp;

    /// <summary>气泡里承载「执行的操作」的面板：始终排在成果卡片之前。</summary>
    private static StackPanel? OpsPanelOf(Panel host)
        => host.Children.OfType<StackPanel>().FirstOrDefault(p => (p.Tag as string) == "ops");

    /// <summary>往气泡里追加一条「执行的操作」（历史回看与实时执行共用同一串文字）。</summary>
    private void AddOperation(Panel host, string text)
    {
        var ops = OpsPanelOf(host);
        if (ops is null)
        {
            ops = new StackPanel { Spacing = 2, Tag = "ops" };
            host.Children.Insert(0, ops);      // 操作留痕在卡片上方
        }
        ops.Children.Add(new TextBlock
        {
            Text = "· " + text,
            FontSize = 11.5,
            Opacity = 0.62,
            TextWrapping = TextWrapping.Wrap,
            IsTextSelectionEnabled = true,
        });
    }

    /// <summary>添加消息气泡；返回正文 TextBlock（Tag 为承载「执行的操作 + 成果卡片」的 Panel）。</summary>
    private TextBlock AddBubble(bool isUser, string text, IReadOnlyList<CardInfo>? cards,
                                IReadOnlyList<string>? operations = null)
    {
        var content = new StackPanel { Spacing = 8 };
        var body = new TextBlock
        {
            Text = text,
            TextWrapping = TextWrapping.Wrap,
            IsTextSelectionEnabled = true,
            FontSize = 13.5,
        };
        content.Children.Add(body);

        var cardHost = new StackPanel { Spacing = 6 };
        content.Children.Add(cardHost);
        body.Tag = cardHost;

        // 历史里回看时：把这一轮执行过的操作列在成果卡片之前
        if (!isUser && operations is { Count: > 0 })
            foreach (var op in operations) AddOperation(cardHost, op);

        if (cards is not null)
            foreach (var c in cards) AddCard(cardHost, c.Title, c.SubtitleWithDetails);

        var bubble = new Border
        {
            CornerRadius = new CornerRadius(14),
            Padding = new Thickness(14, 10, 14, 10),
            HorizontalAlignment = isUser ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            MaxWidth = 620,
            Background = (Brush)Application.Current.Resources[
                isUser ? "AccentFillColorDefaultBrush" : "CardBackgroundFillColorSecondaryBrush"],
            Child = content,
        };
        if (isUser && content.Children[0] is TextBlock ub)
            ub.Foreground = (Brush)Application.Current.Resources["TextOnAccentFillColorPrimaryBrush"];

        MsgPanel.Children.Add(bubble);
        return body;
    }

    private static void AddCard(Panel host, string title, string subtitle)
    {
        if (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(subtitle)) return;
        host.Children.Add(new Border
        {
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(10, 7, 10, 7),
            Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
            BorderThickness = new Thickness(1),
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            Child = new StackPanel
            {
                Spacing = 2,
                Children =
                {
                    new TextBlock { Text = title, FontWeight = FontWeights.SemiBold, FontSize = 12.5 },
                    new TextBlock { Text = subtitle, FontSize = 11, Opacity = 0.7,
                                    TextWrapping = TextWrapping.Wrap },
                },
            },
        });
    }

    private void AddInfoText(string text)
        => MsgPanel.Children.Add(new TextBlock { Text = text, Opacity = 0.6, FontSize = 13 });

    private void ScrollToEnd()
        => MsgScroll.ChangeView(null, MsgScroll.ScrollableHeight, null, true);
}
