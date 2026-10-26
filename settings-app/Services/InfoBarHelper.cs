using Microsoft.UI.Xaml.Controls;

namespace DonySettings.Services;

/// <summary>就地提示：统一各设置页的结果反馈（InfoBar）。</summary>
public static class InfoBarHelper
{
    public static void Show(InfoBar bar, InfoBarSeverity severity, string message)
    {
        bar.Severity = severity;
        bar.Message = message;
        bar.IsOpen = true;
    }
}
