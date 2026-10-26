using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using PhotoEditor.Controls;
using PhotoEditor.Services;

namespace PhotoEditor.Views;

/// <summary>页面需要向主窗口索取的能力。窗口是唯一的编排者。</summary>
public interface IEditorHost
{
    EditSession Session { get; }

    EditSurface Surface { get; }

    /// <summary>画布容器：重构选项卡在这里嵌入 WebView2。</summary>
    Panel CanvasHost { get; }

    bool IsGenerating { get; }

    /// <summary>提交编辑后刷新画布。</summary>
    Task RefreshSurfaceAsync();

    /// <summary>
    /// 进入生成态：显示无百分比进度并锁定工具切换。
    /// bottom 为真时进度条浮在画布下方，不压暗照片。
    /// </summary>
    void BeginBusy(string text, bool bottom = false);

    void UpdateBusy(string text, double progress);

    void EndBusy();

    void ShowToast(string message, bool isError = false);
}

/// <summary>右侧面板。页面只提供面板内容，画布交互通过 <see cref="Activate"/> 拿到。</summary>
public interface IEditorPanel
{
    string Title { get; }

    string Subtitle { get; }

    FrameworkElement View { get; }

    void Activate(IEditorHost host);

    void Deactivate();
}
