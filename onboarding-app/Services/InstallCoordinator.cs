using DonySettings.Services;
using Microsoft.UI.Xaml.Controls;

namespace IntelligentStudio.Onboarding.Services;

/// <summary>
/// 包一层 <see cref="ExtensionInstallService"/>：把脚本返回的状态翻成一句可执行的话。
/// 措辞与 STUDIO 设置「通用」页保持一致，避免同一件事在两种说法之间跳。
/// </summary>
public static class InstallCoordinator
{
    public static Task<InstallOutcome> RunAsync(InstallTarget target) => target switch
    {
        InstallTarget.Edge => ExtensionInstallService.ReinstallEdgeExtensionAsync(),
        InstallTarget.Office => ExtensionInstallService.ReinstallOfficeAddInAsync(),
        _ => Task.FromResult(new InstallOutcome(InstallResult.NotReady, "没有需要安装的内容。")),
    };

    /// <summary>文案统一由 InstallPresenter 提供，向导与设置页共用同一套措辞。</summary>
    public static (InfoBarSeverity Severity, string Message) Describe(InstallTarget target, InstallOutcome outcome)
        => InstallPresenter.Describe(target == InstallTarget.Edge, outcome);
}
