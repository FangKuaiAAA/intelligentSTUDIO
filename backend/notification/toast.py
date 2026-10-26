"""摘要通知：注册 AUMID 快捷方式、发送系统 Toast、撤销旧摘要。

未打包应用发 Toast 需要「开始菜单里存在带 AppUserModelID 的快捷方式」；
这里用 pywin32 直接写 .lnk 的 PKEY_AppUserModel_ID 属性。
"""

import os
import sys
import time
from typing import Optional

from . import config

SHORTCUT_NAME = "intelligentSTUDIO.lnk"
TOAST_GROUP = "notify-summary"


def _programs_dir() -> str:
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs")


def shortcut_path() -> str:
    return os.path.join(_programs_dir(), SHORTCUT_NAME)


def ensure_shortcut(aumid: str = config.AUMID) -> tuple[bool, str]:
    """确保开始菜单里有带 AUMID 的快捷方式；已存在则直接返回。"""
    path = shortcut_path()
    if os.path.isfile(path):
        return True, ""
    try:
        import pythoncom
        from win32com.propsys import propsys, pscon
        from win32com.shell import shell

        os.makedirs(os.path.dirname(path), exist_ok=True)
        link = pythoncom.CoCreateInstance(
            shell.CLSID_ShellLink, None,
            pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IShellLink,
        )
        link.SetPath(sys.executable)
        link.SetDescription("intelligentSTUDIO")
        store = link.QueryInterface(propsys.IID_IPropertyStore)
        store.SetValue(pscon.PKEY_AppUserModel_ID, propsys.PROPVARIANTType(aumid))
        persist = link.QueryInterface(pythoncom.IID_IPersistFile)
        persist.Save(path, 0)
        print(f"[notify] AUMID shortcut created: {path}", flush=True)
        return True, ""
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        print(f"[notify] AUMID shortcut failed: {message}", flush=True)
        return False, message


def _notifier(aumid: str):
    from winsdk.windows.ui.notifications import ToastNotificationManager

    return ToastNotificationManager.create_toast_notifier(aumid)


def _known_ids(aumid: str) -> set[int]:
    from winsdk.windows.ui.notifications import NotificationKinds
    from winsdk.windows.ui.notifications.management import UserNotificationListener

    from .listener import _wait_operation

    listener = UserNotificationListener.current
    items = _wait_operation(listener.get_notifications_async(NotificationKinds.TOAST))
    found = set()
    for item in items:
        try:
            info = item.app_info
            if info is not None and (info.app_user_model_id or "") == aumid:
                found.add(int(item.id))
        except Exception:
            continue
    return found


def send_summary(title: str, body: str, tag: str,
                 aumid: str = config.AUMID) -> tuple[Optional[int], str]:
    """发送摘要 Toast，返回通知 ID（用于之后撤销）。失败时返回 (None, 原因)。"""
    ok, reason = ensure_shortcut(aumid)
    if not ok:
        return None, reason
    try:
        from winsdk.windows.ui.notifications import (
            ToastNotification, ToastNotificationManager, ToastTemplateType,
        )

        before = _known_ids(aumid)
        xml = ToastNotificationManager.get_template_content(ToastTemplateType.TOAST_TEXT02)
        nodes = xml.get_elements_by_tag_name("text")
        nodes.item(0).append_child(xml.create_text_node(title))
        nodes.item(1).append_child(xml.create_text_node(body))
        toast = ToastNotification(xml)
        toast.tag = tag[:16]
        toast.group = TOAST_GROUP
        _notifier(aumid).show(toast)
        deadline = time.time() + 2.0
        while time.time() < deadline:
            fresh = _known_ids(aumid) - before
            if fresh:
                return max(fresh), ""
            time.sleep(0.12)
        return None, "toast shown but id not found"
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        print(f"[notify] toast failed: {message}", flush=True)
        return None, message


def remove(notification_id: Optional[int]) -> bool:
    if not notification_id:
        return False
    try:
        from winsdk.windows.ui.notifications.management import UserNotificationListener

        UserNotificationListener.current.remove_notification(int(notification_id))
        return True
    except Exception as exc:
        print(f"[notify] toast remove skipped: {type(exc).__name__}", flush=True)
        return False


def cleanup(aumid: str = config.AUMID) -> int:
    """清掉本应用留在通知中心的旧摘要，避免重启后残留。"""
    removed = 0
    try:
        for notification_id in _known_ids(aumid):
            if remove(notification_id):
                removed += 1
    except Exception as exc:
        print(f"[notify] toast cleanup failed: {type(exc).__name__}", flush=True)
    return removed
