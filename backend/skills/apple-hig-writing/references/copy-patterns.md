# UI 文案模式库（可执行版）

> 由 HIG《Writing》提炼成的可套用模式与改写速查。原文出处见 `references/hig-writing-source.md`。
> 用法：写文案时按场景查表；评审时用文末《评审清单》逐条过。

---

## 1. Voice 与 Tone 的区别

| | Voice（语气基调） | Tone（语调） |
|---|---|---|
| 定义 | 产品**一贯**的人格，全局唯一 | voice 在**具体情境**下的变化 |
| 变化频率 | 不变 | 随情境变 |
| 决定因素 | 用户是谁、希望他们有什么感受 | 用户当下在做什么、状态如何 |
| 落地物 | 术语表 / 常用词清单 | 单条文案的措辞与呈现方式 |

**建立 voice 的输入**：目标用户熟悉的词汇是什么？希望他们产生什么感受？
例：银行类 → 信任、稳定；游戏类 → 兴奋、有趣。

**建立后必须产出术语表**，并据此保持全局一致。

**tone 随情境切换的极端对比（同一产品，Apple Watch）**：

| 情境 | 文案 | 特征 |
|---|---|---|
| 检测到摔倒（可能受伤，严肃） | "It looks like you've taken a hard fall." | 直接、严肃、不修饰 |
| 达成运动记录（正面成就） | "You set a personal record for your longest daily Move streak, 35 days!" | 轻松、祝贺式 |

> 判断 tone 的两个问题：(1) 用户在现实世界中正在做什么？(2) 用户在 App 内正处于什么状态？（成功了？还是在付款时报错？）

---

## 2. 清晰与简洁

- 每个词都拷问一遍：**它必须存在吗？**
- 能更少则更少。
- 拿不准就**朗读出声**——读不顺就是有问题。
- 面向所有人写：平实语言、避免行话、避免带性别的表述，同时考虑无障碍与本地化。

---

## 3. 按钮与链接

| 规则 | 反例 | 正例 |
|---|---|---|
| 按钮标签几乎总是用**动词** | Let's do it! | Send |
| 不要卖萌/抖机灵，优先清晰 | Sure thing, boss! | Delete |
| 链接不用 "Click here"，用描述性短语 | Click here | Learn more about UX Writing |

> 链接规则对使用屏幕阅读器的人尤其重要：读屏软件会把链接文本单独列出来，"Click here" 脱离上下文后毫无意义。

---

## 4. 多步骤流程的语言模式

跨屏流程需要**固定**的一套动作词，决定后不要中途换。

| 位置 | 推荐措辞 | 说明 |
|---|---|---|
| 流程起点 | Get Started | 明确表示"从这里开始" |
| 中间推进 | Continue / Next / 或直接用**下一步的动词**作按钮标签 | 三选一并保持一致；用具体动词可顺带预告下一步 |
| 流程结束 | Done | 明确告知流程完成 |

- 同义词混用（Next / Continue / Proceed 随机出现）会破坏熟悉感。
- 一个流程内**只选一种**推进词。

---

## 5. 大小写规则

| 风格 | 观感 | 适用 |
|---|---|---|
| Title Case（标题式大写） | 正式 | 例如：所有 alert 统一用 Title Case |
| Sentence case（句子式大写） | 随意 | 例如：所有 headline 统一用 sentence case |

- 先定风格，再**按 UI 元素类型统一**（alert 一套、headline 一套、按钮一套）。
- 某些组件（如按钮标签）另有专门规范，需叠加遵守。
- 关键不是选哪种，而是**全 App 一致**。

---

## 6. 物主代词与叙事视角

| 规则 | 反例 | 正例 |
|---|---|---|
| 物主代词能省则省，通常不提供额外信息 | Your Favorites | Favorites |
| 若用物主代词，则全 App 一致，不要切换视角 | 忽而 "your"，忽而 "my" | 统一用一个 |
| **完全避免 "we"**，因为"我们"指向不明 | We're having trouble loading this content. | Unable to load content. |

> "we" 在错误信息里问题最大：用户不知道这个"我们"是产品、公司、还是开发者。

---

## 7. 手势动词与设备差异

**手势词必须与设备匹配**：

| 设备 | 动词 | 反例 |
|---|---|---|
| iPhone / iPad 等触屏 | tap | ~~click~~ |
| 桌面（鼠标） | click | ~~tap~~ |

**跨设备写作调整**：

| 设备 | 使用场景特点 | 写作约束 |
|---|---|---|
| iPhone / Apple Watch | 私人化、贴身 | 屏幕小，**必须简短**；适合个性化措辞 |
| TV | 常处公共客厅，可能多人同时看到 | 注意**对谁说话**；屏幕大但观看距离远，文字要大，**同样需要简短** |

跨设备保持措辞一致，但**长短与视角**可按设备调整。

---

## 8. 空状态（Blank Screens）

- 空状态是**欢迎用户 + 教育用户**的机会，也是展示 voice 的好位置。
- 内容必须**有用且切合上下文**。
- 空屏若看不出下一步做什么会让人茫然 → 必须引导可执行的动作，并尽量给出**按钮或链接**。
- 空状态通常是**临时的**：不要放关键信息（它随时会消失）。

要素模型：`[欢迎/说明语气] + [为什么这里是空的] + [可以做什么] + [行动按钮/链接]`

---

## 9. 错误信息

优先级最高的是**让用户不犯错**；必须出现错误信息时：

| 规则 | 反例 | 正例 |
|---|---|---|
| 尽量贴近出问题的位置展示 | 顶部全局 toast 提示某字段错误 | 错误文案紧贴该输入框 |
| 不指责用户 | You entered it wrong | — |
| 明确告诉用户**怎么修** | That password is too short | Choose a password with at least 8 characters |
| 不用 "oops!" / "uh-oh" 之类感叹 | Oops! Something went wrong. | Unable to load content. |
| 避免无信息量的机械化文案 | Invalid name | Use only letters for your name |

> 免责：感叹词显得敷衍、不真诚。
> **升级信号**：如果发现「靠改文案解决不了一个会影响到大量用户的错误」，说明该重新设计交互，而不是继续打磨措辞。

---

## 10. 设置项标签

| 规则 | 说明 |
|---|---|
| 标签尽量实用直白 | 让人能快速找到想要的设置 |
| 标签不足以说清时，加一句说明 | 描述**打开时会怎样**，用户可自行推断关闭时的状态 |
| 不要写"关闭时会怎样" | 冗余 |
| 需要指路时给直达链接或按钮 | 不要用文字描述设置项的位置 |

示例（Apple Watch Handwashing Timer 的说明文案）：
> "Apple Watch can detect when you're washing your hands and start a 20-second timer."
>
> 只说「开启会启动 20 秒计时器」，无需再说明「关闭时不会启动」。

---

## 11. 文本输入框

- 所有字段**标签清晰**。
- 用 **hint / placeholder** 告诉用户格式：

| 手法 | 示例 |
|---|---|
| 给格式示例 | `name@example.com` |
| 描述该填什么 | `Your name` |

- 错误**显示在字段旁边**，并且**指导怎么填对**，而不是因为没遵守规则而训斥用户：

| 反例 | 正例 |
|---|---|
| Don't use numbers or symbols | Use only letters for your name |
| Invalid name | Use only letters for your name |

---

## 12. 消息投递方式（Delivery Method）

选择通道前先评估三件事：

1. **紧急与重要程度**——需要立刻处理吗？
2. **用户会在什么场景看到**——正在用 App，还是没在用？
3. **需要多少辅助信息**——一句话够吗，还是需要展开说明？

然后选用正确的投递方式（Notification / Alert / Action sheet 等），并使用与情境匹配的 tone。详见 HIG 的 Notifications、Alerts、Action sheets 章节。

---

## 13. 改写速查表

| 遇到 | 改成 |
|---|---|
| Click here | Learn more about UX Writing（描述性短语） |
| Let's do it! / 卖萌标签 | Send（动词） |
| Your Favorites | Favorites |
| We're having trouble loading this content. | Unable to load content. |
| That password is too short | Choose a password with at least 8 characters |
| Don't use numbers or symbols | Use only letters for your name |
| Invalid name | Use only letters for your name |
| Oops! Something went wrong. | Unable to load content. |
| Click（触屏设备） | Tap |
| 空屏无任何引导 | 说明 + 行动按钮（Done/Get Started 等） |
| 设置说明只写关闭行为 | 只写开启时的行为 |

---

## 14. 评审清单

按顺序过一遍，任一为「否」即需修改：

**信息层面**
- [ ] 最重要信息是否排在最前？
- [ ] 文案是否易于阅读（分段/格式）？
- [ ] 一个屏是否塞了多个概念？能否拆到多个屏并梳理跨屏信息流？

**动作层面**
- [ ] 是否用主动语态？
- [ ] 按钮/链接标签是否为动词（链接是否为描述性短语，而非 "Click here"）？

**一致性层面**
- [ ] 是否符合已建立的 voice 与术语表？
- [ ] tone 是否匹配当下情境（严肃 vs 轻松）？
- [ ] 大小写风格是否与该元素类型的既定规则一致？
- [ ] 多步骤流程的推进词（Get Started / Continue / Next / Done）是否全程统一？
- [ ] 物主代词是否被省略；若保留是否全程一致；是否已消除 "we"？

**设备层面**
- [ ] 手势动词是否正确（tap vs click）？
- [ ] 小屏/远距观看场景是否足够简短？
- [ ] 公共场景（如 TV）是否考虑了对谁说话？

**特殊场景层面**
- [ ] 空状态是否给出可执行的下一步 + 按钮/链接？是否避免了放关键信息？
- [ ] 错误信息是否贴近问题、不指责、给出修复方法、无感叹词？
- [ ] 设置项说明是否只描述"开启时"的行为？指路是否给了直达链接/按钮？
- [ ] 输入框是否有清晰标签 + hint 示例？字段错误是否就地展示且是指导性措辞？

**投放层面**
- [ ] 投递方式（通知/弹窗/动作表）与消息的紧急度、场景、信息量是否匹配？
- [ ] 面向所有人：是否避免了行话与带性别的表述，并兼顾无障碍与本地化？
