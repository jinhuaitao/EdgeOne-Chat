# EdgeOne-Chat

多通道 AI 对话前端，跑在 **腾讯云 EdgeOne Makers** 上：
运行时用 **Cloud Functions (Node.js 20)**，持久化用 **Blob 存储**。
由上游原版 v7.0.0（跑在 Cloudflare Workers + R2 上）完整移植而来。

✨ 多通道 AI 对话 · PWA · 语音朗读 · Agent 模式（19 个零密钥工具 · L1 缓存加速）·
知识库 2.0（长期记忆 + 文档精读 + 全文检索）· Telegram 机器人

---

## 一、部署

### 1. 推送代码到 Git 仓库

```bash
git init && git add -A && git commit -m "EdgeOne port"
git remote add origin <你的仓库地址> && git push -u origin main
```

### 2. 在 EdgeOne Makers 创建项目

进入 [Makers 控制台](https://console.cloud.tencent.com/edgeone/pages) → **创建项目** → 选择该 Git 仓库。

- **构建命令**：留空；**输出目录**：留空（页面 HTML 由函数动态生成，无前端构建步骤）
- **安装命令**：保持默认 `npm install`（安装 `@edgeone/pages-blob`）
- 点击部署

> `edgeone.json` 已把函数 `maxDuration` 设为 **120 秒**，这是 Agent 长任务能跑完的前提。

### 3. 配置环境变量

项目 **设置 → 环境变量**，配好后**重新部署一次**才生效。
完整变量表见[第二节](#二环境变量一览)。最低配只需要三行：

```
API_URL_1 = https://api.deepseek.com/v1/chat/completions
API_KEY_1 = sk-xxxxxx
MODEL_1   = deepseek-chat:DeepSeek Chat, deepseek-reasoner:DeepSeek R1
```

> 存储**无需配任何变量**：Blob 命名空间默认 `edgeone-chat`，自动创建。

`API_KEY_1` 想填多个 key 时用英文逗号分隔（`sk-a,sk-b`），撞上失效/限流的 key 会自动换一个
重试，详见第二节 [🔑 多密钥](#-多密钥key-池)。

### 4. 验证

访问 `/healthz`：

```json
{ "ok": true, "runtime": "edgeone", "storage": "blob:edgeone-chat" }
```

- `storage: blob:edgeone-chat` —— 持久化已接通
- `storage: memory` —— **未接通**，聊天可用，但 Telegram / 知识库 / 长期记忆重启即丢

排障时加 `STORAGE_DEBUG=1` 重新部署，再看 `/healthz` 的 `debug` 字段
（`provision.state` 应为 `ready`，`lastStorageError` 应为 `null`，
`keyPool` 是各 key 的掩码与冷却状态）；`?probe=1` 会做一次真实读写验证。
详见[第四节](#四存储)。

### 5. 预创建 Blob 命名空间（可选，推荐）

不跑也能用（首个请求会自动创建），但提前建好可避免把创建耗时放在线上第一个请求里：

```bash
# 控制台「API Token」页面生成 token，项目概览里复制 projectId
EO_PROJECT_ID=pages-xxxxxxxx EO_API_TOKEN=xxx npm run bootstrap:blob
```

成功输出 `✓ 命名空间「edgeone-chat」已就绪`，退出码 0；失败给出错误码与建议，
可直接接进 CI 做就绪门禁（`--json` 更好解析；`npm run bootstrap:blob:check` 只检查不创建）。

### 6. 绑定 Telegram Webhook（可选）

**推荐用自带的 `/tg-setup`，不要手动拼 setWebhook URL。**
因为它绑完会立刻把 `getWebhookInfo` 的结果摊给你看 —— 手动绑只能看到一句
`{"ok":true}`，而这句话**不代表链路可用**。

```
https://<你的EdgeOne域名>/tg-setup?key=<TG_SETUP_KEY>&action=set
```

绑好后去掉 `&action=set` 就是体检报告。手动绑定（不推荐）：

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<你的EdgeOne域名>/tg-webhook&secret_token=<SECRET>
```

机器人不响应时的排查顺序与完整能力表见[第三节](#三telegram-机器人)。

---

## 二、环境变量一览

> ⭐ = 建议配置；无标记 = 高级/可选。**所有变量配完都要重新部署才生效。**

### 🤖 AI 通道（连接）

| 变量 | 说明 |
|---|---|
| `API_URL_1` ⭐ | 通道 1 的接口地址，如 `https://api.deepseek.com/v1/chat/completions`（可继续配 `_2`、`_3`…多通道；也支持不带数字后缀的 `API_URL` / `API_KEY` / `MODEL` 写法） |
| `API_KEY_1` ⭐ | 通道 1 的密钥。**支持英文逗号填多个**（`sk-a,sk-b,sk-c`）组成 key 池，详见下方「🔑 多密钥」 |
| `MODEL_1` ⭐ | 模型列表，格式 `模型ID:显示名`，多个用英文逗号分隔，如 `deepseek-chat:DeepSeek Chat, deepseek-reasoner:DeepSeek R1` |
| `MAX_TOKENS` | 单次回复最大 token，默认 `4096` |
| `API_KEY_ROTATE` | 设 `0` 关掉「失败换 key 重试」，退回「一次请求一个 key」的老行为。默认开启 |

### 🔑 多密钥（key 池）

`API_KEY_1` 允许填**多个 key**，用英文逗号分隔。适合「同一家服务商的多个账号 / 多份额度」，
用来摊平单个 key 的 RPM、TPM 限制：

```
API_URL_1 = https://api.deepseek.com/v1/chat/completions
API_KEY_1 = sk-aaa, sk-bbb, sk-ccc
MODEL_1   = deepseek-chat:DeepSeek Chat
```

`API_CONFIG` 的 JSON 写法同样支持，且 `keys` 可以直接给**数组** ——
**key 里本身含英文逗号时只能用这种写法**（逗号分隔的形式无法表达）：

```
API_CONFIG = [{"url":"https://api.deepseek.com/v1/chat/completions",
               "keys":["sk-aaa","sk-bbb"],
               "models":"deepseek-chat:DeepSeek Chat"}]
```

运行时行为：

| 环节 | 行为 |
|---|---|
| 选取 | 每个请求**随机**挑一个健康的 key（不是轮询，也没有会话粘性） |
| 失败重试 | 只在 `401`（密钥无效）/ `402`（欠费）/ `403`（无权限或被封）/ `429`（限流）时换一个 key 重试；单次请求最多试 3 个 key |
| 不重试 | `400` 参数错误、`404` 地址错误、`5xx` 上游故障、以及网络超时 —— 换 key 都治不了，重试只会翻倍延迟 |
| 熔断 | 连续失败的 key 按指数退避进入冷却（30 秒起，最长 10 分钟），冷却期内不再被优先选中；成功一次立刻恢复 |
| Agent 模式 | 循环的**每一步**都重新选 key，同一轮对话可能用到不同 key |
| 同名模型 | 同一模型 ID 写在多个通道、且 `API_URL` 相同时，key 池会**合并去重** |
| 多服务商 | ⚠️ key 池绑定在同一个 `API_URL_i` 上。要接不同厂商请另开通道（`API_URL_2 / API_KEY_2 / MODEL_2`，支持到 `_20`） |

排障：设 `STORAGE_DEBUG=1` 后访问 `/healthz`，`debug.keyPool` 会列出每个模型下各 key 的
连续失败次数、上次状态码与剩余冷却时间（**只回显掩码 `***abcd`，不输出 key 原文**）。

### 🔐 访问与安全

| 变量 | 说明 |
|---|---|
| `ACCESS_PASSWORD` ⭐ | 访问口令，不配则任何人可打开页面 |
| `RATE_LIMIT_PER_MIN` | 每 IP 每分钟请求上限，默认 `60` |
| `CORS_ORIGIN` | 允许跨域的来源，不配则不放行跨域 |

### 💬 Telegram 机器人

| 变量 | 说明 |
|---|---|
| `TG_BOT_TOKEN` ⭐ | 从 [@BotFather](https://t.me/BotFather) 拿到的 token |
| `TG_WEBHOOK_SECRET` ⭐ | Webhook 校验密钥，用 `openssl rand -hex 24` 生成；改了必须重跑 `action=set` |
| `TG_ALLOWED_CHAT_IDS` ⭐ | 允许使用的 chat id（个人/群），英文逗号分隔。**注意群聊 id 是负数**。填错是「机器人完全没反应」的头号原因 |
| `TG_SETUP_KEY` ⭐ | `/tg-setup` 自诊断端点的口令。不配则回退用 `TG_WEBHOOK_SECRET`；两个都没有则端点**关闭** |
| `TG_PUBLIC_BASE_URL` | 自定义域名/反代场景下，用于推导注册的 webhook 地址，如 `https://chat.example.com`。不配则用请求 origin |
| `TG_API_TIMEOUT_MS` | 调用 Telegram API 超时，默认 `15000` |
| `TG_WEBHOOK_BUDGET_MS` | 单次 webhook 内 Agent 循环的时间预算，默认 `55000`（Cloud Functions 上限 120s，取值 10000~240000） |
| `TG_HISTORY_ROUNDS` | Telegram 对话保留的上下文轮数，默认 `10` |
| `TG_BOT_USERNAME` | 机器人用户名（可选，不填则首次收到群 `@` 消息时自动调 `getMe` 识别并缓存） |
| `TG_GROUP_REPLY_ALL` | 群聊默认仅在 `@机器人`、回复机器人消息或发 `/` 命令时触发；设 `1` 改为群内全量接话 |

### 🗄️ 存储（Blob / KV）

| 变量 | 默认 | 说明 |
|---|---|---|
| `STORAGE_BACKEND` | `blob` | 本项目定死 Blob。拼错也按 `blob` 处理；`kv` 仅 Edge Functions 可用；`none` 强制纯内存 |
| `EO_BLOB_NAMESPACE` | `edgeone-chat` | Blob 命名空间名，首次使用自动创建（只允许字母/数字/下划线/连字符，UTF-8 ≤ 64 字节） |
| `BLOB_CONSISTENCY` | `strong` | 读取一致性。**建议别动**：SDK 默认 `eventual` 会导致「刚写完读不到」（随机失忆、刚转存的图片 404） |
| `BLOB_AUTOPROVISION` | `1` | 首个请求时自动创建并校验命名空间。设 `0` 关闭（冷启动零写入） |
| `STORAGE_DEBUG` | 不输出 | 设 `1` 后 `/healthz` 附带排障详情（存储后端 + `keyPool` 密钥池状态）；再加 `?probe=1` 真实读写一次 |
| `EO_BLOB_BINDING` | 不填 | 逃生口：注入自建 Store 实例（一般不需要） |
| `EO_KV_BINDING` | 自动发现 | 仅 `STORAGE_BACKEND=kv` 时有意义；任意绑定名都能被自动识别 |

### 🎨 生图（图像接口）

支持任何 OpenAI 风格的 `…/images/generations` 接口，例如 SenseNova 日日新：

```
API_URL_1 = https://token.sensenova.cn/v1/images/generations
API_KEY_1 = sk-xxxxxx
MODEL_1   = sensenova-u1.5-fast:日日新 U1.5 Fast
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `IMAGE_PERSIST` | `1` | 是否转存到自己存储。设 `0` 则直接用上游链接（省存储，但 24 小时后失效） |
| `IMAGE_MAX_MB` | `8` | 单张转存上限，超过则退回上游链接 |
| `IMAGE_TIMEOUT_MS` | `600000` | 下载上游图片的超时 |
| `IMAGE_RESPONSE_FORMAT` | `url` | 请求上游时的 `response_format` |
| `IMAGE_SIZE` | 不发送 | 如 `2048x2048`（32 的倍数，512~4096，比例 ≤ 3:1） |
| `IMAGE_OUTPUT_FORMAT` | 不发送 | `png` / `jpeg` / `webp` |
| `IMAGE_WATERMARK` | 不发送 | 设 `false` 去掉日日新水印（公测期免费）；**不设则用上游默认值（带水印）** |
| `IMAGE_PROMPT_EXTEND` | 不发送 | 设 `false` 关闭提示词自动润色 |

> `IMAGE_WATERMARK` / `IMAGE_PROMPT_EXTEND` 不配置时**不会出现在请求体里**，
> 避免对参数校验严格的其它图像接口返回 400。

推荐的 SenseNova 配置：`IMAGE_SIZE=2048x2048`、`IMAGE_OUTPUT_FORMAT=png`、`IMAGE_WATERMARK=false`。

修复过的三个坑：① 原实现只认 `data[0].url`，而上游默认返回 `b64_json` → 永远「生成失败」；
现显式声明 `response_format: "url"` 并兼容 `url` / `b64_json` / `choices[].message.content` 三种形态。
② base64 内联进 Markdown 会撑爆 localStorage（约 5MB 配额）→ 现转存 Blob/KV 返回
`/api/img/<id>` 永久链接（`GET /api/img/<id>` 公开访问，随机 id 防枚举，防路径穿越，
`Cache-Control: public, max-age=31536000, immutable`）。③ 上游 URL 是 24 小时临时链接 →
默认下载转存到自己域名，永久有效。

### 🧠 Agent 模式调优

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEB_AGENT_TIMEOUT_MS` | `90000` | Web 端单轮 Agent 时间预算（≤120000，受函数 120s 上限约束） |
| `AGENT_TIMEOUT_MS` | `240000` | Agent 整体超时 |
| `AGENT_MAX_STEPS` | `6` | 单轮最大工具调用步数 |
| `AGENT_CONTEXT_BUDGET` | `24000` | 上下文预算（token） |
| `AGENT_TOOL_TIMEOUT_MS` | `30000` | 单个工具调用超时 |
| `AGENT_STREAM_UPSTREAM` | — | Agent 是否流式透传上游输出 |
| `AGENT_TOOL_CACHE` | `1` | 只读工具 L1 内存 TTL 缓存与同参并发去重（默认开启，设 `0` 关闭） |

---

## 三、Telegram 机器人

### 群组 `@` 回复设置

1. **在 `@BotFather` 关闭隐私模式**：向 [@BotFather](https://t.me/BotFather) 发送 `/setjoingroups` 设为 `Enable`，再发送 `/setprivacy` 设为 **`Disable`**（否则 Telegram 官方不会把群内普通 `@` 消息推给 Webhook）。若机器人已在群里，修改后需**移出群组重新拉入**（或直接把机器人设为群管理员）方能生效。
2. **获取负数群 ID 并加入白名单**：把机器人拉入群聊随便发一条消息，访问 `https://<你的域名>/tg-setup?key=<TG_SETUP_KEY>`，从 `topHint` 复制带负号的群 `chat_id`（如 `-1001234567890`），填入环境变量 `TG_ALLOWED_CHAT_IDS`（多个 ID 用英文逗号分隔）并重新部署。
3. **群内触发方式**：群聊默认仅在 **`@机器人用户名` 提问**、**引用回复（Reply）机器人的消息** 或 **发送 `/start`、`/model`、`/clear` 等命令** 时触发，并自动引用原消息回复；群友日常闲聊会自动静默忽略（记录为 `group_not_mentioned`）。

### 排查顺序（机器人不响应时）

`setWebhook` 返回 `ok:true` 只说明**请求被接受**，它不校验 URL 是否可达、
`secret_token` 是否与后端一致。而本项目的 `/tg-webhook` 为避免 Telegram 无限重试，
绝大多数分支都返回 200 —— 配置错了机器人就完全静默。
`/tg-setup` 就是为了消灭这段静默。

**第 0 步：确认函数真的部署上去了**

```bash
curl -s https://<你的域名>/healthz   # 期望 storage 为 blob:edgeone-chat
```

**第 1 步：直接打 webhook，看状态码**（区分「路由问题」与「逻辑问题」）

```bash
curl -i -X POST https://<你的域名>/tg-webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: <你的 TG_WEBHOOK_SECRET>' \
  -d '{"update_id":1}'
```

| 你看到的 | 含义 |
|---|---|
| `200` + body `OK` | 路由与 secret 正常，问题在业务分支 → 第 2 步 |
| `403` | secret 不匹配：`TG_WEBHOOK_SECRET` 改过却没重跑 `action=set`，或请求头没带 |
| `404` | 请求没进函数：检查域名、路径拼写、函数是否部署成功 |
| `500` | 请求体解析失败或函数内部抛错 |

**第 2 步：打开体检报告** `https://<你的域名>/tg-setup?key=<TG_SETUP_KEY>`，
重点看：`topHint`（一句话中文结论，被白名单拦下时会直接报出**真实 chat_id**，
复制进 `TG_ALLOWED_CHAT_IDS` 即可）、`webhook.lastErrorMessage`
（`403 Forbidden` = secret 不一致）、`webhook.urlMatches`
（`false` = 注册地址 ≠ 实际地址，自定义域名请配 `TG_PUBLIC_BASE_URL`）、
`hints[]`（`level: fatal` 的就是拦路的那条）。

**第 3 步：对照高频根因**

| 线索 | 根因与修法 |
|---|---|
| `topHint.code = chat_not_allowed` | **头号原因。** 被 `TG_ALLOWED_CHAT_IDS` 拦下，报告里有真实 chat_id，填进去 |
| `hints` 里有 `no_models` | 没解析到模型，在**同一环境**配 `API_URL_1 / API_KEY_1 / MODEL_1` |
| `hints` 里有 `no_bot_token` | `TG_BOT_TOKEN` 没配进 Cloud Functions 环境变量（不是只写本地 `.env`） |
| `lastErrorMessage` 含 `403` | secret 改过但没重绑，重跑 `action=set` 对齐两边 |
| `urlMatches = false` | 注册地址 ≠ 实际地址，配 `TG_PUBLIC_BASE_URL` 后重绑 |
| `pendingUpdateCount > 0` | 更新堆积但投递失败，修好后用 `action=set&drop=1` 清积压 |
| `hints` 里有 `tg_unreachable` | 函数出网到 `api.telegram.org` 不通，需反代或换部署区域 |
| 报告正常但仍不回 | 看 `diag.events` 最近几条的 `reason`；`counters.received = 0` 说明请求压根没到函数，回第 1 步 |

### `/tg-setup` 完整能力

| 调用 | 作用 |
|---|---|
| `/tg-setup?key=K` | 体检报告（`getMe` + `getWebhookInfo` + 本地配置 + 进程内事件） |
| `&action=set` | 绑定 webhook（自动带 `secret_token` 与 `allowed_updates`） |
| `&action=set&drop=1` | 绑定并**丢弃积压更新**，避免修好后旧消息被补发 |
| `&action=delete` | 解绑 webhook |
| `&action=test` | 往白名单第一个会话发连通性自检消息 |
| `&action=diag` | 只看进程内事件 |

> `diag` 是**进程内观测**：Cloud Functions 会扩缩容与实例复用，它只反映
> 「处理这个诊断请求的实例」看到的事件。跨实例看全量请用 Makers 控制台日志。
> 响应里**绝不回显 bot token 原文**（只回 `bot_id` 与密钥长度）。

---

## 四、存储

三句话讲清官方文档没直说、但踩过才知道的事：

1. **Blob 的创建是完全自动的**，本项目还把它从「首次写入时顺带发生」提前到**首个请求时主动确认**。
2. **Blob 没有「绑定」这一步**：控制台对 Blob **只读**（看命名空间列表、浏览对象目录），
   创建与数据操作都走 SDK。所以代码里不需要认绑定名。
3. **KV 才是需要「绑定」的那个**（控制台手动开通 + 建命名空间 + 绑定），但**绑定名可自动发现**。

本项目**定死用 Blob**，Blob 不可用时如实报 `memory`，**不会**悄悄换成 KV
（KV 的最终一致性与 key 字符集限制是隐性差异，静默降级只会让问题更难排查）。

| 环节 | Blob（本项目在用） | KV（备选） |
|---|---|---|
| 开通 | 不需要 | 控制台点一次「立即申请」 |
| 创建命名空间 | **自动** | 只能控制台手动创建 |
| 绑定到项目 | **不存在这一步** | 控制台手动绑定，但绑定名可自动发现 |
| 部署前预创建 | **可以**（`npm run bootstrap:blob`） | 不可以 |
| 可运行于 | Cloud Functions 与 Edge Functions | **仅 Edge Functions** |

> 纠正一个网上流传的说法：官方示例里的 `@tencent/pages-blob` 在 npm 上**不存在**
> （404）。真实包名是 `@edgeone/pages-blob`（当前 `0.0.18`，2026-09-25 发布）。

### `STORAGE_DEBUG=1` 时 `/healthz` 的排障字段

| 字段 | 用途 |
|---|---|
| `provision.state` | `ready` 已创建并校验 / `pending` 进行中 / `failed` 失败（看 `error`）/ `disabled` 被 `BLOB_AUTOPROVISION=0` 关掉 |
| `blobError` | Blob 为什么没接上（最常见是依赖没装上） |
| `lastStorageError` | 最近一次读写错误的 `op` / `code` / `message` / `hint`。**很关键**：上层把异常当「读不到」处理，「配额满了」会伪装成「知识库是空的」，这里把它摊开 |
| `mode` | 回显 `STORAGE_BACKEND` 原始取值（拼错时给 `warning`） |
| `keyPool` | 每个模型下各 key 的掩码、连续失败次数、上次状态码与剩余冷却毫秒数。**不回显 key 原文** |

**默认关闭**，避免对外暴露内部信息。

### 关于改名：`cloudflare-chat` → `edgeone-chat`

| 位置 | 变化 | 影响 |
|---|---|---|
| Blob 命名空间 | 默认名改为 **`edgeone-chat`** | 命名空间 = 数据边界，**换名等于换一个空库**。旧数据没删，还在旧命名空间里；需要时设 `EO_BLOB_NAMESPACE=cloudflare-chat` 重新部署 |
| PWA 缓存/名称/页面标题/品牌名 | `EdgeOne-Chat`（简称 `EO-Chat`） | 需重新安装 PWA 更新桌面图标名 |
| User-Agent | `EdgeOne-Chat/7.0` | 工具调用（网页抓取、维基、汇率）对外标识 |
| 浏览器本地存储键 | `cfchat_*` → **`eochat_*`** | **已配自动迁移**：读到旧键就搬到新键，老用户聊天记录不丢（幂等） |
| `CF-Connecting-IP` 请求头 | **未改** | 这是协议头名不是品牌名，改了 IP 限流失效 |

---

## 五、与原版的实际差异（改动清单）

| # | 位置 | 改了什么 |
|---|---|---|
| 1 | `cloud-functions/index.js`、`[[default]].js` | 新增：EdgeOne 文件路由 + `onRequest(context)`（原版是 `export default { fetch }`） |
| 2 | `_app/entry.js` | 新增（由 `_worker.js` 改造）：适配 `(request, env, ctx)`；`/healthz` 增加 `runtime`/`storage` 字段 |
| 3 | `_app/store/` 下 3 个文件 | 新增：R2 → Blob / KV 适配层。**核心思路**：提供接口一致的 R2 替身挂到 `env.R2`，于是调用 `env.R2` 的 8 个文件**一行没改** |
| 4 | `_app/rate-limit.js` | IP 头增加 `EO-Connecting-IP`、`X-Real-IP`（原 `CF-Connecting-IP` 保留） |
| 5 | `_app/channel.js` | 模型配置缓存增加「配置签名」校验（Cloud Functions 实例复用，改变量后旧实例可能持旧配置） |
| 6 | `wrangler.toml` → `edgeone.json` | 构建/函数时长（120s）/响应头配置 |
| 7 | `package.json` | 去掉 `wrangler`，加入 `@edgeone/pages-blob`；`dev` 改为 `edgeone makers dev`；新增 `bootstrap:blob` |
| 8 | `_app/images.js` 等 | 生图链路重写：转存 + `/api/img/<id>` 永久链接（见第二节 🎨） |
| 9 | `_app/channel.js`、`entry.js`、`constants.js` | 图像请求/响应解析重写：兼容 `url` / `b64_json` / `choices[].message.content` |
| 10 | `_app/ui/` 下 3 个文件 | 图片渲染器 + 样式 + localStorage 配额兜底 |
| 11 | `edge-store.js`、`entry.js` | 后端**定死 Blob**；首个请求自动创建并校验命名空间；`/healthz?probe=1` 真实读写自检 |
| 12 | `blob-backend.js` | 读显式传 `consistency: "strong"`；错误码记录 + 中文提示；写失败不再静默 |
| 13 | `scripts/bootstrap-blob.mjs` | 新增：部署前用 token 模式预创建命名空间（可进 CI） |
| 14 | 全局 | 更名 `cloudflare-chat` → `edgeone-chat`（包名、标题、品牌、PWA、UA、命名空间） |
| 15 | `_app/telegram/diag.js`、`setup.js` | 新增：`/tg-setup` 自诊断端点 + 进程内事件留痕（`setWebhook` 成功 ≠ 链路可用，原实现全分支回 200 导致配置错了完全静默） |

| 16 | `_app/channel.js`、`entry.js`、`agent/loop.js`、`telegram/handler.js` | **多密钥加固**：新增密钥池健康状态 + 失败换 key 重试（仅 `401/402/403/429`）+ 指数退避熔断；未配置密钥时不再发送畸形的 `Authorization: Bearer `（兼容 Ollama 等免密钥网关）；同名模型在同一 `API_URL` 下合并密钥池；`/healthz` 增 `keyPool` 掩码排障 |

**其余 40 个文件（UI、PWA、SSRF 防护、Agent 循环、工具链、Telegram 处理器）均为原样复制。**

---

## 六、已知限制与取舍

1. **`list()` 不返回对象体积**：知识库文档列表的「大小」统一显示 1 KB（日期是正确的，取自 frontmatter）。
   不值得修 —— 拿体积要每个 key 一次请求，50 篇文档就从 1 次变成 51 次；真正在意的话把字节数写进 frontmatter。
2. **KV key 上限 512 字节**：本适配层用十六进制转义，纯中文标题超约 80 字会写入失败并抛明确错误。**Blob 无此限制。**
3. **一致性是主动取舍**：已在 `get` / `list` 显式传 `consistency: "strong"`（防随机失忆），
   代价是读延迟略高。可用 `BLOB_CONSISTENCY=eventual` 换速度。
4. **`get` 的 `range` 是模拟的**：读全量后切片，仅用于读 frontmatter 前 4096 字节，代价可接受。
5. **Cloud Functions 跑在云端地域（默认广州）而非边缘节点**：瓶颈在上游大模型 API，影响很小。
6. **Blob 不建议当公网图床**：`/api/img/<id>` 每次经函数中转读 Blob，属于「运行时取用」而非分发；
   图片量大后会成为带宽与函数耗时瓶颈，大规模分发请用对象存储/CDN。
7. **免费版单账户 Blob 容量 1GB**：约 300 张 2K 图或约 100 万字 Markdown。
   超限抛 `QUOTA_EXCEEDED`，会记录到 `/healthz` 的 `debug.lastStorageError`。
8. **Telegram 出错仍回 200**：原版取舍，沿用。回 500 会让 Telegram 按退避策略重投同一条更新
   （最长约 24 小时），代价是更新被永久丢弃；本项目补上可观测性（`tgNote('error')` →
   `/tg-setup` 的 `diag.lastError`）。唯一例外：请求体不是合法 JSON 时回 500（调用方问题，重试安全）。
9. **`_app/` 不参与路由**依赖平台对下划线前缀的忽略规则；即使被生成路由也只影响 `/_app/*`，不影响功能。
10. **图像接口是同步的**：生成期间前端一直显示「正在生成」，属正常；只做转存+渲染，无缩略图/压缩。
11. **key 池不跨服务商**：多个 key 必须属于同一个 `API_URL_i`，跨厂商要另开通道。另外
    逗号分隔的写法无法表达「key 本身含逗号」，这种极少数情况请用 `API_CONFIG` 的
    `keys` 数组写法。
12. **熔断状态是进程内的**：冷却记录存在函数实例内存里，实例回收后重置；多实例部署时
    各实例的冷却进度不共享（但重试本身每个实例都会做，不影响最终可用性）。

---

## 七、本地自检

无需 EdgeOne 环境、无需安装依赖（装了会额外走真实 SDK 路径）：

```bash
node scripts/selfcheck.mjs      # 或 npm run selfcheck
```

覆盖 **148 项用例**：模块图加载、R2 契约在双后端的一致性、一致性断言（`strong`
是否真带上）、错误可见性（`QUOTA_EXCEEDED` 记录但不破坏上层）、KV key 编码、
路由、模型解析、Blob 默认后端与命名空间自动创建、KV 绑定自动发现、
`/healthz` 排障输出、生图链路（含 5 种响应形态）、页面内联脚本合法性、
品牌改名断言（15 个关键文件不许再出现 `cloudflare`）、浏览器键名迁移行为测试、
密钥池（多 key 解析与合并、401/429 换 key 重试、400/5xx/网络异常不重试、
指数退避冷却、冷却后不再被选中、尝试次数上限、掩码不回显原文、
`API_KEY_ROTATE=0` 逃生口、端到端 401 自愈与免密钥请求头）、
Telegram 自诊断（含「无模型时仍对 Telegram 回 200」「白名单拦下记录真实 chat_id」
等静默契约断言）、双后端端到端（记忆/知识库/检索各跑一遍）。

本地起服务调试（需 `npm i -g edgeone`）：`edgeone makers dev`

---

## 八、排障速查

| 现象 | 原因与处理 |
|---|---|
| `storage` 是 `memory` | 持久化未接通。`STORAGE_DEBUG=1` 看 `debug.blobError`：`Cannot find package '@edgeone/pages-blob'` = 依赖没装，检查安装命令；`Missing: deployCredential` = 不在 Makers 环境里跑。另确认 `STORAGE_BACKEND` 不是 `none`/拼错 |
| `provision.state` 是 `failed` | 看 `debug.provision.error`：`QUOTA_EXCEEDED` = 1GB 满了；`INVALID_STORE_NAME` = 命名空间名非法；`CREDENTIAL_ERROR` = 平台凭证问题，重部署一次 |
| 接通了但重启后数据丢 | `/healthz?probe=1`（需 `STORAGE_DEBUG=1`）真实读写一次；`ok:false` 看 `reason` |
| 知识库突然「空了」 | 看 `debug.lastStorageError`：配额满/被限流会伪装成「空」 |
| 刚存的文档搜不到 / 刚生成的图裂开 | `BLOB_CONSISTENCY` 被改成 `eventual` 了，删掉或设回 `strong` |
| 改名后知识库/记忆/图片全不见 | 命名空间换了，新库是空的。旧数据还在旧命名空间，设 `EO_BLOB_NAMESPACE=cloudflare-chat` 重部署可切回 |
| 改名后浏览器历史对话没了 | 有自动迁移，理论上不该发生。确认页面已更新（旧 SW 缓存的旧页面读旧键）；看 localStorage `eochat_sessions` 是否有值 |
| 改名后 PWA 图标名还是旧的 | 需重新「添加到主屏幕」；改名前的旧前缀缓存不会自动清，可手动清一次浏览器缓存 |
| 想用 KV 但一直是 `memory` | KV 需三步：控制台开通 → 建命名空间 → 绑定到项目；且 **KV 仅 Edge Functions 可用**，默认 Cloud Functions 请用 Blob；另需显式设 `STORAGE_BACKEND=kv`（不自动降级） |
| 页面提示「未配置模型」 | 变量没配或没重部署；`MODEL_1` 格式是 `模型ID:显示名`，多个用英文逗号分隔 |
| 配了多个 key 仍偶尔报 401/429 | 已内置换 key 重试（单次最多试 3 个）。仍频繁报错说明可用 key 不够：`STORAGE_DEBUG=1` 看 `/healthz` 的 `debug.keyPool`，看哪个 key 在冷却、上次是什么状态码 |
| 想临时关掉换 key 重试 | 设 `API_KEY_ROTATE=0` 重新部署 |
| key 里本身含英文逗号 | 逗号分隔的写法无法表达，改用 `API_CONFIG` 的 `keys` 数组写法（见第二节 🔑 多密钥） |
| 只配 `API_URL` 不配 `API_KEY` 报 401 | 现在**不会再发送** `Authorization` 头（兼容 Ollama 等免密钥网关）；仍报 401 说明该上游确实需要密钥，补上 `API_KEY_1` |
| 多 key 想用在**不同**服务商上 | 不行：key 池绑定同一个 `API_URL_i`。请用 `API_URL_2 / API_KEY_2 / MODEL_2` 另开通道 |
| Telegram 不响应 | 先看 `/tg-setup?key=<TG_SETUP_KEY>` 的 `topHint`（见第三节） |
| Agent 长任务中途中断 | `edgeone.json` 里 `maxDuration` 被改小，保持 120；`WEB_AGENT_TIMEOUT_MS` ≤ 120000 |
| 文档列表体积都显示 1 KB | 预期行为，见第六节第 1 条 |
| 生图「未返回任何图片」 | 上游响应结构不在兼容范围，看提示里的原始响应片段 |
| 生图「未能转存」 | `/healthz` 看 `storage` 是否为 `memory`，或图片超过 `IMAGE_MAX_MB` |
| 生成的图第二天全裂了 | 走的是上游临时链接：确认 `IMAGE_PERSIST` 不是 `0` 且存储已接通 |
| 生图有水印 | `IMAGE_WATERMARK=false` 重部署（日日新公测期去水印免费） |
| `/` 正常但 `/api/chat`、`/sw.js` 404 | 平台没把根级 `[[default]].js` 当兜底路由：移到 `cloud-functions/api/[[default]].js` 并在 `edgeone.json` 配 `rewrites`，或在控制台把该函数路由配成 `/*` |
| `/tg-webhook` 返回 404 | 同上，先确认兜底路由生效（`/tg-setup` 返回 403 即说明路由通了） |

### 路由约定（部署前确认）

本项目依赖两条路由：`/` 由 `index.js` 处理，其余全部由根级 `[[default]].js` 兜底
（按 EdgeOne 官方 `[[default]].js` 多级动态路由语义设计）。
部署后依次访问 `/healthz`、`/manifest.webmanifest`、`/icon-192.png` 确认兜底路由生效。
