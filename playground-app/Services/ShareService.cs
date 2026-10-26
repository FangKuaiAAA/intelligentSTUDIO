using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using ImagePlayground.Interop;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Streams;

namespace ImagePlayground.Services;

/// <summary>
/// 分享：优先调用系统共享面板（解包应用需用 IDataTransferManagerInterop 绑定窗口句柄）；
/// 不可用时回退到「复制图片 / 在文件资源管理器中显示」，保证任何系统版本都有可用出口。
/// </summary>
public static class ShareService
{
    private static string? _pendingFile;

    // 防止 DataTransferManager 被 GC 回收（事件订阅持有它）
    private static DataTransferManager? _dtm;

    public static void ShowMenu(Window window, FrameworkElement anchor, string filePath, string title)
    {
        var menu = new MenuFlyout();

        var shareItem = new MenuFlyoutItem { Text = "系统共享面板", Icon = new FontIcon { Glyph = "\uE72D" } };
        shareItem.Click += async (_, _) =>
        {
            var shown = await TryShowSystemShareAsync(window, filePath);
            if (!shown)
            {
                var copied = await CopyImageAsync(filePath);
                ShowToast(anchor, copied ? "系统共享不可用，已复制图片" : "系统共享不可用");
            }
        };

        var copyItem = new MenuFlyoutItem { Text = "复制图片", Icon = new FontIcon { Glyph = "\uE8C8" } };
        copyItem.Click += async (_, _) =>
        {
            var ok = await CopyImageAsync(filePath);
            ShowToast(anchor, ok ? "已复制图片" : "复制失败");
        };

        var revealItem = new MenuFlyoutItem
        {
            Text = "在文件资源管理器中显示",
            Icon = new FontIcon { Glyph = "\uE838" },
        };
        revealItem.Click += (_, _) => RevealInExplorer(filePath);

        menu.Items.Add(shareItem);
        menu.Items.Add(copyItem);
        menu.Items.Add(revealItem);
        _ = title;
        menu.ShowAt(anchor);
    }

    private static Task<bool> TryShowSystemShareAsync(Window window, string filePath)
    {
        try
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            var dtm = ShareInterop.GetForWindow(hwnd);
            if (dtm is null) return Task.FromResult(false);

            _dtm = dtm;
            _pendingFile = filePath;
            dtm.DataRequested -= OnDataRequested;
            dtm.DataRequested += OnDataRequested;

            return Task.FromResult(ShareInterop.TryShowShareUI());
        }
        catch (Exception ex)
        {
            AppLog.Write("系统分享失败", ex.GetType().Name);
            return Task.FromResult(false);
        }
    }

    private static async void OnDataRequested(DataTransferManager sender, DataRequestedEventArgs args)
    {
        var deferral = args.Request.GetDeferral();
        try
        {
            var data = args.Request.Data;
            data.Properties.Title = "图乐园作品";
            data.Properties.Description = "由 intelligentSTUDIO 图乐园生成";
            if (_pendingFile is not null && File.Exists(_pendingFile))
            {
                var file = await StorageFile.GetFileFromPathAsync(_pendingFile);
                data.SetStorageItems(new List<IStorageItem> { file });
            }
        }
        catch (Exception ex)
        {
            AppLog.Write("分享数据准备失败", ex.GetType().Name);
        }
        finally { deferral.Complete(); }
    }

    public static async Task<bool> CopyImageAsync(string filePath)
    {
        try
        {
            if (!File.Exists(filePath)) return false;
            var bytes = await File.ReadAllBytesAsync(filePath);

            var stream = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(stream.GetOutputStreamAt(0)))
            {
                writer.WriteBytes(bytes);
                await writer.StoreAsync();
                await writer.FlushAsync();
            }
            stream.Seek(0);

            var package = new DataPackage { RequestedOperation = DataPackageOperation.Copy };
            package.SetBitmap(RandomAccessStreamReference.CreateFromStream(stream));
            Clipboard.SetContent(package);
            Clipboard.Flush();
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Write("复制图片失败", ex.GetType().Name);
            return false;
        }
    }

    public static void RevealInExplorer(string filePath)
    {
        try
        {
            if (!File.Exists(filePath)) return;
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{filePath}\"")
            {
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            AppLog.Write("打开资源管理器失败", ex.GetType().Name);
        }
    }

    /// <summary>轻量反馈：在锚点上方弹一条短提示。</summary>
    private static void ShowToast(FrameworkElement anchor, string message)
    {
        try
        {
            var flyout = new Flyout
            {
                Placement = FlyoutPlacementMode.Top,
                Content = new TextBlock { Text = message, FontSize = 12 },
            };
            flyout.ShowAt(anchor);

            var timer = anchor.DispatcherQueue.CreateTimer();
            timer.Interval = TimeSpan.FromMilliseconds(1600);
            timer.Tick += (_, _) =>
            {
                timer.Stop();
                flyout.Hide();
            };
            timer.Start();
        }
        catch { /* 提示失败忽略 */ }
    }
}
