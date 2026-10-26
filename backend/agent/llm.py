"""Dony LLM 循环：首次请求模式判断、快速 ReAct≤5 次、任务 Plan-and-Execute、流式转发。"""
import asyncio
import base64
import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import config
from . import cards
from . import memory
from .tools.base import REGISTRY, Tool, ToolResult, get_tool_specs, make_schema, run_tool
from .tools.skills import skills_line

# ---- 特殊工具（不进注册表，由循环直接处理） ----
ENTER_TASK_TOOL = Tool(
    name="enter_task_mode", label="进入任务模式",
    description=("当本次需求复杂、需要多步骤完成或多次工具调用（如打开APP并多步操作、需要模拟点击/"
                 "多次截屏/多次控件操作），或需要写入较长文本（整篇文稿、多段落、约300字以上）时，"
                 "调用此工具进入任务模式。单步简单操作禁止使用。"),
    parameters=make_schema({"task_summary": {"type": "string", "description": "任务概述", "required": True}}),
    handler=None, modes=("fast",),
)
ASK_USER_TOOL = Tool(
    name="ask_user", label="询问用户",
    description="当用户的任务描述不清晰、缺少必要信息无法继续执行时，调用此工具打断任务向用户提问。",
    parameters=make_schema({"question": {"type": "string", "description": "要向用户询问的内容", "required": True}}),
    handler=None, modes=("fast", "task"),
)
UPDATE_PLAN_TOOL = Tool(
    name="update_plan", label="规划任务步骤",
    description="任务模式下用于制定/更新任务执行计划。进入任务模式后应先用它规划步骤。",
    parameters=make_schema({"steps": {"type": "array", "items": {"type": "string"}, "description": "步骤列表", "required": True}}),
    handler=None, modes=("task",),
)
SHOW_CARD_TOOL = Tool(
    name="show_card", label="展示结果卡片",
    description=(
        "把本次成果用卡片展示给用户。**发不发卡片不是你来决定的**："
        "没有对应卡片时**一律不发**；有对应卡片时**必须发** —— "
        "无论是查看、查询还是操作（用户只问「我的 WiFi 是什么状态」「音量多少」也要发对应卡片），"
        "不要只在改了设置时才发。一件成果调用一次（可多次调用展示多张）。\n"
        "**卡片长什么样（标题、副标题写法、图标、配色、有没有开关或滑块）由类型 kind 预先定好，"
        "你改不了**——所以大多数情况下你只要传 kind：\n"
        "  · 开关类（只传 kind，别传 title/subtitle）：wifi / bluetooth / hotspot / "
        "sticky_keys / mono_audio / magnifier / narrator / osk / alarm / timer / task / startup。"
        "标题就是功能名（WiFi、闹钟、计时器），副标题是状态或数值（已打开、07:30、5:00），"
        "开关自动带上；计时器/闹钟的数字会自己走。\n"
        "  · 滑块类（只传 kind）：volume（音量）、brightness（亮度）——卡片上直接是滑块，"
        "副标题显示当前数值。\n"
        "  · 三段式（只传 kind）：power_mode（电源模式：节能 / 均衡 / 高性能）——"
        "卡片上是三段式档位控件，副标题显示当前档位。\n"
        "  · 内容类（kind + title，必要时 subtitle）：file / folder / delete（title 写文件名，"
        "如「报告.docx」；subtitle 写路径）、status（title 不填，副标题放 CPU/内存/磁盘）、"
        "edge、weather（title 写「晴 24℃」，subtitle 写地点与时间，details 给明细：降雨概率、"
        "风力、湿度等，查不到的不编）、website（title 标题、subtitle 网址）、"
        "device（title 写设备，副标题写状态）。\n"
        "标题只写「项」本身，严禁动词（写「报告.docx」而不是「创建 报告.docx」），"
        "也不要写「……的状态」「……的情况」这类句子。\n"
        "其它操作一律不要发卡片：读取文件/列目录、搜索文件、搜索网页、读取网页、执行命令、"
        "打开应用或网站、剪贴板、窗口管理、UIA 点击、截屏等。\n"
        "卡片已表达清楚的成果，最终回答不要复述，用一句**书面、具体**的话收尾即可："
        "如「已打开」「已设定」「已调至 35%」「已删除」「操作完成」「完成」——"
        "**不要**一律写「已完成」，更不要口语化。"),
    parameters=make_schema({
        "kind": {"type": "string", "enum": list(cards.KINDS),
                 "description": "卡片类型（决定标题/图标/配色/开关或滑块）；没有设计过的类型不发卡片",
                 "required": True},
        "title": {"type": "string",
                  "description": "内容类卡片的内容标题（文件名「报告.docx」、天气「晴 24℃」、"
                                 "网站标题、收件人/内容）；开关类与滑块类卡片不要传"},
        "subtitle": {"type": "string",
                     "description": "内容类卡片的补充小字（文件路径、地点与时间、对象等）"},
        "icon": {"type": "string", "enum": list(cards.ICONS),
                 "description": "只有天气卡片用它挑天气图标（sun/cloud-sun/cloud/rain/snow/"
                                "thunder/fog/wind/moon）；其它类型的图标由类型固定，忽略此参数"},
        "details": {
            "type": "array",
            "description": "需要更多内容的卡片（目前是天气）的明细项，最多 6 条；其它卡片省略。",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "明细名称，如「降雨」「风」「湿度」"},
                    "value": {"type": "string", "description": "明细内容，如「10%」「东北风 3 级」「62%」"},
                },
                "required": ["label", "value"],
            },
        },
    }),
    handler=None, modes=("fast", "task"),
)

BASE_SYSTEM = (
    "你是Dony，用户的Windows系统助手，深度融入Windows系统生态。\n"
    "执行任务优先使用提供的工具直接完成（系统级、底层、优雅），不要进行不稳定的猜测性操作。\n"
    "规则：\n"
    "1. 接到需求先做模式判断：估计本次需要几次工具调用/模型请求，对照下方「模式预算」决定"
    "留在快速模式还是调用 enter_task_mode。判断尽量在动手前做完，但**不必一次定死**："
    "做下去发现估错了（步骤比预想多、牵涉到界面操作、要写长文本），随时可以调用 enter_task_mode 换过去——"
    "不要因为“已经开始了”就硬撑；换模式是为了把事办成，不算反复无常。\n"
    "2. 属于以下情况必须先进入任务模式：要操作**任何第三方 APP**"
    "（浏览器、播放器、聊天/办公软件、游戏、第三方工具等等，只要需要读它的界面或点它、拖它、滚它）；"
    "用户的说法里只要**提到操作界面**"
    "（点一下、点击、单击、双击、按下、选中、勾选、滑动、拖拽、拉、滚动、滑到底之类），"
    "或者需要坐标点击/拖拽/滚动"
    "（gui_click / shot_click / gui_drag / shot_drag / gui_scroll 都只在任务模式可用）；"
    "需要多步骤完成；预计工具调用次数较多（触及或超过快速模式预算）；"
    "要写入较长文本（整篇文稿、多段落、约300字以上）。"
    "**第三方 APP 的指令话说得再轻，判断时也要进任务模式**：「放一首音乐」「给某某发消息」"
    "「在微信里……」「打开某个 app 再做点什么」都算——它们多半要开界面、点控件、甚至多步，"
    "不要因为句子短就留在快速模式。单步简单操作才用快速模式。\n"
    "3. 任务描述不清晰时调用 ask_user 向用户追问，不要臆测。\n"
    "4. 非必要不截屏、不模拟点击（很慢），优先直接型工具。需要点界面时按这个顺序：\n"
    "  · **能用 UIA 就绝不用坐标点击**：先 uia_list_controls 拿控件清单，只要目标控件在清单里，"
    "就必须用它的 @(x,y) 走 gui_click（控件级、看得见、点得准），**不许**改用截图估坐标。"
    "清单里没有、或控件是个大容器（整个窗口一个控件）时，才退到截图；"
    "没有控件（Chromium/自绘界面，如音乐播放器）就截图看："
    "screenshot_understand(window=\"进程名或标题或active\")，截图会直接作为图片给你看（你亲眼判断）；"
    "要点击就把目标在**这张图上的像素位置**交给 shot_click(x=..., y=...)——"
    "后端会按缩放换算成屏幕坐标，你不需要做任何换算，只需在图上看准位置并给出像素数（别报百分比）。"
    "列表类界面常常“单击只选中、双击才生效”，该双击就传 double=true；"
    "除了点击，还有两个动作：拖拽用 gui_drag(起点+终点坐标) 或 shot_drag(填图上的起点与终点)，"
    "滚动用 gui_scroll(lines=行数，正数向下负数向上，可给 x/y 或 window)；"
    "每次关键操作后再截一张图确认结果，点错要立刻纠正。\n"
    "5. 收尾话术：用一句**书面、具体**的话交代结果，不展开过程。按做过的事换说法——"
    "开关类「已打开」「已关闭」；设定类「已设定」「已创建」；数值类「已调至 35%」；"
    "文件类「已写入」「已创建」「已删除」；打开程序或网页「已打开」；"
    "多步任务「操作完成」「完成」——**不要**一律用「已完成」这句套话。\n"
    "6. 最终回答必须简短：通常1-3句话，只说结论和结果。若本轮成果已经由卡片展示，"
    "文字只补上面那样一句具体结论（如「已打开」「已设定」「操作完成」），不要复述卡片上的内容。"
    "**全程书面表达，严禁口语化**：不说「好啦」「搞定啦」「这就去」「没问题哦」「稍等哈」"
    "这类语气词，也不用「亲」「咱们」「小伙伴」等称呼；"
    "语言跟用户一致（用户说中文就用中文，用户说英文可用 Done / Finished）。"
    "回答里禁止出现 Markdown 符号（* # ` _ ~ 等）、表情包与其它修饰符号："
    "不要写 **加粗**、不要用 * 或 - 做项目符号；要分点就写「1. 2. 3.」或「·」，"
    "只保留中文标点、数字、字母。\n"
    "7. 提到文件/文件夹时用简单的自然语言（如「桌面」「下载文件夹」「文档里的XX.docx」），"
    "不要念出 D:\\... 这类完整路径，除非用户明确要求路径。\n"
    "8. 做不了或工具执行失败时，直接如实告知用户做不到及原因，严禁虚构成功。"
    "但工具回「该操作仅任务模式可用」不算失效：先 enter_task_mode，再重新调用同一个工具，"
    "不要回报成「点击工具失效」。\n"
    "9. 开关蓝牙/WiFi、音量、亮度、打开应用等简单系统操作必须直接调用对应工具，"
    "严禁通过 run_shell 编写或执行临时脚本绕路实现。\n"
    "10. 涉及「桌面/文档/下载/图片」等用户文件夹时，用下方给出的真实路径定位，"
    "禁止按 C:\\Users\\... 惯例猜测；操作文件前先确认目标文件夹的真实位置，再执行。\n"
    "11. 联网查资料用 web_search 搜索、web_fetch 读取网页正文（搜索结果链接直接传给它），"
    "严禁用 run_shell 写脚本抓网页或调用国外搜索引擎。\n"
    "12. 卡片是你向用户展示成果的方式，规则是**硬性**的："
    "**没有对应卡片就不要发；有对应卡片就必须发** —— 无论是查看、查询还是操作"
    "（用户只问「我的 WiFi 是什么状态」也要发 wifi 卡片、只问「音量多少」也要发 volume 卡片），"
    "不是「只有改了设置才发」。**每个功能都有自己的一张卡片**"
    "（不存在「通用卡片」），而且卡片的一切外观——标题、副标题写法、图标、配色、有没有开关或滑块"
    "——都由类型 kind 预先定好，你只选 kind（内容类卡片再填内容），所以不会出现「漏了开关」这种事。"
    "以下操作各配一张卡片：\n"
    "  · 开关类（只传 kind）：WiFi wifi、蓝牙 bluetooth、移动热点 hotspot、"
    "粘滞键 sticky_keys、单声道音频 mono_audio、放大镜 magnifier、讲述人 narrator、"
    "屏幕键盘 osk、闹钟 alarm、计时器 timer、计划任务 task、启动项 startup；\n"
    "  · 滑块类（只传 kind）：音量 volume、亮度 brightness；\n"
    "  · 三段式（只传 kind）：电源模式 power_mode（节能 / 均衡 / 高性能，用 set_power_mode 切换）；\n"
    "  · 内容类（kind + title，必要时 subtitle）：文件/文件夹 file/folder（title 写文件名）、"
    "删除 delete、系统状态 status（title 不填，CPU/内存/磁盘放进 subtitle）、Edge edge、"
    "天气 weather（title 写「晴 24℃」，subtitle 写地点与时间，details 给明细）、"
    "网站 website（title 标题、subtitle 网址）、设备 device。\n"
    "标题只写「项」本身，严禁动词（写「报告.docx」而不是「创建 报告.docx」），"
    "也不要写「……的状态」这类句子。"
    "其它操作（读取、搜索、执行命令、打开应用或网站、剪贴板、窗口、UIA、截屏等）一律不发卡片。\n"
    "⚠ 卡片只能用来展示**被操作/被查询的那个东西本身**（文件、文件夹、网站、天气、设备、"
    "系统开关…）。**绝对不要**用卡片去汇报「我刚做了什么」（改了系统设置、打开了程序、"
    "完成了某个任务、已切换到某模式…）——那类一律只用文字回答，不要发任何卡片。\n"
    "13. 打开新程序后，先用 manage_window(action=focus, title=进程名或active) 把它调到前台再操作"
    "（新窗口的标题可能过一会儿才稳定，用进程名最可靠）。"
    "**是否在打开后收起 Dony 界面，由你自己判断**（没有程序化的拦截，也没有额度）。"
    "判断依据是系统提示里写明的「对话进度」，**必须同时满足三条**才调用 exit_dony："
    "① 这一句是**本次唤醒后的第一句话**（系统提示会明确写；写着「已经聊过若干句」时"
    "绝对不要调用——历史上出过「每轮都自认为是第一句、于是每次打开 APP 都自动退出」的问题）；"
    "② 用户**只**要求打开这一个程序（或只打开一个网址）；"
    "③ 本轮**没有任何其它操作**（没查东西、没改设置、没发消息、没读文件、没搜索…）。"
    "三条里任意一条不满足，就不要调用，正常回答即可。"
    "遇到 UAC / 管理员权限确认弹窗时你无法代点（它在安全桌面上）：立刻告诉用户去点「是」或「否」，"
    "不要反复重试、也不要换别的工具绕路。\n"
    "14. 文件与磁盘纪律（这条比“把事办完”更重要，违反它就算这一轮失败）：\n"
    "· 未经用户明确允许，禁止在任何用户不知道的路径（临时目录、系统目录、C 盘根目录、"
    "程序自己的目录等）创建文件——包括“用完就删”的临时脚本、日志、缓存，全都算。"
    "要落盘必须同时满足三条：用户要求写文件；路径在用户指定处（或用户文件夹里明显合理的位置）；"
    "做完要告诉用户文件放在哪。\n"
    "· 需要跑一段代码查信息时，直接用 run_shell 一条命令跑完（如 powershell -Command …、"
    "python -c …），不要先写 .py/.ps1/.bat 文件再执行；确实非写不可，先说明并征得用户同意。\n"
    "· 对用户的文件、目录和磁盘空间要有敬畏之心：删除、覆盖、移动、改名前必须先看清目标"
    "（把范围列出来确认），只动用户明确说到的那一项；宁可多问一句，也不要自作主张。\n"
    "· 不要把中间产物堆到磁盘上：能用一条命令或内存解决的就不落地；确实要生成文件，"
    "就放在用户当前操作的文件夹里，并在回答里说清楚。\n"
    "13. 不要为过程性操作发卡片，也不要在最终回答里罗列过程；不要为了完成任务去写无用的"
    "中间文档或脚本，只有用户需要的成果文件才用 write_file 写入。\n"
    "14. 语言规范（回答、追问、卡片文字都遵守）：\n"
    "  · 直接说结果，不寒暄、不铺垫：不写「抱歉」「好的」「让我来帮你」「我这就为你」这类开场，"
    "也不写「希望这对你有帮助」这类收尾。\n"
    "  · 用第二人称「你」，不用「我们／本人／本助手」；所有格能省就省"
    "（说「桌面上的文件」，不写「你的桌面上的文件」）。\n"
    "  · 不用技术行话与实现细节：不提工具名、端口、脚本名、API、内部路径、模型名，"
    "用户明确问起时才说明。\n"
    "  · 同一事物始终用同一个词（文件夹／对话／任务／步骤），不要换着叫。\n"
    "  · 短句优先，一句只说一件事；用具体信息代替笼统评价（说「已保存到桌面」，"
    "不写「操作成功」）。\n"
    "  · 简短不等于挤成一整段：有两个以上要点时分行写，一行一件事（用换行分隔）；"
    "界面里文字是逐行出现的，分行才看得清、有条理。\n"
    "  · **尽量多换行**：一行只表达一件事，句子稍长就在语义停顿处断开；"
    "界面里的文字是逐行出现的，行短而多比一整段更好读。\n"
    "  · 让用户操作时用动词说清会发生什么（「重试」「删除」「撤销更改」），"
    "不要写「点击这里」「在这里操作」这类没有信息的话。\n"
    "  · 失败时讲清两件事：发生了什么、你能做什么；不要甩错误码或异常原文。\n"
    "  · 数字、时间、版本用阿拉伯数字；短标题与标签末尾不加句号。\n"
    "15. 写文稿默认用普通用户常用的格式：文字稿 .docx、纯文本 .txt、表格 .xlsx、演示 .pptx。"
    "不要拿 .md/.csv/.py/.json 这类开发者格式当用户文稿，除非用户明确要求，"
    "或格式本身就是任务需要的（代码、配置、数据交换）。\n"
    "16. 长期记忆：下方「已知信息」是跨对话保留的记忆，用来省去重复询问（比如地区）。"
    "问到需要用但记忆里没有的稳定信息（地区、称呼等）时，先用 ask_user 问一次，"
    "得到回答后用 remember 记下；发现记忆过时或记错了，用 forget 删掉再记新的。"
    "只记稳定、以后还用得上的内容（地区、称呼、常用偏好、这台电脑的固定情况），"
    "不要记临时的任务细节、聊天内容或密码之类的敏感信息。\n"
)

# 超过这个字数视为「长文本写入」，应进入任务模式（快速模式请求次数有限，容易写完就超限）
LONG_TEXT_CHARS = 300


def _mode_budget_line() -> str:
    """模式预算：把当前请求次数上限告知模型，作为模式判断依据（随配置变化）。"""
    return (
        f"模式预算：快速模式最多 {config.FAST_MAX_REQUESTS} 次模型请求（一次工具调用算一轮，"
        f"超限系统会强制收尾），任务模式最多 {config.TASK_MAX_REQUESTS} 次。"
        f"判断标准：预计需要 {config.FAST_MAX_REQUESTS} 次左右或更多的模型请求、"
        f"或要分多步操作、或要写入约 {LONG_TEXT_CHARS} 字以上的内容时，"
        "先调用 enter_task_mode；只要一步工具就能完成的简单需求留在快速模式。"
    )
VOICE_SYSTEM_SUFFIX = "\n你现在正通过语音朗读与用户对话，回答必须简短、纯文本（不能带表情包、markdown、修饰符号，否则朗读报错）。"
FAST_SYSTEM_SUFFIX = (
    "\n当前为快速模式：追求最快完成。选择最直接的工具一次做完，"
    "禁止不必要的探索、列表枚举、重复尝试或编写脚本；没有对应工具就立刻如实说明做不到。"
    "\n本模式**没有**点击类工具（gui_click / shot_click 只在任务模式）："
    "需求里只要提到点击，就先 enter_task_mode 再动手，不要在这里试、也不要回报工具失效。"
    "\n快速模式的请求次数很少，禁止写入长文本（整篇文稿、多段落内容）；"
    "要是发现需求实际需要多次调用或较长内容，立刻改用 enter_task_mode 重做，不要硬撑到超限。"
    "\n回答保持一两句话，路径用自然语言描述。"
)
LIMIT_SYSTEM_NOTE = ("\n本轮已达到操作次数上限，请直接根据已有信息给出简短的中文结论，"
                     "不要再请求任何工具，也不要输出工具调用格式的文字"
                     "（禁止出现 DSML、tool_calls、invoke 之类的标记）。"
                     "之前已经执行成功的操作要如实说明（用「已打开」「已设定」这类具体说法）。")

# 模型（DeepSeek 等）在无法调用工具时会把工具调用按模板当普通文本吐出来（如 <｜DSML｜tool_calls>），
# 必须拦截：既不能显示给用户，也不能让它进入下一轮上下文。
_MARKUP_HINTS = ("DSML", "<tool_calls", "<tool_call ", "<|tool_calls|>", "</tool_calls>", "invoke name=")
_DSML_BLOCK_RE = re.compile(r"<[^<>]*DSML[^<>]*>.*?</[^<>]*DSML[^<>]*>", re.S | re.I)
_LEAK_TAG_RE = re.compile(r"</?[^<>]*(?:DSML|tool_calls?|invoke|parameter)[^<>]*>", re.I)


def has_tool_markup(text: str) -> bool:
    return bool(text) and any(h in text for h in _MARKUP_HINTS)


def _fallback_text(did_ok: bool, last_error: str) -> str:
    """模型没能给出可用回答时的兜底文案：按本轮实际执行情况如实说。"""
    if did_ok:
        return "操作完成。"
    if last_error:
        return f"抱歉，没能完成：{last_error[:100]}"
    return "抱歉，本轮操作没有真正执行。请重试，或把需求说得更具体一些。"


# 取参数里最能说明“这次操作了什么”的那个字段（历史记录里显示成一行操作）
_OP_ARG_KEYS = ("control_name", "name", "app", "path", "file", "query",
                "command", "url", "window_title", "title", "text")


def _shorten_command(cmd: str) -> str:
    """把命令行压成一段有信息量的文字。

    直接截前 28 个字符时，`powershell -NoProfile -Command "..."` 这种
    只剩外包装（用户看到的就是「powershell -NoProfile -Comma」），
    所以这里先把外包装剥掉，露出真正要做的事：
      · -EncodedCommand：它是 UTF-16LE 的 base64，解出来就是原始脚本
      · -Command / -c：取它后面的内容
    """
    text = " ".join((cmd or "").split())
    encoded = re.search(r"-EncodedCommand\s+(\S+)", text, re.I)
    if encoded:
        try:
            raw = base64.b64decode(encoded.group(1) + "===")
            script = " ".join(raw.decode("utf-16-le", "ignore").split())
            if script:
                return script
        except Exception:
            pass
    payload = re.search(r"-(?:Command|c)\s+(.+)$", text, re.I)
    if payload:
        inner = payload.group(1).strip().strip("\"'")
        if inner:
            return inner
    return text


def _op_text(label: str, args: Dict[str, Any]) -> str:
    """把一次工具调用压成一行人类可读的操作，如「点击界面控件 · 确定」「写入文件 · 周报.docx」。

    历史记录里展示的就是这一行；Dony 应用实时聊天里也用同一个字符串，
    保证“跑的时候看到的”和“事后翻历史看到的”完全一致。
    """
    for key in _OP_ARG_KEYS:
        value = args.get(key)
        if not isinstance(value, str):
            continue
        value = value.strip()
        if not value:
            continue
        if key in ("path", "file"):
            base = os.path.basename(value.rstrip("\\/")) or value
            return f"{label} · {base[:32]}{'…' if len(base) > 32 else ''}"
        if key == "command":
            value = _shorten_command(value)
            return f"{label} · {value[:80]}{'…' if len(value) > 80 else ''}"
        return f"{label} · {value[:32]}{'…' if len(value) > 32 else ''}"
    # 没有文字参数：补几个常见数值（音量 30、坐标 (960,540)、时长 60…）
    x, y = args.get("x"), args.get("y")
    if isinstance(x, int) and isinstance(y, int) and not isinstance(x, bool):
        return f"{label} · ({x},{y})"
    for key in ("level", "percent", "value", "seconds", "minutes", "duration", "count"):
        value = args.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return f"{label} · {value}"
    return label


def strip_tool_markup(text: str) -> str:
    """剥离泄漏的工具调用标记，返回纯回答文本。"""
    if not text:
        return ""
    cleaned = _DSML_BLOCK_RE.sub("", text)
    cleaned = _LEAK_TAG_RE.sub("", cleaned)
    return cleaned.strip()
TASK_SYSTEM_SUFFIX = (
    "\n你已进入任务模式：先调用 update_plan 规划步骤，然后分步执行。"
    "可以多次使用UIA控件操作、截屏理解和模拟点击，但仍应优先直接型工具。"
    "长文本写入可以放在这一模式里完成（例如一次性写入整篇文稿）。"
    "全部步骤完成后给出简短总结（几句话说清做了什么、结果如何），不要复述过程。"
)
# ReAct：边思考边行动——先给一份初步计划，然后每步「先判断、再行动、看结果、再决定下一步」，
# 计划随实际情况修订。与下面这份的区别：不再是「先想全、再照做」。
TASK_REACT_SUFFIX = (
    "\n你已进入任务模式，采用边思考边行动的方式工作（ReAct）：\n"
    "  · 先调用 update_plan 给出一份初步步骤清单：只写你现在就能确定的步骤，不必一次想全。\n"
    "  · 每一步都按「判断→行动→看结果→再决定下一步」进行：拿到工具结果后先看是否符合预期，"
    "再决定继续、调整还是收尾；不必严格照最初的计划走。\n"
    "  · 计划是活的：结果与预期不符、或发现新情况时，随时再调用 update_plan 更新步骤。"
    "只在方向发生变化时更新，不要每步都更新。\n"
    "  · 需要多次 UIA 控件操作、截屏理解、模拟点击时照常使用，但仍优先直接型工具；"
    "长文本写入可以在这一模式里完成。\n"
    "  · 思考过程不要输出：调用工具前后都不要写推理、判断依据或过程说明，"
    "直接把工具调用发出来即可；用户只看到最后的结论。\n"
    "  · 全部完成后给出简短总结（几句话说清做了什么、结果如何），不要复述过程。"
)

# 用户文件夹真实位置（桌面等可能被用户重定向到 D: 等位置，从注册表读取，不猜测）
_user_folders_line: Optional[str] = None


def _get_user_folders_line() -> str:
    global _user_folders_line
    if _user_folders_line is None:
        from .tools.files import known_user_folders
        folders = known_user_folders()
        _user_folders_line = (
            "用户文件夹实际位置（逐项从注册表读取，每个文件夹都可被用户单独重定向，"
            "可能在不同盘符、不同目录，也可能不叫 Desktop/Documents，不要假设它们都在同一个用户目录下）："
            + "；".join(f"{k}={v}" for k, v in folders.items())
            + "。以上路径即权威位置，禁止在别处新建同名文件夹，也禁止按 C:\\Users\\<用户名>\\… 惯例猜测。")
    return _user_folders_line


class AgentLoop:
    """单会话的模型调用循环。历史消息跨轮保留（上下文保留）。"""

    def __init__(self, session: Any):
        self.session = session
        self.history: List[Dict[str, Any]] = []
        self._client: Optional[httpx.AsyncClient] = None
        self._last_card: Optional[dict] = None     # 最近一次工具执行声明的卡片数据

    async def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=config.API_BASE,
                headers={"Authorization": f"Bearer {config.API_KEY}"},
                timeout=httpx.Timeout(90.0, connect=10.0),
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    def _system_prompt(self, voice: bool, mode: str) -> str:
        p = BASE_SYSTEM + "\n" + _mode_budget_line() + "\n" + _get_user_folders_line()
        # 已安装技能清单（SKILLS_DIR 里有 SKILL.md 才会出现这行）：
        # 模型据此判断要不要先 load_skill 拉取完整说明再干活。
        _skills = skills_line()
        if _skills:
            p += "\n" + _skills
        # 对话进度：reset_session 每次唤醒都会清空上下文，模型自己**看不出**这是第几句，
        # 于是每轮都自认为是第一句、每次都 exit_dony（"打开 APP 总自动退出"的根因）。
        # 这里把后端知道的真相明确写给它（不是程序化拦截，只是给足信息让它自己判断）。
        p += ("\n对话进度：下面这条用户消息就是**本次唤醒后的第一句话**。"
              if getattr(self.session, "first_turn", False) else
              "\n对话进度：本次唤醒后**已经聊过若干句了**，下面这条不是第一句。")
        # 记忆每轮现读（可能刚被 remember 改动），不加缓存
        remembered = memory.as_prompt()
        if remembered:
            p += "\n" + remembered
        if voice:
            p += VOICE_SYSTEM_SUFFIX
        if mode == "fast":
            p += FAST_SYSTEM_SUFFIX
        elif config.TASK_REACT:
            p += TASK_REACT_SUFFIX
        else:
            p += TASK_SYSTEM_SUFFIX
        return p

    def _trimmed_history(self) -> List[Dict[str, Any]]:
        """只保留最近 config.MAX_HISTORY_IMAGES 张截图，更早的换成占位文字。

        截图不带 token 概念：整段历史每轮都要重发，图多了既贵又慢。
        只替换 image_url 那部分（消息结构不动），self.history 本身不改，
        这样「对话记录」里仍能看到原始内容。
        """
        keep = max(0, config.MAX_HISTORY_IMAGES)
        seen = 0
        out: List[Dict[str, Any]] = []
        for m in reversed(self.history):
            content = m.get("content")
            if isinstance(content, list) and any(p.get("type") == "image_url" for p in content):
                seen += 1
                if seen > keep:
                    kept = [p for p in content if p.get("type") != "image_url"]
                    kept.append({"type": "text",
                                 "text": "（这张更早的截图已省略；需要就重新截图查看）"})
                    m = {**m, "content": kept}
            out.append(m)
        out.reverse()
        return out

    def _messages(self, voice: bool, mode: str) -> List[Dict[str, Any]]:
        return [{"role": "system", "content": self._system_prompt(voice, mode)}] + self._trimmed_history()

    async def _chat(self, messages: List[Dict[str, Any]], tools: Optional[List[dict]],
                    on_delta, tool_choice: str = "auto") -> Tuple[Dict[str, Any], bool]:
        """流式请求；返回 (完整 message, 是否检测到泄漏的工具调用标记)。

        工具调用回合抑制 content 转发；若模型把工具调用当普通文本输出（DSML 标记），
        立即停止转发并剥离标记，避免把标记当成回答显示给用户。
        """
        client = await self.client()
        payload: Dict[str, Any] = {"model": config.MODEL, "messages": messages, "stream": True,
                                   **config.thinking_payload()}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice
        content_parts: List[str] = []
        tool_calls: Dict[int, Dict[str, Any]] = {}
        leaked = False
        blocked = False
        async with client.stream("POST", "/chat/completions", json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise RuntimeError(f"模型API错误 {resp.status_code}: {body.decode(errors='ignore')[:300]}")
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except Exception:
                    continue
                delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                if delta.get("content"):
                    content_parts.append(delta["content"])
                    if not tool_calls and not blocked:
                        if has_tool_markup("".join(content_parts)):
                            blocked = leaked = True   # 停止转发，稍后整体清理
                        else:
                            await on_delta(delta["content"])
                for tc in delta.get("tool_calls") or []:
                    idx = tc.get("index", 0)
                    slot = tool_calls.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["name"] += fn["name"]
                    if fn.get("arguments"):
                        slot["arguments"] += fn["arguments"]
        msg: Dict[str, Any] = {"role": "assistant", "content": "".join(content_parts)}
        if tool_calls:
            msg["tool_calls"] = [
                {"id": s.get("id") or f"call_{i}", "type": "function",
                 "function": {"name": s["name"], "arguments": s["arguments"] or "{}"}}
                for i, s in sorted(tool_calls.items())
            ]
        elif has_tool_markup(msg["content"]):
            msg["content"] = strip_tool_markup(msg["content"])
            leaked = True
        return msg, leaked

    async def _read_control(self, kind: str):
        """后端自己读一次该卡片的操控项状态：开关 → bool，滑块 → 数值。

        工具没给状态时用它兜底（典型是"读取"类：用户只问「我的 WiFi 什么状态」）。
        这样卡片上的开关/滑块一定在、位置也对——状态不靠猜、也不靠模型记得传。
        """
        spec = cards.spec_for(kind)
        try:
            if kind in ("wifi", "bluetooth"):
                from winsdk.windows.devices.radios import RadioState
                from .tools.system import _find_radios
                radios = await _find_radios(kind)
                return bool(radios) and all(r.state == RadioState.ON for r in radios)
            if kind == "volume":
                from .tools.system import _volume_sync
                return await asyncio.to_thread(_volume_sync)
            if kind == "brightness":
                from .tools.system import _brightness_read
                return await asyncio.to_thread(_brightness_read)
            if kind in ("hotspot", "mobile_hotspot"):
                from .tools.system import _hotspot_state
                return await _hotspot_state()
            if kind == "power_mode":
                # 三档电源模式：卡片的段位靠它定位（节能/均衡/高性能）
                from .tools.system import _power_mode_get_mode
                return await asyncio.to_thread(_power_mode_get_mode)
            if spec.get("switch"):
                # 系统开关（电源模式/粘滞键/单声道/放大镜/讲述人/屏幕键盘…）
                from .tools.system import _read_toggle_state
                return await asyncio.to_thread(_read_toggle_state, spec["switch"])
        except Exception as e:
            print(f"[agent] 读取 {kind} 操控项状态失败: {type(e).__name__}: {e}", flush=True)
        return None

    async def _make_model_card(self, args: Dict[str, Any]) -> Optional[dict]:
        """按模型选的 kind 组装卡片（内容类卡片再带上模型填的内容）。

        标题/副标题写法/图标/配色/开关或滑块**全部来自 cards.CARD_SPECS**（设计时定死），
        模型只决定"发哪张卡"；状态/数值优先取工具刚声明的，工具没给就自己读一次。
        没设计过的类型不发卡片——不存在"通用卡片"。
        """
        kind = str(args.get("kind") or "").strip().lower()
        spec = cards.spec_for(kind)
        if not spec:
            return None
        pending = self._last_card
        self._last_card = None
        if pending and pending.get("kind") != kind:
            pending = None          # 工具声明的是别的卡：状态/内容不能张冠李戴
        pending = pending or {}
        control_state = None
        if spec.get("control") and pending.get("state") is None and pending.get("value") is None:
            control_state = await self._read_control(kind)
        card = cards.build_card(kind, pending=pending, content=args,
                                control_state=control_state,
                                details=args.get("details"),
                                icon_override=str(args.get("icon") or ""))
        if card and kind == "website":
            card = await self._website_card_extra(card, args)
        return card

    async def _fetch_og_image(self, url: str) -> str:
        """抓网页主图（og:image / twitter:image）；拿不到就返回空。"""
        import html as htmlmod
        import re
        from urllib.parse import urljoin
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=6.0,
                                         headers={"User-Agent": "Mozilla/5.0"}) as client:
                resp = await client.get(url)
            page = resp.text[:200000]
            pat = re.compile(
                r"""<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["']"""
                r"""[^>]*content=["']([^"']+)""", re.I)
            m = pat.search(page)
            if not m:
                return ""
            # 页面里的 &amp; 要还原成 &，否则图片地址带转义、加载不出来
            raw = htmlmod.unescape(m.group(1)).strip()
            return urljoin(str(resp.url), raw) if raw else ""
        except Exception as e:
            print(f"[agent] 抓网站主图失败: {type(e).__name__}: {e}", flush=True)
            return ""

    async def _website_card_extra(self, card: dict, content: Dict[str, Any]) -> dict:
        """网址卡片：链接与网站主图**由后端自己去取**，模型不用管。

        主图抓不到就留空，前端会回退成线描图标（不阻塞卡片）。
        """
        import re
        blob = " ".join(str(content.get(k) or "") for k in ("subtitle", "title"))
        m = re.search(r"https?://[^\s，。；、）)】\]\"'<>]+", blob)
        if not m:
            return card
        url = m.group(0)
        extra = dict(card.get("extra") or {})
        extra["url"] = url
        if not card.get("image"):
            image = await self._fetch_og_image(url)
            if image:
                card["image"] = image
        card["extra"] = extra
        return card

    def _sanitize_history(self):
        """修复被打断轮次留下的悬空 tool_calls（无配对 tool 结果会导致下次请求 400）。"""
        pending: Dict[str, str] = {}
        for m in self.history:
            if m.get("role") == "assistant":
                for tc in m.get("tool_calls") or []:
                    pending[tc["id"]] = tc["function"]["name"]
            elif m.get("role") == "tool" and m.get("tool_call_id") in pending:
                del pending[m["tool_call_id"]]
        for tid, name in pending.items():
            self.history.append({"role": "tool", "tool_call_id": tid,
                                 "content": f"（{name} 操作被用户打断，未执行完成）"})

    async def _persist_turn(self, answer: str, cards: List[dict], ops: Optional[List[str]] = None):
        """把本轮问答写入历史记录（供 Dony 应用查看/续聊）。"""
        hid = getattr(self.session, "history_id", None)
        user_text = ""
        for m in reversed(self.history):
            # 只看纯文字的用户消息：截图注入的那条 content 是列表（文字+图片），
            # 它不是用户提问，拿来当“用户说了什么”会把对话记录弄坏。
            if m.get("role") == "user" and isinstance(m.get("content"), str):
                user_text = m["content"]
                break
        if not hid or not (user_text or answer):
            return
        try:
            from . import history as history_store
            await asyncio.to_thread(history_store.append_turn, hid, user_text, answer, cards, ops)
        except Exception as e:
            print(f"[agent] 历史写入失败: {e}", flush=True)

    def _persist_partial(self, hid: Optional[str], cards: List[dict], ops: List[str]) -> None:
        """被中途取消时立刻落盘。

        必须是同步写入、不能 await：任务已被取消，再 await 会被再次打断。
        hid 在 run() 开头就取好——reset_session() 会在取消后立刻清掉 history_id，
        等异常传到这里时它已经是 None 了。
        """
        if not hid:
            return
        user_text = ""
        for m in reversed(self.history):
            # 只看纯文字的用户消息：截图注入的那条 content 是列表（文字+图片），
            # 它不是用户提问，拿来当“用户说了什么”会把对话记录弄坏。
            if m.get("role") == "user" and isinstance(m.get("content"), str):
                user_text = m["content"]
                break
        try:
            from . import history as history_store
            history_store.append_turn(hid, user_text, "（对话被中途关闭，这一步没做完）", cards, ops)
            print(f"[agent] 已保存中断记录 sid={hid}", flush=True)
        except Exception as e:
            print(f"[agent] 中断记录写入失败: {e}", flush=True)

    async def run(self, text: str, voice: bool):
        s = self.session
        # 先记住历史 id：界面中途关闭会先清掉它，那时再读就晚了
        hid = getattr(s, "history_id", None)
        self._sanitize_history()
        s.mode = "fast"
        self._last_card = None
        self.history.append({"role": "user", "content": text})
        mode = "fast"
        requests = 0
        cards: List[dict] = []
        ops: List[str] = []   # 本轮执行过的操作（写成一行行文字，落进历史记录）
        started = time.time()
        did_ok = False        # 本轮是否有工具真正执行成功
        last_error = ""       # 最近一次工具失败原因（用于如实回答）

        async def on_delta(d: str):
            # 输出静默：模型生成过程不逐步显示（前端在 done 时把完整文字逐行飞入），
            # 处理期间界面上只有加载球/药丸在转，避免文字一边生成一边抖动。
            return

        try:
            while True:
                requests += 1
                specials = [ASK_USER_TOOL, SHOW_CARD_TOOL]
                if mode == "fast":
                    specials.append(ENTER_TASK_TOOL)
                else:
                    specials.append(UPDATE_PLAN_TOOL)
                limit = config.FAST_MAX_REQUESTS if mode == "fast" else config.TASK_MAX_REQUESTS
                force_final = requests >= limit
                # 到达次数上限：只保留「展示结果卡片」，其余工具一律不给。
                # 这样成果仍然能展示（否则最后一轮会连 show_card 一起被禁掉，卡片丢失），
                # 同时因为没有别的工具可调，模型也不会把工具调用写成纯文本吐出来。
                if force_final:
                    tools = [s for s in get_tool_specs(mode, [SHOW_CARD_TOOL])
                             if s["function"]["name"] == SHOW_CARD_TOOL.name]
                else:
                    tools = get_tool_specs(mode, specials)
                messages = self._messages(voice, mode)
                if force_final:
                    # 把提示追加到同一条 system 消息里（不插入对话中段的 system 消息，兼容性更好）
                    messages[0] = {"role": "system",
                                   "content": messages[0]["content"] + LIMIT_SYSTEM_NOTE}

                # 收尾轮的工具表里只有 show_card，所以用 auto 让它有机会把成果展示出来
                msg, leaked = await self._chat(messages, tools, on_delta, tool_choice="auto")
                self.history.append(msg)
                tcs = msg.get("tool_calls") or []
                if tcs and msg.get("content"):
                    # 模型在调用工具的同一轮里输出了文字：已流式转发的文字不是最终回答，
                    # 通知前端清掉并回到处理态，避免提前展开结果框。
                    # 注意：模型的思考过程不对外展示，这里只清掉，不做任何展示。
                    await s.emit({"type": "text-reset"})

                if not tcs:
                    if requests == 1:
                        await s.emit({"type": "mode", "mode": "fast"})
                    text = msg.get("content") or ""
                    if leaked:
                        # 模型把工具调用写成了纯文本：清掉已转发内容，给用户一个可理解的回答
                        print("[agent] 检测到模型输出的工具调用标记，已拦截", flush=True)
                        await s.emit({"type": "text-reset"})
                        if not text.strip():
                            # 注意：此时工具可能已经真的执行成功过，不能一律说“没有执行”
                            text = _fallback_text(did_ok, last_error)
                    await s.emit({"type": "done", "text": text,
                                  "elapsed_ms": int((time.time() - started) * 1000)})
                    await self._persist_turn(text, cards, ops)
                    print(f"[agent] done mode={mode} reqs={requests} "
                          f"{int((time.time()-started)*1000)}ms", flush=True)
                    return

                if requests == 1 and mode == "fast":
                    names = [t["function"]["name"] for t in tcs]
                    if "enter_task_mode" not in names:
                        await s.emit({"type": "mode", "mode": "fast"})

                shot_images: List[str] = []   # 本批工具带回来的截图（见下方注入）
                for tc in tcs:
                    name = tc["function"]["name"]
                    try:
                        args = json.loads(tc["function"]["arguments"] or "{}")
                    except Exception:
                        args = {}

                    if name == ENTER_TASK_TOOL.name:
                        mode = "task"
                        s.mode = "task"
                        s.reset_counters()
                        await s.emit({"type": "mode", "mode": "task"})
                        self.history.append({"role": "tool", "tool_call_id": tc["id"],
                                             "content": "已进入任务模式，请先 update_plan 规划再分步执行。"})
                        continue
                    if name == ASK_USER_TOOL.name:
                        answer = await s.ask("question", args.get("question", "需要补充信息"))
                        self.history.append({"role": "tool", "tool_call_id": tc["id"],
                                             "content": f"用户回答：{answer}"})
                        continue
                    if name == SHOW_CARD_TOOL.name:
                        card = await self._make_model_card(args)
                        if card is None:
                            self.history.append({"role": "tool", "tool_call_id": tc["id"],
                                                 "content": "卡片未展示：这个 kind 没有对应的卡片类型。"
                                                            "请用工具结果里提示的 kind（每次都提示了）。"})
                        else:
                            cards.append(card)
                            await s.emit({"type": "cards", "cards": [card]})
                            self.history.append({"role": "tool", "tool_call_id": tc["id"],
                                                 "content": "卡片已展示给用户，最终回答不要复述卡片内容。"})
                        continue
                    if name == UPDATE_PLAN_TOOL.name:
                        steps = args.get("steps") or []
                        await s.emit({"type": "plan", "steps": steps})
                        self.history.append({"role": "tool", "tool_call_id": tc["id"],
                                             "content": f"计划已记录，共{len(steps)}步。"})
                        continue

                    t = REGISTRY.get(name)
                    if t is None:
                        self.history.append({"role": "tool", "tool_call_id": tc["id"],
                                             "content": f"未知工具 {name}"})
                        continue
                    if mode == "fast" and "fast" not in t.modes:
                        self.history.append({"role": "tool", "tool_call_id": tc["id"],
                                             "content": "该操作仅任务模式可用（这不是工具失效）："
                                                        "请先调用 enter_task_mode，"
                                                        "然后重新调用同一个工具。"})
                        continue

                    op_text = _op_text(t.label, args)
                    await s.emit({"type": "tool-start", "name": name, "label": t.label, "op": op_text})
                    result = await run_tool(t, args, s.ctx)
                    await s.emit({"type": "tool-end", "name": name, "ok": result.ok})
                    # 本轮的“执行的操作”清单（写进历史，Dony 应用里能看到全过程）
                    if len(ops) < 40:
                        ops.append(op_text if result.ok else f"{op_text}（未成功）")
                    if result.ok:
                        did_ok = True
                    else:
                        last_error = result.text
                    # 工具只声明「卡片数据」（kind + 状态/内容）；要不要发卡片由模型决定，
                    # 卡片外观则由 cards.CARD_SPECS 决定（模型改不了，也就不会漏开关）
                    if result.card:
                        self._last_card = result.card
                    self.history.append({"role": "tool", "tool_call_id": tc["id"],
                                         "content": result.to_model_content()})
                    if result.image_b64:
                        shot_images.append(result.image_b64)

                if shot_images:
                    # 截图类工具带回来的图：tool 消息不能放图（协议限制），
                    # 所以在这一批工具结果之后补一条 user 消息，把图交给主模型自己看。
                    # 全部工具消息都发完再补，避免一批里多张图把 tool 配对关系拆断。
                    parts: List[Dict[str, Any]] = [{"type": "text",
                        "text": "这是你刚要求查看的屏幕截图，直接看图判断。"}]
                    for b64 in shot_images:
                        parts.append({"type": "image_url",
                                      "image_url": {"url": f"data:image/png;base64,{b64}"}})
                    self.history.append({"role": "user", "content": parts})

                if force_final:
                    # 收尾轮：本轮只允许发卡片，处理完工具调用就直接给结论，不再继续请求
                    text = msg.get("content") or ""
                    if leaked:
                        text = strip_tool_markup(text)
                        await s.emit({"type": "text-reset"})
                    if not text.strip():
                        text = _fallback_text(did_ok, last_error)
                    await s.emit({"type": "done", "text": text,
                                  "elapsed_ms": int((time.time() - started) * 1000)})
                    await self._persist_turn(text, cards, ops)
                    print(f"[agent] done(limit) mode={mode} reqs={requests} "
                          f"{int((time.time()-started)*1000)}ms", flush=True)
                    return
        except asyncio.CancelledError:
            # 用户中途关掉界面（Esc / 重新唤醒 / 应用退出）：也要留痕，
            # 否则 Dony 应用里的「对话记录」看不到这一段（这是之前的行为）。
            self._persist_partial(hid, cards, ops)
            raise
        except Exception as e:
            print(f"[agent] error: {e}", flush=True)
            await s.emit({"type": "error", "message": str(e)})


# 原来的 vlm_understand()（单独调一个视觉模型转述截图）已删除：
# 截图现在由 tools/base.ToolResult.image_b64 带回来，agent 循环把图作为一条 user
# 消息补进主对话，主模型自己看图（上下文完整，也不用再维护一套 VLM 配置）。
