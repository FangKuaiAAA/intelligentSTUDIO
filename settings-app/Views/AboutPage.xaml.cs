using System.Threading.Tasks;
using Microsoft.UI.Xaml.Controls;

namespace DonySettings.Views;

public sealed partial class AboutPage : Page
{
    public AboutPage()
    {
        InitializeComponent();
    }

    public async Task ReloadAsync()
    {
        await Task.CompletedTask;
    }
}
