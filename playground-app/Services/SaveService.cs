using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using ImagePlayground.Models;
using Microsoft.UI.Xaml;
using Windows.Storage.Pickers;

namespace ImagePlayground.Services;

/// <summary>另存到磁盘：使用系统文件保存对话框（解包应用需要先绑定窗口句柄）。</summary>
public static class SaveService
{
    public static async Task<bool> SaveCopyAsync(Window window, string sourcePath, string suggestedName)
    {
        if (!File.Exists(sourcePath)) return false;

        var picker = new FileSavePicker
        {
            SuggestedStartLocation = PickerLocationId.PicturesLibrary,
            SuggestedFileName = Sanitize(suggestedName),
        };
        picker.FileTypeChoices.Add("PNG 图片", new List<string> { ".png" });

        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);

        var file = await picker.PickSaveFileAsync();
        if (file is null) return false;

        try
        {
            File.Copy(sourcePath, file.Path, overwrite: true);
            AppLog.Info("另存为", Path.GetFileName(file.Path));
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Write("另存为失败", ex.GetType().Name);
            throw new ImageGenerationException("无法写入目标位置，请换一个文件夹重试。", 0, ex);
        }
    }

    /// <summary>去掉文件名里的非法字符；中文保留。</summary>
    private static string Sanitize(string name)
    {
        var value = string.IsNullOrWhiteSpace(name) ? "图乐园作品" : name.Trim();
        foreach (var c in Path.GetInvalidFileNameChars())
            value = value.Replace(c, ' ');
        return value.Length > 60 ? value[..60] : value;
    }
}
