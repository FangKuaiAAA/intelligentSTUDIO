using System;
using System.IO;
using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Media.Core;
using Windows.Media.Playback;

namespace IntelligentStudio.Onboarding.Controls;

/// <summary>
/// 引导页的媒体区。两种形态：框内（圆角卡片、四周留白）与无框（上、左、右贴住窗口边缘）。
/// 素材放在 assets\onboarding 下按约定文件名提供；文件缺失时显示占位层，不做空白，也不抛异常。
/// 视频进入页面自动静音播放，播完停在最后一帧；离开页面立刻释放播放器，避免多路解码。
/// </summary>
public sealed partial class OnboardingMedia : UserControl
{
    private const double FramedRadius = 14;

    private readonly Brush? _surfaceBrush;
    private MediaPlayer? _player;
    private CompositionRoundedRectangleGeometry? _roundedGeometry;
    private bool _isFramed;
    private bool _isVideo;
    private string? _fileName;

    public OnboardingMedia()
    {
        InitializeComponent();
        _surfaceBrush = SurfaceFill.Fill;
        MediaRoot.SizeChanged += (_, _) => UpdateClip();
        Unloaded += (_, _) => Stop();
    }

    /// <summary>按页面描述布置媒体；此时只决定「显示素材还是占位」，播放交给 <see cref="Play"/>。</summary>
    public void Configure(bool isFramed, bool isVideo, string fileName)
    {
        _isFramed = isFramed;
        _isVideo = isVideo;
        _fileName = fileName;

        var radius = isFramed ? FramedRadius : 0;
        SurfaceFill.RadiusX = radius;
        SurfaceFill.RadiusY = radius;
        FrameOutline.CornerRadius = new CornerRadius(radius);
        FrameOutline.BorderThickness = new Thickness(isFramed ? 1 : 0);

        var path = ResolvePath(fileName);
        var exists = path is not null && File.Exists(path);

        Player.Visibility = Visibility.Collapsed;
        SurfaceFill.Fill = _surfaceBrush;

        if (!exists)
        {
            SurfaceFill.Fill = (Brush)Application.Current.Resources["PlaceholderWashBrush"];
            ShowPlaceholder(true, fileName);
        }
        else if (isVideo)
        {
            ShowPlaceholder(false, fileName);
        }
        else
        {
            SurfaceFill.Fill = new ImageBrush
            {
                ImageSource = new BitmapImage(new Uri($"ms-appx:///onboarding/{fileName}")),
                Stretch = Stretch.UniformToFill,
            };
            ShowPlaceholder(false, fileName);
        }

        UpdateClip();
    }

    /// <summary>进入页面时调用。视频从头播放；图片与占位层无需额外动作。</summary>
    public void Play()
    {
        if (!_isVideo) return;

        Stop();

        // 占位阶段没有可播放的文件，保留占位层，不做失败提示
        var path = _fileName is null ? null : ResolvePath(_fileName);
        if (path is null || !File.Exists(path)) return;

        try
        {
            var player = new MediaPlayer
            {
                Source = MediaSource.CreateFromUri(new Uri(path)),
                IsMuted = true,
                AutoPlay = false,
            };
            player.MediaEnded += OnMediaEnded;

            Player.SetMediaPlayer(player);
            Player.Visibility = Visibility.Visible;
            _player = player;
            player.Play();
        }
        catch
        {
            Stop();
        }
    }

    /// <summary>离开页面或控件卸载时调用：暂停并释放解码器。</summary>
    public void Stop()
    {
        var player = _player;
        _player = null;
        if (player is null) return;

        try
        {
            player.MediaEnded -= OnMediaEnded;
            player.Pause();
            player.Source = null;
            Player.SetMediaPlayer(null);
            player.Dispose();
        }
        catch { /* 释放失败不阻断导航 */ }

        Player.Visibility = Visibility.Collapsed;
    }

    private static string? ResolvePath(string fileName) =>
        Path.Combine(AppContext.BaseDirectory, "onboarding", fileName);

    private void ShowPlaceholder(bool show, string fileName)
    {
        Placeholder.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        if (!show) return;

        PlaceholderIcon.Glyph = _isVideo ? "\uE714" : "\uE91B";
        PlaceholderText.Text = (_isVideo ? "视频占位 · " : "图片占位 · ") + "assets/onboarding/" + fileName;
    }

    /// <summary>
    /// 框内视频走合成层渲染，圆角只能靠合成裁剪；图片与占位底色由 Rectangle 自绘圆角，无需裁剪。
    /// 无框页不裁，交给窗口自身圆角。
    /// </summary>
    private void UpdateClip()
    {
        try
        {
            var visual = ElementCompositionPreview.GetElementVisual(MediaRoot);

            if (!_isFramed || !_isVideo || MediaRoot.ActualWidth <= 0 || MediaRoot.ActualHeight <= 0)
            {
                visual.Clip = null;
                _roundedGeometry = null;
                return;
            }

            if (_roundedGeometry is null)
            {
                var compositor = visual.Compositor;
                _roundedGeometry = compositor.CreateRoundedRectangleGeometry();
                visual.Clip = compositor.CreateGeometricClip(_roundedGeometry);
            }

            _roundedGeometry.CornerRadius = new Vector2((float)FramedRadius, (float)FramedRadius);
            _roundedGeometry.Size = new Vector2((float)MediaRoot.ActualWidth, (float)MediaRoot.ActualHeight);
        }
        catch { /* 合成层不可用时退回矩形，不影响播放 */ }
    }

    /// <summary>部分编码在播完时会回跳到首帧，这里先落到末帧再暂停。</summary>
    private void OnMediaEnded(MediaPlayer sender, object args)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            try
            {
                var session = sender.PlaybackSession;
                var duration = session.NaturalDuration;
                if (duration > TimeSpan.FromMilliseconds(120))
                    session.Position = duration - TimeSpan.FromMilliseconds(40);
                sender.Pause();
            }
            catch { /* 忽略 */ }
        });
    }
}
