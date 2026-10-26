"""闹钟/计时器管理：内存列表、到点广播、单计时器约束、开关切换。"""
import asyncio
import time
import uuid
from typing import Any, Dict, Optional

from . import store


class AlarmManager:
    """闹钟/计时器独立存在：通过广播事件驱动 Electron 独立窗口。"""

    def __init__(self, server: Any):
        self.server = server
        self.items: Dict[str, Dict[str, Any]] = {}
        self.timer_id: Optional[str] = None  # 单计时器约束

    def _new_id(self) -> str:
        return uuid.uuid4().hex[:8]

    async def _broadcast(self, event: str, payload: dict):
        await self.server.broadcast({"type": "alarm-event", "event": event, **payload})

    # ---- 闹钟 ----
    async def set_alarm(self, fire_at: float, label: str = "") -> dict:
        alarm_id = self._new_id()
        item = {"id": alarm_id, "kind": "alarm", "fire_at": fire_at, "label": label,
                "active": True, "task": None}
        self.items[alarm_id] = item
        item["task"] = asyncio.create_task(self._fire_later(item))
        await self._broadcast("alarm-set", {"id": alarm_id, "fire_at": fire_at, "label": label})
        print(f"[agent] alarm set id={alarm_id}", flush=True)
        return item

    # ---- 计时器（单次只能一个） ----
    async def set_timer(self, duration_sec: int) -> dict:
        if self.timer_id and self.timer_id in self.items:
            await self.cancel(self.timer_id)
        timer_id = self._new_id()
        ends_at = time.time() + duration_sec
        item = {"id": timer_id, "kind": "timer", "duration": duration_sec,
                "fire_at": ends_at, "label": "", "active": True, "task": None}
        self.items[timer_id] = item
        self.timer_id = timer_id
        item["task"] = asyncio.create_task(self._fire_later(item))
        await self._broadcast("timer-start", {"id": timer_id, "duration": duration_sec, "ends_at": ends_at})
        print(f"[agent] timer set id={timer_id} {duration_sec}s", flush=True)
        return item

    async def _fire_later(self, item: dict):
        try:
            delay = max(0.0, item["fire_at"] - time.time())
            await asyncio.sleep(delay)
            if not item.get("active"):
                return
            item["active"] = False
            # 铃声由「设置」应用改（store.set_ringtone），这里把当前铃声一并带给闹钟窗口
            await self._broadcast("fire", {"id": item["id"], "kind": item["kind"],
                                           "label": item.get("label", ""),
                                           "duration": item.get("duration", 0),
                                           "ringtone": store.ringtone(item["kind"])})
            print(f"[agent] {item['kind']} fired id={item['id']}", flush=True)
        except asyncio.CancelledError:
            pass

    async def cancel(self, item_id: str):
        item = self.items.get(item_id)
        if not item:
            return
        item["active"] = False
        if item.get("task"):
            item["task"].cancel()
        if item["kind"] == "timer" and self.timer_id == item_id:
            self.timer_id = None
            await self._broadcast("timer-end", {"id": item_id})
        else:
            await self._broadcast("alarm-cancel", {"id": item_id})

    async def handle_cmd(self, cmd: str, item_id: str):
        """来自闹钟/计时器窗口的命令。"""
        item = self.items.get(item_id)
        # 取证用：卡片按钮的点击到底有没有到后端（Electron 开发日志里能直接看到）
        print(f"[card-click] alarm-cmd cmd={cmd} id={item_id or '-'}", flush=True)
        # 托盘右键来的命令（不带 id：用户点的是"停止计时器/取消闹钟"这件事本身）
        if cmd == "stop-timer":
            if self.timer_id:
                await self.cancel(self.timer_id)
            return
        if cmd == "cancel-alarm":
            alive = [i for i in self.items.values()
                     if i.get("kind") == "alarm" and i.get("active")]
            if alive:
                latest = max(alive, key=lambda i: i.get("fire_at", 0))
                await self.cancel(latest["id"])
            return
        if cmd in ("dismiss", "end"):
            await self.cancel(item_id)
            await self._broadcast("dismissed", {"id": item_id})
        elif cmd == "restart" and item and item["kind"] == "timer":
            await self.set_timer(int(item.get("duration", 60)))
            await self._broadcast("dismissed", {"id": item_id})
        elif cmd == "minimize":
            await self._broadcast("timer-minimized", {"id": item_id})

    async def handle_toggle(self, key: str, on: bool):
        """结果卡片滑块开关。alarm:<id> / timer:<id> 关闭或重新开启；其余转发系统开关。"""
        print(f"[card-click] toggle-card key={key} on={on}", flush=True)
        if ":" in key:
            prefix, item_id = key.split(":", 1)
            if prefix in ("alarm", "timer"):
                old = self.items.get(item_id)
                if not on:
                    # 卡片上的 id 可能已经过期：计时器被重启后是**新 id**（set_timer 会新建），
                    # 旧卡片再点"关"就会去 cancel 一个早就结束的 id，真正在跑的那个停不掉
                    # ——表现就是"计时器开关点了不生效"。所以：
                    #   · 计时器：认"当前正在跑的那个"（单计时器约束，只可能有一个）
                    #   · 闹钟：指定 id 不存在/已失效时，退一步取消最近设定的那个
                    target = item_id
                    if prefix == "timer":
                        if self.timer_id and self.timer_id != item_id:
                            target = self.timer_id
                    elif not old:
                        alive = [i for i in self.items.values()
                                 if i.get("kind") == "alarm" and i.get("active")]
                        if alive:
                            target = max(alive, key=lambda i: i.get("fire_at", 0))["id"]
                    await self.cancel(target)
                elif old and old["kind"] == "timer":
                    await self.set_timer(int(old.get("duration", 60)))
                elif old:
                    fire_at = old["fire_at"]
                    if fire_at <= time.time():  # 已过期的闹钟顺延到明天
                        fire_at += 86400
                    await self.set_alarm(fire_at, old.get("label", ""))
                else:
                    raise RuntimeError(f"这条{'计时器' if prefix == 'timer' else '闹钟'}已经不存在了")
                return
        # 非闹钟类开关（wifi/bluetooth/startup/task 等）转发系统层
        from .tools.system import toggle_system_switch
        await toggle_system_switch(key, on)
