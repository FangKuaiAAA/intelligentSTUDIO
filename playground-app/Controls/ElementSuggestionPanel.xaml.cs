using System;
using System.Collections.Generic;
using System.Linq;
using ImagePlayground.Models;
using ImagePlayground.Services;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.UI;

namespace ImagePlayground.Controls;

/// <summary>
/// 元素建议区：5 页、每页两行（6 列，表情页 4 列），左右圆形按钮翻页并带方向位移淡入。
/// 交互刻意保持安静：悬停不放大，按下立即变暗；已加入的元素常驻半透明表示不可重复添加。
/// </summary>
public sealed partial class ElementSuggestionPanel : UserControl
{
    private sealed record Tile(PlaygroundElement Element, Border Icon);

    private readonly List<Border> _pips = new();
    private readonly List<Tile> _tiles = new();
    private readonly HashSet<string> _selected = new();
    private int _index;
    private bool _built;

    public ElementSuggestionPanel()
    {
        InitializeComponent();
        Loaded += (_, _) =>
        {
            if (_built) return;
            _built = true;
            BuildPager();
            BuildPage(0, 0);
        };
    }

    public event EventHandler<PlaygroundElement>? ElementSelected;

    private IReadOnlyList<ElementPage> Pages => ElementCatalog.Pages;

    /// <summary>由页面同步当前已选元素，用于把已添加的项压暗。</summary>
    public void SetSelected(IEnumerable<string> elementIds)
    {
        _selected.Clear();
        foreach (var id in elementIds) _selected.Add(id);

        foreach (var tile in _tiles)
            SetIconOpacity(tile, pressed: false, animate: true);
    }

    private void Prev_Click(object sender, RoutedEventArgs e) => ChangePage(-1);

    private void Next_Click(object sender, RoutedEventArgs e) => ChangePage(1);

    private void ChangePage(int delta)
    {
        if (Pages.Count == 0) return;
        var target = Math.Clamp(_index + delta, 0, Pages.Count - 1);
        if (target == _index) return;
        _index = target;
        BuildPage(_index, delta);
    }

    private void BuildPager()
    {
        Pager.Children.Clear();
        _pips.Clear();
        for (var i = 0; i < Pages.Count; i++)
        {
            var index = i;
            var pip = new Border
            {
                Height = 6,
                Width = 6,
                CornerRadius = new CornerRadius(3),
                Background = new SolidColorBrush(Colors.White),
                Opacity = 0.22,
            };
            pip.Tapped += (_, e) =>
            {
                e.Handled = true;
                if (index == _index) return;
                var direction = index > _index ? 1 : -1;
                _index = index;
                BuildPage(_index, direction);
            };
            _pips.Add(pip);
            Pager.Children.Add(pip);
        }
    }

    private void BuildPage(int pageIndex, int direction)
    {
        TileHost.Children.Clear();
        TileHost.ColumnDefinitions.Clear();
        TileHost.RowDefinitions.Clear();
        _tiles.Clear();

        if (Pages.Count == 0)
        {
            TileHost.Children.Add(new TextBlock
            {
                Text = "元素资源缺失",
                FontSize = 12,
                Foreground = new SolidColorBrush(Color.FromArgb(255, 0xB4, 0xB4, 0xBB)),
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 20, 0, 20),
            });
            return;
        }

        var page = Pages[Math.Clamp(pageIndex, 0, Pages.Count - 1)];
        var items = page.Items;
        var perRow = Math.Max(1, (int)Math.Ceiling(items.Count / 2.0));

        for (var i = 0; i < perRow; i++)
            TileHost.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        TileHost.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        TileHost.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        for (var i = 0; i < items.Count; i++)
        {
            var element = items[i];
            var tile = CreateTile(element);
            Grid.SetRow(tile, i / perRow);
            Grid.SetColumn(tile, i % perRow);
            TileHost.Children.Add(tile);
        }

        UpdatePager(pageIndex);
        UpdateArrows();
        PlayPageTransition(direction);
    }

    private FrameworkElement CreateTile(PlaygroundElement element)
    {
        var panel = new StackPanel
        {
            Spacing = 7,
            HorizontalAlignment = HorizontalAlignment.Center,
        };

        var icon = new Border
        {
            Width = 60,
            Height = 60,
            CornerRadius = new CornerRadius(30),
            BorderThickness = new Thickness(1),
            BorderBrush = new SolidColorBrush(Color.FromArgb(30, 255, 255, 255)),
            Background = new ImageBrush
            {
                ImageSource = ElementImages.Get(element),
                Stretch = Stretch.UniformToFill,
            },
        };

        var label = new TextBlock
        {
            Text = element.Name,
            FontSize = 11.5,
            MaxWidth = 88,
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextAlignment = TextAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center,
            Foreground = new SolidColorBrush(Color.FromArgb(255, 0xB4, 0xB4, 0xBB)),
        };

        panel.Children.Add(icon);
        panel.Children.Add(label);

        var button = new Button
        {
            Style = (Style)Application.Current.Resources["BareButtonStyle"],
            Content = panel,
            Tag = element,
            VerticalAlignment = VerticalAlignment.Center,
        };
        button.Click += (_, _) =>
        {
            if (_selected.Contains(element.Id)) return;
            ElementSelected?.Invoke(this, element);
        };

        var tile = new Tile(element, icon);
        _tiles.Add(tile);
        SetIconOpacity(tile, pressed: false, animate: false);

        // 按下即反馈，不做放大
        icon.PointerPressed += (_, _) => SetIconOpacity(tile, pressed: true, animate: false);
        icon.PointerReleased += (_, _) => SetIconOpacity(tile, pressed: false, animate: true);
        icon.PointerCaptureLost += (_, _) => SetIconOpacity(tile, pressed: false, animate: true);
        icon.PointerExited += (_, _) => SetIconOpacity(tile, pressed: false, animate: true);

        return button;
    }

    private void SetIconOpacity(Tile tile, bool pressed, bool animate)
    {
        var rest = _selected.Contains(tile.Element.Id) ? 0.4 : 1.0;
        var target = pressed ? rest * 0.68 : rest;

        if (!animate)
        {
            tile.Icon.Opacity = target;
            return;
        }

        var story = new Storyboard();
        var fade = new DoubleAnimation
        {
            To = target,
            Duration = TimeSpan.FromMilliseconds(110),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(fade, tile.Icon);
        Storyboard.SetTargetProperty(fade, "Opacity");
        story.Children.Add(fade);
        story.Begin();
    }

    private void PlayPageTransition(int direction)
    {
        if (direction == 0)
        {
            PageShift.X = 0;
            TileHost.Opacity = 1;
            return;
        }

        PageShift.X = direction * 26;
        TileHost.Opacity = 0;

        var story = new Storyboard();
        var slide = new DoubleAnimation
        {
            To = 0,
            Duration = TimeSpan.FromMilliseconds(280),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(slide, PageShift);
        Storyboard.SetTargetProperty(slide, "X");

        var fade = new DoubleAnimation
        {
            To = 1,
            Duration = TimeSpan.FromMilliseconds(240),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(fade, TileHost);
        Storyboard.SetTargetProperty(fade, "Opacity");

        story.Children.Add(slide);
        story.Children.Add(fade);
        story.Begin();
    }

    private void UpdatePager(int pageIndex)
    {
        for (var i = 0; i < _pips.Count; i++)
        {
            var active = i == pageIndex;
            _pips[i].Width = active ? 16 : 6;
            _pips[i].Opacity = active ? 0.92 : 0.22;
        }
    }

    private void UpdateArrows()
    {
        PrevButton.IsEnabled = _index > 0;
        NextButton.IsEnabled = _index < Pages.Count - 1;
    }
}
