using System;
using System.Threading.Tasks;
using ImagePlayground.Models;
using ImagePlayground.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;

namespace ImagePlayground.Controls;

/// <summary>
/// 已选元素条中的一项：圆形图标（预设元素）或药丸（自定义文字）。
/// 进场：0.55 → 1.07 → 1 的弹性放大 + 淡入；退场：缩到 0.72 并淡出后再从父级移除。
/// </summary>
public sealed partial class ElementChip : UserControl
{
    private bool _exiting;

    public ElementChip(ElementChipModel model)
    {
        InitializeComponent();
        Model = model;
        Apply();
        CloseButton.Click += OnCloseClick;
    }

    public ElementChipModel Model { get; }

    public event EventHandler? DismissRequested;

    private void Apply()
    {
        if (Model.IsElement)
        {
            var element = Model.Element!;
            var image = ElementImages.Get(element);
            if (image is not null)
            {
                CircleHost.Background = new ImageBrush
                {
                    ImageSource = image,
                    Stretch = Stretch.UniformToFill,
                };
            }
            ToolTipService.SetToolTip(Root, element.Name);
        }
        else
        {
            CircleHost.Visibility = Visibility.Collapsed;
            PillHost.Visibility = Visibility.Visible;
            Label.Text = Model.Text;
            ToolTipService.SetToolTip(Root, Model.Text);
        }
    }

    private void OnCloseClick(object sender, RoutedEventArgs e)
    {
        if (_exiting) return;
        DismissRequested?.Invoke(this, EventArgs.Empty);
    }

    public void PlayEnter()
    {
        var story = new Storyboard();

        var scaleX = new DoubleAnimationUsingKeyFrames();
        scaleX.KeyFrames.Add(new EasingDoubleKeyFrame
        {
            KeyTime = KeyTime.FromTimeSpan(TimeSpan.Zero),
            Value = 0.55,
        });
        scaleX.KeyFrames.Add(new EasingDoubleKeyFrame
        {
            KeyTime = KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(250)),
            Value = 1.07,
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        });
        scaleX.KeyFrames.Add(new EasingDoubleKeyFrame
        {
            KeyTime = KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(390)),
            Value = 1.0,
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        });
        Storyboard.SetTarget(scaleX, ChipScale);
        Storyboard.SetTargetProperty(scaleX, "ScaleX");

        var scaleY = new DoubleAnimationUsingKeyFrames();
        scaleY.KeyFrames.Add(new EasingDoubleKeyFrame
        {
            KeyTime = KeyTime.FromTimeSpan(TimeSpan.Zero),
            Value = 0.55,
        });
        scaleY.KeyFrames.Add(new EasingDoubleKeyFrame
        {
            KeyTime = KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(250)),
            Value = 1.07,
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        });
        scaleY.KeyFrames.Add(new EasingDoubleKeyFrame
        {
            KeyTime = KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(390)),
            Value = 1.0,
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        });
        Storyboard.SetTarget(scaleY, ChipScale);
        Storyboard.SetTargetProperty(scaleY, "ScaleY");

        var fade = new DoubleAnimation
        {
            From = 0,
            To = 1,
            Duration = TimeSpan.FromMilliseconds(180),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(fade, Root);
        Storyboard.SetTargetProperty(fade, "Opacity");

        story.Children.Add(scaleX);
        story.Children.Add(scaleY);
        story.Children.Add(fade);
        story.Begin();
    }

    /// <summary>退场动画结束后回调，由父级把控件从面板移除。</summary>
    public Task PlayExitAsync()
    {
        _exiting = true;
        var completion = new TaskCompletionSource<bool>();
        var story = new Storyboard();

        var scaleX = new DoubleAnimation
        {
            To = 0.72,
            Duration = TimeSpan.FromMilliseconds(170),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn },
        };
        Storyboard.SetTarget(scaleX, ChipScale);
        Storyboard.SetTargetProperty(scaleX, "ScaleX");

        var scaleY = new DoubleAnimation
        {
            To = 0.72,
            Duration = TimeSpan.FromMilliseconds(170),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn },
        };
        Storyboard.SetTarget(scaleY, ChipScale);
        Storyboard.SetTargetProperty(scaleY, "ScaleY");

        var fade = new DoubleAnimation
        {
            To = 0,
            Duration = TimeSpan.FromMilliseconds(150),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn },
        };
        Storyboard.SetTarget(fade, Root);
        Storyboard.SetTargetProperty(fade, "Opacity");

        story.Children.Add(scaleX);
        story.Children.Add(scaleY);
        story.Children.Add(fade);
        story.Completed += (_, _) => completion.TrySetResult(true);
        story.Begin();
        return completion.Task;
    }
}
