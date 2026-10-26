using System;
using System.Threading.Tasks;
using IntelligentStudio.Onboarding.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.UI.ViewManagement;

namespace IntelligentStudio.Onboarding.Views;

/// <summary>第 11 页：欢迎文字从下方飞入，末尾减速后静止；「完成」由窗口统一处理。</summary>
public sealed partial class WelcomeStepPage : UserControl, IStepView
{
    private readonly UISettings _uiSettings = new();
    private bool _played;

    public WelcomeStepPage(OnboardingStep step)
    {
        InitializeComponent();
        TitleText.Text = step.Title;
        DescText.Text = step.Description;
        HeroIcon.Source = IconSource(step.IconFile);
        Loaded += WelcomeStepPage_Loaded;
    }

    public void Reload() { }

    public void PlayMedia() { }

    public void StopMedia() { }

    public Task<bool> CommitAsync() => Task.FromResult(true);

    private void WelcomeStepPage_Loaded(object sender, RoutedEventArgs e)
    {
        if (_played) return;
        _played = true;

        if (!AnimationsEnabled())
        {
            HeroIcon.Opacity = 1;
            TitleText.Opacity = 1;
            DescText.Opacity = 1;
            return;
        }

        Animate(HeroIcon, 0, 200, 60);
        Animate(TitleText, 26, 340, 0);
        Animate(DescText, 14, 280, 120);
    }

    private static void Animate(UIElement element, double offsetY, int milliseconds, int delay)
    {
        var transform = new TranslateTransform { Y = offsetY };
        element.RenderTransform = transform;

        var ease = new ExponentialEase { EasingMode = EasingMode.EaseOut, Exponent = 6 };

        var storyboard = new Storyboard();

        var fade = new DoubleAnimation
        {
            From = 0,
            To = 1,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            BeginTime = TimeSpan.FromMilliseconds(delay),
            EasingFunction = ease,
        };
        Storyboard.SetTarget(fade, element);
        Storyboard.SetTargetProperty(fade, "Opacity");

        var slide = new DoubleAnimation
        {
            From = offsetY,
            To = 0,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            BeginTime = TimeSpan.FromMilliseconds(delay),
            EasingFunction = ease,
        };
        Storyboard.SetTarget(slide, transform);
        Storyboard.SetTargetProperty(slide, "Y");

        storyboard.Children.Add(fade);
        storyboard.Children.Add(slide);
        storyboard.Begin();
    }

    private bool AnimationsEnabled()
    {
        try { return _uiSettings.AnimationsEnabled; }
        catch { return true; }
    }

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
