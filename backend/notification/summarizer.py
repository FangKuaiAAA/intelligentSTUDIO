"""通知摘要：本地模型生成一句中文摘要，支持在旧摘要基础上增量重写。"""

import re
from typing import Optional

from . import config
from .engine import QwenEngine
from .listener import Incoming

SYSTEM_PROMPT = (
    "你是通知摘要助手。把同一应用的通知合并成一句不超过三十字的中文摘要，"
    "保留人名、时间、地点与待办事项。\n"
    "示例：\n"
    "通知：1. 张三：明天九点开会 2. 李四：文件已发邮箱 3. 王五：晚上吃饭吗\n"
    "摘要：张三明天九点开会，李四已发文件，王五约晚饭。\n"
    "只输出摘要，不要编号，不要解释。"
)
MAX_SUMMARY_CHARS = 60

_LEADING = re.compile(r"^[\s\d.、,，:：\-*#]+")


def build_messages(app: str, items: list[Incoming], old_summary: Optional[str]) -> list[dict]:
    lines = []
    if old_summary:
        lines.append(f"已有摘要：{old_summary}")
        lines.append("新增通知：")
    else:
        lines.append(f"应用：{app}")
    for index, item in enumerate(items[-20:], start=1):
        title = item.title.strip()[:80]
        body = item.body.strip().replace("\n", " ")[:140]
        lines.append(f"{index}. {title}：{body}" if body else f"{index}. {title}")
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(lines)},
    ]


def clean(text: str) -> str:
    value = _LEADING.sub("", (text or "").strip())
    value = value.strip(" 　\"'“”「」")
    value = value.split("\n")[0].strip()
    return value[:MAX_SUMMARY_CHARS]


async def summarize(engine: QwenEngine, app: str, items: list[Incoming],
                    old_summary: Optional[str], timeout: float) -> Optional[str]:
    try:
        text = await engine.generate(
            build_messages(app, items, old_summary),
            config.MAX_NEW_TOKENS,
            timeout,
            sample=True,
        )
    except Exception as exc:
        print(f"[notify] summarize failed app={app}: {type(exc).__name__}", flush=True)
        return None
    result = clean(text)
    return result or None
