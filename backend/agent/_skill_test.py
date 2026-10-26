"""Skill 真机自测：用真实系统提示词 + 工具表问一个界面文案问题，
看模型是否主动调用 load_skill，并跑通「工具调用 → 回填结果 → 最终回答」两轮。

用法：.venv\\Scripts\\python.exe backend\\agent\\_skill_test.py
（会真实调用一次主模型 API，产生少量 token。）
"""
import asyncio
import json
import os
import sys
from types import SimpleNamespace

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent import config, llm  # noqa: E402
from agent.tools.base import REGISTRY, get_tool_specs  # noqa: E402

QUESTION = ("帮我改一下设置页里的这两句文案：开关说明「开启后 Dony 会在后台整理通知」，"
            "按钮「确定」。界面是桌面端。")


async def ask(client, messages, tools):
    payload = {"model": config.MODEL, "messages": messages, "tools": tools,
               "tool_choice": "auto", "stream": False, **config.thinking_payload()}
    resp = await client.post("/chat/completions", json=payload)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]


async def main():
    loop = llm.AgentLoop(SimpleNamespace(first_turn=True))
    system = loop._system_prompt(False, "fast")
    assert "apple-hig-writing" in system, "技能清单没有进入系统提示词"

    tools = get_tool_specs("fast", [])
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": QUESTION}]

    async with httpx.AsyncClient(base_url=config.API_BASE,
                                 headers={"Authorization": f"Bearer {config.API_KEY}"},
                                 timeout=90.0) as client:
        msg = await ask(client, messages, tools)
        calls = msg.get("tool_calls") or []
        names = [c.get("function", {}).get("name") for c in calls]
        print("[test] 第一轮工具调用:", names or "（无）")
        assert "load_skill" in names, "模型没有调用 load_skill"

        call = next(c for c in calls if c["function"]["name"] == "load_skill")
        args = json.loads(call["function"].get("arguments") or "{}")
        print("[test] load_skill 参数:", args)
        result = await REGISTRY["load_skill"].handler(args, None)
        print("[test] 技能内容:", len(result.text), "字 | ok =", result.ok)

        messages.append({"role": "assistant", "content": msg.get("content") or "",
                         "tool_calls": calls})
        messages.append({"role": "tool", "tool_call_id": call["id"],
                         "content": result.text})
        final = await ask(client, messages, tools)
        text = (final.get("content") or "").strip()
        print("[test] 最终回答（前 240 字）:\n" + text[:240])
        assert text, "最终回答为空"
    print("[test] 两轮往返完成 —— Dony 可调用该技能")


if __name__ == "__main__":
    asyncio.run(main())
