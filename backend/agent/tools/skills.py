"""Skill 装载：扫描 SKILLS_DIR 下的 <文件夹>/SKILL.md，模型经 load_skill 按需取完整说明。

Skill 约定（与 Agent Skills 同一族）：
  SKILLS_DIR/<文件夹名>/SKILL.md
  文件顶部用 --- 包一段 frontmatter（name: / description: 各一行，纯「键: 值」写法，
  不引 YAML 解析器），正文是给模型看的完整用法说明。
Skill 只提供「知识/方法」，由模型用 Dony 已有工具（文件/命令/UIA/联网…）去执行；
Skill 本身不含代码、不会被运行 —— 安全、可分享、可随时增删。
目录在「STUDIO设置 → Dony MCP 与 Skill」里配置（AGENT_SKILLS_DIR）。
"""
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from .. import config
from .base import ToolResult, tool

# frontmatter：文件顶部的 --- 包裹块（容许 \r\n）
_FRONT_RE = re.compile(r"\A---\s*\r?\n(.*?)\r?\n---\s*\r?\n?", re.S)


def _parse(path: str) -> Optional[Tuple[Dict[str, str], str]]:
    """读 SKILL.md → (meta, 正文)。打不开/为空返回 None。"""
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = f.read()
    except OSError:
        return None
    if not raw.strip():
        return None
    meta: Dict[str, str] = {}
    body = raw.strip()
    m = _FRONT_RE.match(raw)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                meta.setdefault(k.strip().lower(), v.strip())
        body = raw[m.end():].strip()
    return meta, body


def list_skills() -> List[Dict[str, str]]:
    """列出已安装的技能。每次调用都重扫目录 —— 设置页/接口直接用；
    skills_line() 同样每次重扫，因此**新增/删除技能下一轮对话即生效**（无需重启）。
    只有修改 SKILLS_DIR 本身需要重启（config 在进程启动时读取）。"""
    out: List[Dict[str, str]] = []
    root = config.SKILLS_DIR
    if not root or not os.path.isdir(root):
        return out
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return out
    for name in names:
        md = os.path.join(root, name, "SKILL.md")
        if not os.path.isfile(md):
            continue
        parsed = _parse(md)
        if not parsed:
            continue
        meta, _body = parsed
        out.append({
            "id": name,                                   # 文件夹名 = 稳定 id
            "name": meta.get("name") or name,             # frontmatter 里的显示名
            "description": meta.get("description") or "",
            "dir": os.path.join(root, name),
        })
    return out


def skills_line() -> str:
    """注入系统提示词的一行技能清单；没有技能时返回空串（不污染提示词）。"""
    skills = list_skills()
    if not skills:
        return ""
    items = "；".join(f"「{s['id']}」{s['description']}" for s in skills)
    # 「已启用、无需安装/启用」必须写明：否则模型容易把 Skill 当成需要启用的插件，
    # 明明已经读到全文，却回报「技能包已安装、运行时还没启用、暂时无法调用」。
    return ("已安装并可用的技能（已启用，无需安装或启用步骤；用户请求与下列相关时"
            "先调 load_skill 查看完整方法，再用现有工具执行）：" + items)


@tool("load_skill", "查看技能",
      "装载一个已安装技能的完整用法说明。要执行的任务涉及技能清单里的技能时，先调用本工具查看说明。\n"
      "name 填技能清单「」里的技能名（即文件夹名）。",
      {"name": {"type": "string", "description": "技能名（技能清单「」里的名字）", "required": True}})
async def load_skill_tool(args: Dict[str, Any], ctx) -> ToolResult:
    want = str(args.get("name") or "").strip().strip("「」")
    if not want:
        return ToolResult("要指定技能名。", ok=False)
    for s in list_skills():
        if want in (s["id"], s["name"]):
            parsed = _parse(os.path.join(s["dir"], "SKILL.md"))
            if not parsed:
                return ToolResult(f"技能「{s['id']}」的 SKILL.md 读不出来。", ok=False)
            # 带上技能目录：说明里若引用了同目录的参考文件，模型能直接用文件工具按绝对路径读取。
            # 同时明确「已启用」：读到即生效，不存在单独的启用步骤（防模型虚报未启用）。
            return ToolResult(
                f"技能「{s['id']}」已启用，内容如下（技能目录：{s['dir']}）。"
                f"照此说明直接完成任务即可，无需安装或启用步骤：\n\n{parsed[1]}")
    installed = "、".join(s["id"] for s in list_skills()) or "（无）"
    return ToolResult(f"技能「{want}」不存在。已安装：{installed}", ok=False)
