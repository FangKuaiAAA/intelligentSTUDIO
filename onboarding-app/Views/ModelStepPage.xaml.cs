using System;
using System.Threading.Tasks;
using DonySettings.Services;
using IntelligentStudio.Onboarding.Services;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace IntelligentStudio.Onboarding.Views;

/// <summary>第 10 页：四组模型配置。点「继续」时统一写盘，写失败则留在本页并说明原因。</summary>
public sealed partial class ModelStepPage : UserControl, IStepView
{
    public ModelStepPage(OnboardingStep step)
    {
        InitializeComponent();
        TitleText.Text = step.Title;
        DescText.Text = step.Description;
        StepIcon.Source = IconSource(step.IconFile);
        Reload();
    }

    public void Reload()
    {
        var s = SettingsStore.Instance;
        MainBaseBox.Text = s.GetString("OPENAI_API_BASE");
        MainKeyBox.Password = s.GetString("OPENAI_API_KEY");
        MainModelBox.Text = s.GetString("OPENAI_MODEL");
        VisionBaseBox.Text = s.GetString("OPENAI_VISION_API_BASE");
        VisionKeyBox.Password = s.GetString("OPENAI_VISION_API_KEY");
        VisionModelBox.Text = s.GetString("OPENAI_VISION_MODEL");
        ImageBaseBox.Text = s.GetString("IMAGE_API_BASE");
        ImageKeyBox.Password = s.GetString("IMAGE_API_KEY");
        ImageModelBox.Text = s.GetString("IMAGE_MODEL");
        ImageProviderBox.SelectedIndex = ProviderIndex(s.GetString("IMAGE_PROVIDER", "auto"));
        EditBaseBox.Text = s.GetString("EDIT_API_BASE");
        EditKeyBox.Password = s.GetString("EDIT_API_KEY");
        EditModelBox.Text = s.GetString("EDIT_MODEL");
        EditProviderBox.SelectedIndex = EditProviderIndex(s.GetString("EDIT_PROVIDER", "auto"));
        Result.IsOpen = false;
    }

    public void PlayMedia() { }

    public void StopMedia() { }

    public async Task<bool> CommitAsync()
    {
        if (!IsWebAddress(MainBaseBox.Text) || !IsWebAddress(VisionBaseBox.Text)
            || !IsWebAddress(ImageBaseBox.Text) || !IsWebAddress(EditBaseBox.Text))
        {
            ShowError("接口地址需要以 http:// 或 https:// 开头。");
            return false;
        }

        try
        {
            var s = SettingsStore.Instance;
            s.Set("OPENAI_API_BASE", MainBaseBox.Text.Trim());
            s.Set("OPENAI_API_KEY", MainKeyBox.Password.Trim());
            s.Set("OPENAI_MODEL", MainModelBox.Text.Trim());

            s.Set("OPENAI_VISION_API_BASE", Empty(VisionBaseBox.Text));
            s.Set("OPENAI_VISION_API_KEY", Empty(VisionKeyBox.Password));
            s.Set("OPENAI_VISION_MODEL", Empty(VisionModelBox.Text));

            s.Set("IMAGE_API_BASE", ImageBaseBox.Text.Trim());
            s.Set("IMAGE_API_KEY", ImageKeyBox.Password.Trim());
            s.Set("IMAGE_MODEL", ImageModelBox.Text.Trim());
            s.Set("IMAGE_PROVIDER", (ImageProviderBox.SelectedItem as ComboBoxItem)?.Tag as string ?? "auto");

            s.Set("EDIT_API_BASE", EditBaseBox.Text.Trim());
            s.Set("EDIT_API_KEY", EditKeyBox.Password.Trim());
            s.Set("EDIT_MODEL", EditModelBox.Text.Trim());
            s.Set("EDIT_PROVIDER", (EditProviderBox.SelectedItem as ComboBoxItem)?.Tag as string ?? "auto");

            s.Save();
            await s.NotifyBackendAsync();
            Result.IsOpen = false;
            return true;
        }
        catch (Exception ex)
        {
            ShowError($"模型配置未能保存。{ex.Message}");
            return false;
        }
    }

    private static string? Empty(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>只拦明显写错的地址；留空表示沿用上一组配置。</summary>
    private static bool IsWebAddress(string? value) =>
        string.IsNullOrWhiteSpace(value)
        || (Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps));

    private void ShowError(string message)
    {
        Result.Severity = InfoBarSeverity.Error;
        Result.Message = message;
        Result.IsOpen = true;
    }

    private static int ProviderIndex(string value) => value switch
    {
        "openai" => 1,
        "dashscope" => 2,
        _ => 0,
    };

    private static int EditProviderIndex(string value) => value switch
    {
        "filledit" or "fluxfill" or "flux-fill" => 1,
        "openai" => 2,
        _ => 0,
    };

    private static ImageSource? IconSource(string fileName)
    {
        try
        {
            // 优先同名 png；非 MSIX 不能用 ms-appx:///，统一 file:///
            var pngPath = System.IO.Path.Combine(
                AppContext.BaseDirectory, System.IO.Path.ChangeExtension(fileName, ".png"));
            var path = System.IO.File.Exists(pngPath)
                ? pngPath
                : System.IO.Path.Combine(AppContext.BaseDirectory, fileName);
            if (!System.IO.File.Exists(path)) return null;
            return new BitmapImage(new Uri($"file:///{path.Replace('\\', '/')}"));
        }
        catch { return null; }
    }
}
