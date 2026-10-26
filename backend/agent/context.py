"""工具执行上下文：主界面（overlay WS）与应用内对话共用同一份实现。

共用是刻意的——应用内对话必须与 Alt+Space 唤醒的主界面行为完全一致，
包括快速模式的 UIA/截屏次数限制、敏感操作的打断确认、AI 自建文件登记等。
"""
import os
from typing import Optional

from . import config


class ToolContext:
    """传给工具 handler 的上下文。

    依赖会话对象提供：mode / ask() / created_files / uia_count / screenshot_count。
    """

    def __init__(self, session):
        self.session = session

    @property
    def mode(self) -> str:
        return self.session.mode

    async def confirm(self, text: str, detail: Optional[dict] = None) -> bool:
        """敏感操作确认（打断弹窗，允许/不允许）。"""
        result = await self.session.ask("confirm", text, detail)
        return bool(result)

    def mark_created(self, path: str):
        """记录本次会话由 AI 新建的文件/文件夹（删除它们时无需用户确认）。"""
        self.session.created_files.add(os.path.normcase(os.path.normpath(path)))

    def is_created(self, path: str) -> bool:
        return os.path.normcase(os.path.normpath(path)) in self.session.created_files

    def unmark_created(self, path: str):
        self.session.created_files.discard(os.path.normcase(os.path.normpath(path)))

    def check_uia(self):
        self.session.uia_count += 1
        if self.session.mode == "fast" and self.session.uia_count > config.FAST_MAX_UIA:
            raise RuntimeError("快速模式最多进行2次控件操作，请改用直接型工具或 enter_task_mode")

    def check_screenshot(self):
        self.session.screenshot_count += 1
        if self.session.mode == "fast" and self.session.screenshot_count > config.FAST_MAX_SCREENSHOT:
            raise RuntimeError("快速模式每条消息最多截屏1次，需要多次理解请 enter_task_mode")
