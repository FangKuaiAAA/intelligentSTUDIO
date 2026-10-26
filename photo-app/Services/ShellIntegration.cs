using System;
using System.IO;
using Microsoft.Win32;

namespace PhotoEditor.Services;

/// <summary>
/// 资源管理器右键菜单：只写 HKCU 下的 SystemFileAssociations，可随时撤销。
/// 菜单文字与命令都由当前 exe 路径生成，移动安装位置后需要重新注册。
/// </summary>
public static class ShellIntegration
{
    private const string MenuKey = "IntelligentStudioPhotoEditor";
    private const string MenuText = "通过照片编辑器打开";

    private static readonly string[] Extensions = { ".jpg", ".jpeg", ".png", ".bmp", ".webp", ".heic" };

    public static bool IsRegistered
    {
        get
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(CommandPath(Extensions[0]));
                return key is not null;
            }
            catch
            {
                return false;
            }
        }
    }

    public static bool Register()
    {
        try
        {
            var exe = Path.Combine(AppContext.BaseDirectory, "PhotoEditor.exe");
            if (!File.Exists(exe)) return false;

            foreach (var extension in Extensions)
            {
                using var key = Registry.CurrentUser.CreateSubKey(CommandPath(extension));
                if (key is null) continue;

                key.SetValue(null, MenuText);
                key.SetValue("Icon", $"\"{exe}\"");
                using var command = key.CreateSubKey("command");
                command?.SetValue(null, $"\"{exe}\" \"%1\"");
            }

            AppLog.Info("注册右键菜单");
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Write("注册右键菜单失败", ex.GetType().Name);
            return false;
        }
    }

    public static void Unregister()
    {
        try
        {
            foreach (var extension in Extensions)
            {
                var path = $@"Software\Classes\SystemFileAssociations\{extension}\shell\{MenuKey}";
                Registry.CurrentUser.DeleteSubKeyTree(path, throwOnMissingSubKey: false);
            }
            AppLog.Info("移除右键菜单");
        }
        catch (Exception ex)
        {
            AppLog.Write("移除右键菜单失败", ex.GetType().Name);
        }
    }

    private static string CommandPath(string extension) =>
        $@"Software\Classes\SystemFileAssociations\{extension}\shell\{MenuKey}";
}
