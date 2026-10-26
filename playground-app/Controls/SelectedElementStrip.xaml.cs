using System;
using System.Collections.Generic;
using System.Linq;
using ImagePlayground.Models;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Animation;

namespace ImagePlayground.Controls;

/// <summary>
/// 顶部「已选元素」横条：按添加顺序从左向右排列，新项弹入并自动滚到可见位置，
/// 删除时先播完缩小动画再从面板移除。
/// </summary>
public sealed partial class SelectedElementStrip : UserControl
{
    private readonly List<ElementChipModel> _models = new();

    public SelectedElementStrip()
    {
        InitializeComponent();
    }

    public IReadOnlyList<ElementChipModel> Models => _models;

    public bool IsEmpty => _models.Count == 0;

    /// <summary>集合发生变化（添加或删除）后触发，供页面同步生成按钮状态。</summary>
    public event EventHandler? Changed;

    public void Add(ElementChipModel model)
    {
        var chip = new ElementChip(model);
        chip.DismissRequested += async (_, _) => await RemoveAsync(chip);

        _models.Add(model);
        Items.Children.Add(chip);
        chip.PlayEnter();
        UpdatePlaceholder();
        Changed?.Invoke(this, EventArgs.Empty);

        // 等布局完成后再滚到最右侧，避免使用旧的 ScrollableWidth
        DispatcherQueue.TryEnqueue(() =>
        {
            Scroller.UpdateLayout();
            Scroller.ChangeView(Scroller.ScrollableWidth, null, null, disableAnimation: false);
        });
    }

    public async System.Threading.Tasks.Task RemoveAsync(ElementChip chip)
    {
        if (!_models.Remove(chip.Model)) return;
        Changed?.Invoke(this, EventArgs.Empty);

        await chip.PlayExitAsync();
        Items.Children.Remove(chip);
        UpdatePlaceholder();
    }

    public void Clear()
    {
        _models.Clear();
        Items.Children.Clear();
        UpdatePlaceholder();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>同一预设元素只允许出现一次（文字元素不受限）。</summary>
    public bool ContainsElement(string elementId) =>
        _models.Any(m => m.IsElement && m.Element!.Id == elementId);

    public IEnumerable<string> SelectedElementIds =>
        _models.Where(m => m.IsElement).Select(m => m.Element!.Id);

    public IEnumerable<string> ElementNames =>
        _models.Where(m => m.IsElement).Select(m => m.Element!.Name);

    public IEnumerable<string> Texts =>
        _models.Where(m => !m.IsElement).Select(m => m.Text);

    public IEnumerable<PlaygroundElement> Elements =>
        _models.Where(m => m.IsElement).Select(m => m.Element!);

    private void UpdatePlaceholder()
    {
        var target = _models.Count == 0 ? 1.0 : 0.0;
        if (Math.Abs(Placeholder.Opacity - target) < 0.01) return;

        var story = new Storyboard();
        var fade = new DoubleAnimation
        {
            To = target,
            Duration = TimeSpan.FromMilliseconds(200),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(fade, Placeholder);
        Storyboard.SetTargetProperty(fade, "Opacity");
        story.Children.Add(fade);
        story.Begin();
    }
}
