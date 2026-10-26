using System.Threading.Tasks;
using DonySettings.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DonySettings.Views;

public sealed partial class HomePage : Page
{
    private bool _loading;

    public HomePage()
    {
        InitializeComponent();
    }

    public async Task ReloadAsync()
    {
        _loading = true;
        var s = SettingsStore.Instance;
        SummaryToggle.IsOn = s.GetBool("NOTIFY_SUMMARY_ENABLED");
        DndToggle.IsOn = s.GetBool("SMART_DND_ENABLED");
        _loading = false;
        await Task.CompletedTask;
    }

    private void Summary_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var s = SettingsStore.Instance;
        s.Set("NOTIFY_SUMMARY_ENABLED", SummaryToggle.IsOn);
        s.Save();
        _ = s.NotifyBackendAsync();
    }

    private void Dnd_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var s = SettingsStore.Instance;
        s.Set("SMART_DND_ENABLED", DndToggle.IsOn);
        s.Save();
        _ = s.NotifyBackendAsync();
    }
}
