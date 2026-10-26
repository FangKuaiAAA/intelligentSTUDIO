"""离线构建通知重要性分类器的类别向量。

输入：models/bge-small-zh-v1.5（INT8 ONNX + tokenizer）
输出：models/bge-small-zh-v1.5/classifier.json（正/负质心与阈值）

运行：python scripts/build_notification_classifier.py
仅这一步需要 onnxruntime 与 tokenizers；服务运行时不再训练。
"""

import json
import os
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
MODEL_DIR = os.path.join(REPO_ROOT, "models", "bge-small-zh-v1.5")
OUTPUT = os.path.join(MODEL_DIR, "classifier.json")

IMPORTANT = [
    "客户合同今天下班前必须确认，否则影响上线",
    "明天上午九点在三楼会议室开项目评审会，请准时参加",
    "我到楼下了，下来接我一下",
    "我到了，下来接我好呢",
    "明天早上九点在三楼会议室开会开会；我到了，下来接我好呢",
    "明天早上九点在三楼会议室开会开会；家里出事了，来帮忙！",
    "家里出事了，来帮忙！",
    "现在方便说话吗？有急事找你",
    "明早九点三楼会议室开会，别迟到",
    "信用卡最后还款日为明天，请及时还款",
    "老板要求所有人明天十点临时开会",
    "面试通知：请于明天下午两点参加视频面试",
    "医院预约：明天上午门诊，请提前半小时到院",
    "银行入账：工资已到账 12000 元",
    "安全告警：检测到异常登录，请立即修改密码",
    "您的账号在异地登录，请立即修改密码",
    "您的密码可能已泄露，请立刻修改",
    "Windows 将在 1 分钟后重启，单击以取消",
    "系统将在 5 分钟后自动重启，请保存工作",
    "disk01 报警：文件系统错误，你可能会丢失数据",
    "磁盘空间不足，请立即清理",
    "电池电量严重不足，请立即充电",
    "设备温度过高，即将自动关机",
    "文件同步失败，可能有数据丢失",
    "你还没来吗？大家都在等你",
    "客户的付款今天必须完成，否则订单取消",
    "领导要求今晚之前提交方案",
    "方案今晚之前必须发给我",
    "本月报销单提交截止到本周五，请及时处理",
    "明天上午九点开始停水，请提前储水",
    "您购买的车票明天发车，请提前到站",
    "账号存在安全风险，请立即修改密码",
    "系统告警：服务器磁盘即将写满，请立即处理",
    "合同盖章后请在今天寄出",
    "明天入职，请携带身份证和学历证明",
    "客户的退款申请需要你今天审批",
    "项目上线时间提前到明天上午",
]

NORMAL = [
    "你愿望单中的游戏正在打折，还剩 6 小时",
    "你关注的 UP 主发布了新视频",
    "今晚回家吃饭吗",
    "包裹已到驿站，请及时取件",
    "满 300 减 50 优惠券今晚到期",
    "Windows 有可用更新，将在空闲时安装",
    "好友邀请你加入对局",
    "不重要通知，请勿打扰",
    "本周会员日，全场五折起",
    "你的快递正在派送中",
    "你的订单已发货，预计三天送达",
    "你关注的话题登上热搜",
    "有人请求添加你为朋友",
    "你有红包即将过期",
    "限时秒杀，今晚八点开抢",
    "为您推荐可能感兴趣的商品",
    "本周天气以晴为主，气温回升",
    "您的会员积分本月将清零",
    "附近有一家新开的咖啡店",
    "游戏版本更新完成，可以进入游戏",
    "不重要通知，勿响应 测试消息，请不要打扰我",
    "这是一条测试消息，请不要打扰我",
    "测试通知，可以忽略",
    "记得为明天的会议做准备",
    "记得准备明天开会要用的材料",
    "会议资料我先发你，有空再看看",
    "提醒你一下，明天有个会",
    "改天有空一起吃饭",
    "周末去爬山怎么样",
    "系统更新已完成，可以正常使用",
    "磁盘清理建议：可释放 2GB 空间",
    "设备温度正常",
    "电量已充至 80%",
]

# kNN 分数（最近正例相似度 − 最近负例相似度）：实测负例 ≤ -0.23，
# 正例 ≥ +0.16，取 0.13 留出余量；命中示例集时分数显著更高。
THRESHOLD = 0.13


def main() -> int:
    session = ort.InferenceSession(
        os.path.join(MODEL_DIR, "onnx", "model_quantized.onnx"),
        providers=["CPUExecutionProvider"],
    )
    input_names = {item.name for item in session.get_inputs()}
    tokenizer = Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
    tokenizer.enable_truncation(max_length=128)
    tokenizer.enable_padding(length=128)

    def embed(text: str) -> np.ndarray:
        encoding = tokenizer.encode(text)
        inputs = {
            "input_ids": np.array([encoding.ids], dtype=np.int64),
            "attention_mask": np.array([encoding.attention_mask], dtype=np.int64),
        }
        if "token_type_ids" in input_names:
            inputs["token_type_ids"] = np.array([encoding.type_ids], dtype=np.int64)
        vector = session.run(None, inputs)[0][0, 0]
        return vector / (np.linalg.norm(vector) + 1e-9)

    started = time.perf_counter()
    positive = np.stack([embed(text) for text in IMPORTANT])
    negative = np.stack([embed(text) for text in NORMAL])
    payload = {
        "version": 2,
        "method": "knn",
        "threshold": THRESHOLD,
        "positive": [[round(float(value), 6) for value in row] for row in positive],
        "negative": [[round(float(value), 6) for value in row] for row in negative],
        "exemplars": {"important": len(IMPORTANT), "normal": len(NORMAL)},
    }
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    print(
        f"写入 {OUTPUT}\n维度={positive.shape[1]} 正例={len(IMPORTANT)} 负例={len(NORMAL)} "
        f"阈值={THRESHOLD} 耗时={time.perf_counter() - started:.2f}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
