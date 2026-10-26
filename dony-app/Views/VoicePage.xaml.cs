using System;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Storage.Streams;

namespace Dony.Views;

public sealed partial class VoicePage : Page
{
    private DonySettings? _settings;
    private bool _loading;
    private MediaPlayer? _player;

    public VoicePage()
    {
        InitializeComponent();
        Unloaded += (_, _) => StopPreview();
    }

    public async Task ReloadAsync()
    {
        _loading = true;
        try
        {
            _settings = await MainWindow.Api.GetSettingsAsync();
            if (_settings is null) return;
            TtsToggle.IsOn = _settings.TtsAlways;
            VoiceOnlyToggle.IsOn = _settings.TtsVoiceOnly;
            ApplyTtsMode();
            VoiceCombo.ItemsSource = _settings.Voices;
            var current = _settings.Voices.FirstOrDefault(v => v.Id == _settings.TtsVoice);
            if (current is not null)
                VoiceCombo.SelectedItem = current;
            else if (_settings.Voices.Count > 0)
                VoiceCombo.SelectedIndex = 0;
            SetVoiceTip(_settings.TtsVoice);
        }
        catch (Exception ex)
        {
            ShowResult(InfoBarSeverity.Error, "无法读取语音设置", "请确认 Dony 正在运行，然后重试。");
            Debug.WriteLine($"[voice] 读取失败：{ex}");
        }
        finally
        {
            _loading = false;
        }
    }

    private void Voice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loading) return;
        if (VoiceCombo.SelectedItem is VoiceOption v)
            SetVoiceTip(v.Id);
    }

    /// <summary>音色 ID 是排障用的细节，放在提示里而不是占一行文字。</summary>
    private void SetVoiceTip(string voiceId)
        => ToolTipService.SetToolTip(VoiceCombo, $"音色 ID：{voiceId}");

    /// <summary>「始终朗读回答」开启时，「仅在说话使用 Dony 时朗读回答」已无意义 → 置灰。</summary>
    private void ApplyTtsMode()
    {
        var always = TtsToggle.IsOn;
        VoiceOnlyToggle.IsEnabled = !always;
        VoiceOnlyLabel.Opacity = always ? 0.5 : 1;
    }

    private void Tts_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        ApplyTtsMode();
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        Busy.IsActive = true;
        SaveButton.IsEnabled = false;
        try
        {
            var voice = (VoiceCombo.SelectedItem as VoiceOption)?.Id;
            var updated = await MainWindow.Api.UpdateSettingsAsync(new SettingsPatch
            {
                TtsAlways = TtsToggle.IsOn,
                TtsVoiceOnly = VoiceOnlyToggle.IsOn,
                TtsVoice = voice,
            });
            if (updated is not null)
            {
                TtsToggle.IsOn = updated.TtsAlways;
                VoiceOnlyToggle.IsOn = updated.TtsVoiceOnly;
                ApplyTtsMode();
                SetVoiceTip(updated.TtsVoice);
            }
            var name = (VoiceCombo.SelectedItem as VoiceOption)?.Name ?? "所选音色";
            var what = TtsToggle.IsOn ? $"每次回答都用「{name}」朗读（打字也一样）。"
                     : VoiceOnlyToggle.IsOn ? $"只在你对着 Dony 说话时用「{name}」朗读。"
                     : "Dony 不会朗读回答。";
            ShowResult(InfoBarSeverity.Success, "已保存", what);
        }
        catch (Exception ex)
        {
            ShowResult(InfoBarSeverity.Error, "没能保存", "请确认 Dony 正在运行，然后重试。");
            Debug.WriteLine($"[voice] 保存失败：{ex}");
        }
        finally
        {
            Busy.IsActive = false;
            SaveButton.IsEnabled = true;
        }
    }

    private async void Reload_Click(object sender, RoutedEventArgs e) => await ReloadAsync();

    // ---------- 试听朗读 ----------

    /// <summary>正在播放时按钮显示「停止」，再点一次即停止。</summary>
    private bool _previewing;

    private void StopPreview()
    {
        if (_player is not null)
        {
            _player.Pause();
            _player.Source = null;
            _player.Dispose();
            _player = null;
        }
        _previewing = false;
        PreviewIcon.Glyph = "\uE768";
        PreviewLabel.Text = "试听";
    }

    private async void Preview_Click(object sender, RoutedEventArgs e)
    {
        if (_previewing)
        {
            StopPreview();
            return;
        }
        var voice = (VoiceCombo.SelectedItem as VoiceOption)?.Id;
        if (string.IsNullOrEmpty(voice))
        {
            ShowResult(InfoBarSeverity.Warning, "需要先选择音色", "选择后才能试听。");
            return;
        }

        StopPreview();
        PreviewBusy.IsActive = true;
        PreviewButton.IsEnabled = false;
        try
        {
            // 固定测试句由后端提供（store.TTS_PREVIEW_TEXT），前端不再允许自定义
            var audio = await MainWindow.Api.PreviewTtsAsync(voice);
            if (audio.Length == 0)
            {
                ShowResult(InfoBarSeverity.Error, "没能试听", "这次没有拿到音频，请再试一次。");
                return;
            }

            var stream = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(stream.GetOutputStreamAt(0)))
            {
                writer.WriteBytes(audio);
                await writer.StoreAsync();
            }

            _player = new MediaPlayer { Source = MediaSource.CreateFromStream(stream, "audio/mpeg") };
            _player.MediaEnded += (_, _) => _ = DispatcherQueue.TryEnqueue(StopPreview);
            _player.Play();
            _previewing = true;
            PreviewIcon.Glyph = "\uE71A";     // 停止图标
            PreviewLabel.Text = "停止";        }
        catch (Exception ex)
        {
            ShowResult(InfoBarSeverity.Error, "无法试听这个音色", "请检查网络连接，然后重试。");
            Debug.WriteLine($"[voice] 试听失败：{ex}");
        }
        finally
        {
            PreviewBusy.IsActive = false;
            PreviewButton.IsEnabled = true;
        }
    }

    private void ShowResult(InfoBarSeverity severity, string title, string message)
    {
        Result.Severity = severity;
        Result.Title = title;
        Result.Message = message;
        Result.IsOpen = true;
    }
}
