using System;
using System.Linq;
using System.Numerics;
using System.Threading.Tasks;
using ImagePlayground.Models;
using ImagePlayground.Services;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;

namespace ImagePlayground.Views;

/// <summary>
/// 历史页：Pictures\图乐园\ 中的作品以自适应大图磁贴展示，点击放大查看并可共享/保存。
/// </summary>
public sealed partial class HistoryPage : UserControl
{
    private HistoryTile? _current;

    public HistoryPage()
    {
        InitializeComponent();
    }

    public async Task ReloadAsync()
    {
        try
        {
            var entries = await HistoryStore.Instance.LoadAsync();
            var tiles = entries.Select(e => new HistoryTile(e)).ToList();
            Tiles.ItemsSource = tiles;

            CountText.Text = tiles.Count == 0 ? "" : $"{tiles.Count} 件作品";

            EmptyState.Visibility = tiles.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            if (tiles.Count > 0) FadeInList();
        }
        catch (Exception ex)
        {
            AppLog.Write("历史读取失败", ex.GetType().Name);
            CountText.Text = "历史读取失败";
        }
    }

    private void FadeInList()
    {
        var story = new Storyboard();
        var anim = new DoubleAnimation
        {
            To = 1,
            Duration = TimeSpan.FromMilliseconds(240),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(anim, Tiles);
        Storyboard.SetTargetProperty(anim, "Opacity");
        story.Children.Add(anim);
        Tiles.Opacity = 0;
        story.Begin();
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await ReloadAsync();

    private void GoCreate_Click(object sender, RoutedEventArgs e) => MainWindow.Instance?.Navigate("new");

    private void Tile_Tapped(object sender, TappedRoutedEventArgs e)
    {
        if (sender is not FrameworkElement element || element.DataContext is not HistoryTile tile) return;
        OpenViewer(tile);
    }

    private void Tile_PointerEntered(object sender, PointerRoutedEventArgs e) =>
        ScaleTile(sender as FrameworkElement, 1.02f, 160);

    private void Tile_PointerExited(object sender, PointerRoutedEventArgs e) =>
        ScaleTile(sender as FrameworkElement, 1f, 200);

    /// <summary>悬停轻微放大。只动 Scale（不影响布局）；Offset 属于布局偏移，不能在这里动。</summary>
    private static void ScaleTile(FrameworkElement? element, float scale, double milliseconds)
    {
        if (element is null) return;
        try
        {
            var visual = ElementCompositionPreview.GetElementVisual(element);
            var comp = visual.Compositor;
            visual.CenterPoint = new Vector3((float)element.ActualWidth / 2f, (float)element.ActualHeight / 2f, 0f);

            var ease = comp.CreateCubicBezierEasingFunction(new Vector2(0.16f, 1f), new Vector2(0.3f, 1f));

            var scaleAnim = comp.CreateVector3KeyFrameAnimation();
            scaleAnim.InsertKeyFrame(1f, new Vector3(scale, scale, 1f), ease);
            scaleAnim.Duration = TimeSpan.FromMilliseconds(milliseconds);

            visual.StartAnimation("Scale", scaleAnim);
        }
        catch { /* 忽略 */ }
    }

    private void OpenViewer(HistoryTile tile)
    {
        _current = tile;

        try
        {
            ViewerImage.Source = new BitmapImage(new Uri(tile.ImagePath));
        }
        catch (Exception ex)
        {
            AppLog.Write("大图加载失败", ex.GetType().Name);
        }

        ViewerCaption.Text = $"{tile.StyleName} · {tile.CreatedText} · {tile.ElementsText}";
        ViewerLayer.Visibility = Visibility.Visible;
        ViewerImage.Opacity = 0;

        FadeLayer(1, 200);
        AnimateViewerScale(0.94, 1, 280);
        FadeViewerImage(1, 240);
    }

    private void ViewerClose_Click(object sender, RoutedEventArgs e) => CloseViewer();

    private void ViewerLayer_Tapped(object sender, TappedRoutedEventArgs e)
    {
        // 只有点在遮罩本身（而不是图片/按钮）时才关闭
        if (ReferenceEquals(e.OriginalSource, ViewerLayer)) CloseViewer();
    }

    private void OnEscape(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        if (ViewerLayer.Visibility != Visibility.Visible) return;
        CloseViewer();
        args.Handled = true;
    }

    private void CloseViewer()
    {
        if (ViewerLayer.Visibility != Visibility.Visible) return;
        AnimateViewerScale(0.96, 0.96, 180);
        FadeViewerImage(0, 160);
        FadeLayer(0, 180, () =>
        {
            ViewerLayer.Visibility = Visibility.Collapsed;
            ViewerImage.Source = null;
            _current = null;
        });
    }

    private void ViewerShare_Click(object sender, RoutedEventArgs e)
    {
        var window = MainWindow.Instance;
        if (_current is null || window is null) return;
        ShareService.ShowMenu(window, ViewerShareButton, _current.ImagePath, "图乐园作品");
    }

    private async void ViewerSave_Click(object sender, RoutedEventArgs e)
    {
        var window = MainWindow.Instance;
        if (_current is null || window is null) return;

        try
        {
            var name = $"图乐园_{_current.Entry.CreatedAt:yyyyMMdd_HHmm}";
            await SaveService.SaveCopyAsync(window, _current.ImagePath, name);
        }
        catch (ImageGenerationException ex)
        {
            CountText.Text = ex.Message;
        }
    }

    private async void TileDelete_Click(object sender, RoutedEventArgs e)
    {
        // Button 自身会吞掉点击，不会冒泡成磁贴的 Tapped
        if ((sender as FrameworkElement)?.DataContext is not HistoryTile tile) return;
        await DeleteTileAsync(tile);
    }

    private async void ViewerDelete_Click(object sender, RoutedEventArgs e)
    {
        if (_current is null) return;
        await DeleteTileAsync(_current);
    }

    /// <summary>删除前确认：作品删除后无法恢复。</summary>
    private async Task DeleteTileAsync(HistoryTile tile)
    {
        var dialog = new ContentDialog
        {
            Title = "删除作品",
            Content = "删除后无法恢复。",
            PrimaryButtonText = "删除",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = XamlRoot,
        };

        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;

        try
        {
            await HistoryStore.Instance.DeleteAsync(tile.Entry);

            if (ReferenceEquals(_current, tile)) CloseViewer();
            await ReloadAsync();
        }
        catch (Exception ex)
        {
            AppLog.Write("删除作品失败", ex.GetType().Name);

            var error = new ContentDialog
            {
                Title = "删除失败",
                Content = "图片可能正被其他程序占用，请稍后重试。",
                CloseButtonText = "好",
                XamlRoot = XamlRoot,
            };
            await error.ShowAsync();
        }
    }

    private void FadeLayer(double to, double milliseconds, Action? completed = null)
    {
        var story = new Storyboard();
        var anim = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(anim, ViewerLayer);
        Storyboard.SetTargetProperty(anim, "Opacity");
        story.Children.Add(anim);
        if (completed is not null) story.Completed += (_, _) => completed();
        story.Begin();
    }

    private void FadeViewerImage(double to, double milliseconds)
    {
        var story = new Storyboard();
        var anim = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(anim, ViewerImage);
        Storyboard.SetTargetProperty(anim, "Opacity");
        story.Children.Add(anim);
        story.Begin();
    }

    private void AnimateViewerScale(double from, double to, double milliseconds)
    {
        ViewerScale.ScaleX = from;
        ViewerScale.ScaleY = from;

        var story = new Storyboard();
        var sx = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(sx, ViewerScale);
        Storyboard.SetTargetProperty(sx, "ScaleX");

        var sy = new DoubleAnimation
        {
            To = to,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        Storyboard.SetTarget(sy, ViewerScale);
        Storyboard.SetTargetProperty(sy, "ScaleY");

        story.Children.Add(sx);
        story.Children.Add(sy);
        story.Begin();
    }
}
