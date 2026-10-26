using System;
using System.Threading.Tasks;
using DonySettings.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DonySettings.Views;

public sealed partial class ModelsPage : Page
{
    public ModelsPage()
    {
        InitializeComponent();
    }

    public async Task ReloadAsync()
    {
        var s = SettingsStore.Instance;
        BaseUrlBox.Text = s.GetString("OPENAI_API_BASE");
        ApiKeyBox.Password = s.GetString("OPENAI_API_KEY");
        ModelBox.Text = s.GetString("OPENAI_MODEL");
        VisionModelBox.Text = s.GetString("OPENAI_VISION_MODEL");
        ImageBaseUrlBox.Text = s.GetString("IMAGE_API_BASE");
        ImageApiKeyBox.Password = s.GetString("IMAGE_API_KEY");
        ImageModelBox.Text = s.GetString("IMAGE_MODEL");
        ImageProviderBox.SelectedIndex = ProviderIndex(s.GetString("IMAGE_PROVIDER", "auto"));
        EditBaseUrlBox.Text = s.GetString("EDIT_API_BASE");
        EditApiKeyBox.Password = s.GetString("EDIT_API_KEY");
        EditModelBox.Text = s.GetString("EDIT_MODEL");
        EditProviderBox.SelectedIndex = EditProviderIndex(s.GetString("EDIT_PROVIDER", "auto"));
        await Task.CompletedTask;
    }

    /// <summary>auto / openai / dashscope 与下拉项一一对应。</summary>
    private static int ProviderIndex(string value) => value switch
    {
        "openai" => 1,
        "dashscope" => 2,
        // 旧配置里的 sdwebui 已不再支持，回落到自动识别
        "sdwebui" => 0,
        _ => 0,
    };

    /// <summary>auto / filledit / openai 与编辑模型下拉项一一对应。</summary>
    private static int EditProviderIndex(string value) => value switch
    {
        "filledit" or "fluxfill" or "flux-fill" => 1,
        "openai" => 2,
        // 旧配置里的 sdwebui 已不再支持，回落到自动识别
        "sdwebui" => 0,
        _ => 0,
    };

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        Busy.IsActive = true;
        try
        {
            var s = SettingsStore.Instance;
            s.Set("OPENAI_API_BASE", BaseUrlBox.Text.Trim());
            s.Set("OPENAI_API_KEY", ApiKeyBox.Password.Trim());
            s.Set("OPENAI_MODEL", ModelBox.Text.Trim());
            s.Set("OPENAI_VISION_MODEL",
                string.IsNullOrWhiteSpace(VisionModelBox.Text) ? null : VisionModelBox.Text.Trim());
            s.Set("IMAGE_API_BASE", ImageBaseUrlBox.Text.Trim());
            s.Set("IMAGE_API_KEY", ImageApiKeyBox.Password.Trim());
            s.Set("IMAGE_MODEL", ImageModelBox.Text.Trim());
            s.Set("IMAGE_PROVIDER",
                (ImageProviderBox.SelectedItem as ComboBoxItem)?.Tag as string ?? "auto");
            s.Set("EDIT_API_BASE", EditBaseUrlBox.Text.Trim());
            s.Set("EDIT_API_KEY", EditApiKeyBox.Password.Trim());
            s.Set("EDIT_MODEL", EditModelBox.Text.Trim());
            s.Set("EDIT_PROVIDER",
                (EditProviderBox.SelectedItem as ComboBoxItem)?.Tag as string ?? "auto");
            s.Save();
            await s.NotifyBackendAsync();
            InfoBarHelper.Show(Result, InfoBarSeverity.Success, "已保存。重启 STUDIO 后生效。");
        }
        catch (Exception ex)
        {
            InfoBarHelper.Show(Result, InfoBarSeverity.Error, $"设置未能保存。{ex.Message}");
        }
        finally
        {
            Busy.IsActive = false;
        }
    }

    private async void Reload_Click(object sender, RoutedEventArgs e)
    {
        Result.IsOpen = false;
        await ReloadAsync();
    }
}
