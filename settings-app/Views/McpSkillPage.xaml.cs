using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using DonySettings.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DonySettings.Views;

/// <summary>一行技能（绑定 SkillsList 的 DataTemplate：Name/Description/Id）。</summary>
public sealed class SkillRow
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
}

public sealed partial class McpSkillPage : Page
{
    private bool _loading;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(3) };

    public McpSkillPage()
    {
        InitializeComponent();
        McpList.ItemsSource = SettingsStore.Instance.McpServers;
    }

    public async Task ReloadAsync()
    {
        _loading = true;
        var s = SettingsStore.Instance;
        SkillsDirBox.Text = s.GetString("AGENT_SKILLS_DIR", DefaultSkillsDir());
        UpdateEmpty();
        _loading = false;
        await LoadSkillsAsync();
    }

    private static string DefaultSkillsDir()
    {
        var root = SettingsStore.Instance.RepoRoot;
        if (root is not null) return Path.Combine(root, "backend", "skills");

        // 打包态：backend 是 PyInstaller onedir，源码位于 _internal/backend/skills
        var packaged = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "backend", "_internal", "backend", "skills"));
        return Directory.Exists(packaged) ? packaged : "";
    }

    private static string ApiBase() =>
        Environment.GetEnvironmentVariable("DONY_APP_API") ?? "http://127.0.0.1:8769";

    /// <summary>从后端 /api/skills 读取技能清单（后端每次重扫目录，新增技能即时可见）。</summary>
    private async Task LoadSkillsAsync()
    {
        List<SkillRow> list;
        try
        {
            using var resp = await _http.GetAsync($"{ApiBase()}/api/skills");
            resp.EnsureSuccessStatusCode();
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            list = new List<SkillRow>();
            foreach (var item in doc.RootElement.GetProperty("skills").EnumerateArray())
            {
                list.Add(new SkillRow
                {
                    Id = GetString(item, "id"),
                    Name = GetString(item, "name"),
                    Description = GetString(item, "description"),
                });
            }
        }
        catch
        {
            // 后端没在跑（Dony 未启动）：如实提示，不吓人
            SkillsList.ItemsSource = null;
            SkillsEmpty.Visibility = Visibility.Collapsed;
            SkillsStatus.Text = "无法连接 STUDIO，技能列表暂不可用。启动 STUDIO 后点击「刷新列表」重试。";
            return;
        }
        SkillsList.ItemsSource = list;
        SkillsEmpty.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        SkillsStatus.Text = list.Count == 0
            ? "目录中没有技能。"
            : $"已安装 {list.Count} 个技能。新增或删除即时生效，下一轮对话可用。";
    }

    private static string GetString(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private async void RefreshSkills_Click(object sender, RoutedEventArgs e)
        => await LoadSkillsAsync();

    private void UpdateEmpty()
        => McpEmpty.Visibility = SettingsStore.Instance.McpServers.Count == 0
            ? Visibility.Visible
            : Visibility.Collapsed;

    private async void Add_Click(object sender, RoutedEventArgs e)
    {
        var nameBox = new TextBox { Header = "名称", PlaceholderText = "例如：天气" };
        var commandBox = new TextBox { Header = "启动命令", PlaceholderText = "npx -y server-name" };
        var dialog = new ContentDialog
        {
            Title = "添加 MCP 服务器",
            Content = new StackPanel { Spacing = 12, Children = { nameBox, commandBox } },
            PrimaryButtonText = "添加",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = XamlRoot,
        };

        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        var name = nameBox.Text.Trim();
        if (name.Length == 0) return;

        SettingsStore.Instance.McpServers.Add(
            new McpServer { Name = name, Command = commandBox.Text.Trim() });
        SettingsStore.Instance.Save();
        UpdateEmpty();
    }

    private void Remove_Click(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).DataContext is McpServer entry)
        {
            SettingsStore.Instance.McpServers.Remove(entry);
            SettingsStore.Instance.Save();
            UpdateEmpty();
        }
    }

    private void SkillsDir_LostFocus(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var s = SettingsStore.Instance;
        var dir = SkillsDirBox.Text.Trim();
        if (dir.Length == 0) dir = DefaultSkillsDir();
        s.Set("AGENT_SKILLS_DIR", dir);
        s.Save();
    }

    private void OpenSkillsDir_Click(object sender, RoutedEventArgs e)
    {
        var dir = SkillsDirBox.Text.Trim();
        if (dir.Length == 0 || !Directory.Exists(dir)) return;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = dir,
                UseShellExecute = true,
            });
        }
        catch
        {
            /* 目录不存在或被占用时忽略 */
        }
    }
}
