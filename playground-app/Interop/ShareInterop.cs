using System;
using System.Runtime.InteropServices;
using Windows.ApplicationModel.DataTransfer;

namespace ImagePlayground.Interop;

/// <summary>
/// 解包（非 MSIX）WinUI3 应用不能用 DataTransferManager.GetForCurrentView()，
/// 必须通过 IDataTransferManagerInterop 绑定窗口句柄。这里用 RoGetActivationFactory
/// 取激活工厂，避免依赖投影中同名类型的签名差异；任何一步失败都由调用方回退到剪贴板。
/// </summary>
internal static class ShareInterop
{
    private static readonly Guid IID_DataTransferManager = new("A5CAEE9B-8708-49D1-8D36-67D25A8DA00C");

    [ComImport]
    [Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDataTransferManagerInterop
    {
        IntPtr GetForWindow([In] IntPtr appWindow, [In] ref Guid riid);
        void ShowShareUIForWindow([In] IntPtr appWindow);
    }

    private static IDataTransferManagerInterop? _interop;
    private static IntPtr _hwnd;

    public static DataTransferManager? GetForWindow(IntPtr hwnd)
    {
        try
        {
            var interop = EnsureInterop();
            if (interop is null) return null;

            _hwnd = hwnd;
            var iid = IID_DataTransferManager;
            var ptr = interop.GetForWindow(hwnd, ref iid);
            if (ptr == IntPtr.Zero) return null;

            return WinRT.MarshalInspectable<DataTransferManager>.FromAbi(ptr);
        }
        catch { return null; }
    }

    public static bool TryShowShareUI()
    {
        try
        {
            if (_hwnd == IntPtr.Zero) return false;
            EnsureInterop()?.ShowShareUIForWindow(_hwnd);
            return true;
        }
        catch { return false; }
    }

    private static IDataTransferManagerInterop? EnsureInterop()
    {
        if (_interop is not null) return _interop;

        const string classId = "Windows.ApplicationModel.DataTransfer.DataTransferManager";
        if (WindowsCreateString(classId, classId.Length, out var hstring) < 0) return null;

        try
        {
            var iid = typeof(IDataTransferManagerInterop).GUID;
            if (RoGetActivationFactory(hstring, ref iid, out var factory) < 0 || factory == IntPtr.Zero)
                return null;

            try { _interop = (IDataTransferManagerInterop)Marshal.GetObjectForIUnknown(factory); }
            finally { Marshal.Release(factory); }

            return _interop;
        }
        catch { return null; }
        finally { WindowsDeleteString(hstring); }
    }

    [DllImport("api-ms-win-core-winrt-l1-1-0.dll", ExactSpelling = true)]
    private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("api-ms-win-core-winrt-string-l1-1-0.dll", ExactSpelling = true)]
    private static extern int WindowsCreateString(
        [MarshalAs(UnmanagedType.LPWStr)] string sourceString, int length, out IntPtr hstring);

    [DllImport("api-ms-win-core-winrt-string-l1-1-0.dll", ExactSpelling = true)]
    private static extern int WindowsDeleteString(IntPtr hstring);
}
