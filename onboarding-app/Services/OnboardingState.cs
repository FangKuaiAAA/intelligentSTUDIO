using DonySettings.Services;

namespace IntelligentStudio.Onboarding.Services;

/// <summary>引导是否走完：写入 .appx_config.json，供安装器或主程序判断是否再次拉起引导。</summary>
public static class OnboardingState
{
    private const string CompletedKey = "ONBOARDING_COMPLETED";

    public static bool IsCompleted => SettingsStore.Instance.GetBool(CompletedKey);

    public static void MarkCompleted()
    {
        var store = SettingsStore.Instance;
        store.Set(CompletedKey, true);
        store.Save();
    }
}
