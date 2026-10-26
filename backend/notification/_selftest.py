"""离线自测：分组、窗口、去重、摘要状态机与文本解析（不加载模型、不访问系统通知）。

运行：cd backend && python -m notification._selftest
"""

import time

from .grouping import Grouping, dedupe_key, session_key
from .listener import Incoming
from .summarizer import clean

FAILURES: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        FAILURES.append(name)


def make(index: int, title: str, body: str, app: str = "微信") -> Incoming:
    return Incoming(
        id=index, aumid="wechat", app=app, title=title,
        body=body, created=time.time(),
    )


def main() -> int:
    now = time.time()
    grouping = Grouping(threshold=3, window_seconds=60, dedupe_seconds=5)

    first = make(1, "张三", "明天九点开会")
    second = make(2, "张三", "会议室改到三楼")
    third = make(3, "张三", "记得带电脑")
    check("前两条不触发摘要", not grouping.add(first, now).first and not grouping.add(second, now + 1).first)
    result = grouping.add(third, now + 2)
    check("第三条触发首次摘要", result.first)
    check("同应用不同标题归为一组", session_key(first) == session_key(second))

    duplicate = make(4, "张三", "明天九点开会")
    dedupe = grouping.add(duplicate, now + 3)
    check("5 秒内同文同源只计数", dedupe.duplicate and not dedupe.first and not dedupe.debounce)
    check("重复项不进入增量缓冲", len(grouping.groups[result.key].delta) == 3)

    payload = grouping.begin(result.key, now + 4)
    check("begin 返回旧摘要与增量", payload is not None and payload[1] is None and len(payload[2]) == 3)
    consumed = payload[2] if payload else []
    grouping.complete(result.key, "张三明天九点在三楼开会", True, now + 5, consumed=consumed)
    check("成功后清空已消费增量", len(grouping.groups[result.key].delta) == 0)

    later = make(5, "张三", "会议推迟到十点")
    debounce = grouping.add(later, now + 40)
    check("已有摘要后新通知进入防抖", debounce.debounce and not debounce.first)

    grouping.begin(result.key, now + 41)
    grouping.complete(result.key, "张三的会议推迟到十点", True, now + 42, consumed=[later])
    check("摘要文本写入分组", grouping.groups[result.key].summary == "张三的会议推迟到十点")

    other = Incoming(
        id=6, aumid="dingtalk", app="钉钉", title="李四",
        body="文件已发邮箱", created=now + 43,
    )
    other_result = grouping.add(other, now + 43)
    check("不同应用单独分组", session_key(other) != session_key(first) and not other_result.first)
    check("去重键与分组键不同", dedupe_key(first) != session_key(first))

    unknown = Incoming(
        id=7, aumid="", app="未知应用", title="赵六", body="通知落盘瞬间 app_info 为空",
        created=now + 50,
    )
    unknown_result = grouping.add(unknown, now + 50)
    check("元数据为空时仍可归组", not unknown_result.first and "未知应用" in grouping.groups)

    check("摘要去掉编号", clean("1. 张三明天九点开会") == "张三明天九点开会")
    check("摘要截断到 60 字", len(clean("摘" * 200)) == 60)

    stale = grouping.prune(now + 1000, idle_seconds=600)
    check("空闲分组被清理", result.key in stale or result.key not in grouping.groups)

    if FAILURES:
        print(f"\n{len(FAILURES)} 项失败：{', '.join(FAILURES)}")
        return 1
    print("\n全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
