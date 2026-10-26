using System.Threading.Tasks;
using DonySettings.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DonySettings.Views;

public sealed partial class WritingAssistPage : Page
{
    private bool _loading;

    public WritingAssistPage()
    {
        InitializeComponent();
    }

    public async Task ReloadAsync()
    {
        _loading = true;
        DoubleCtrlToggle.IsOn = SettingsStore.Instance.GetBool("WRITING_DOUBLE_CTRL", true);
        _loading = false;
        await Task.CompletedTask;
    }

    private void DoubleCtrl_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        var s = SettingsStore.Instance;
        s.Set("WRITING_DOUBLE_CTRL", DoubleCtrlToggle.IsOn);
        s.Save();
    }
}
