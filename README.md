# Qoder CLI Proxy

把 Qoder CLI 订阅转换为本机 OpenAI / Anthropic 兼容 API 的多账号网关。

[English](README.en.md)

## 免责声明

本项目仅用于个人账号的本地兼容性实验与协议适配研究。
使用者必须自行持有合法的 Qoder 账号和 Personal Access Token。
本项目不提供、共享、转售、出租任何 Qoder 账号、Token 或额度。
不得将本项目部署为公网服务、公益站、商业 API、中转站或多人共享服务。
不得用于规避 Qoder 官方的计费、风控、速率限制、地域限制或使用限制。
请遵守 Qoder 官方服务条款；如官方不允许，请立即停止使用。
本项目与 Qoder 官方无关。

## 项目定位

本项目把 Qoder CLI（`qoderclicn` 或 `qodercli`）适配为仅供本机访问的 OpenAI / Anthropic 兼容 HTTP 接口。对话执行统一由 [@qoder-ai/qoder-agent-sdk](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk) 驱动，SDK 底层拉起同一 CLI 进程并由预热池加速；上层提供完整的多账号网关能力（调度、配额、审计、控制台）。

它不是官方 API，不代表 Qoder 官方授权，也不提供任何账号、Token 或额度服务。所有请求都依赖使用者自行配置的个人 Qoder 认证。

支持两个后端：

- **CN 后端**：`qoderclicn`，对接 qoder.com.cn
- **Global 后端**：`qodercli`，对接 qoder.com

## 核心特性

- **多账号池**：多个 Qoder 账号（各自 PAT，AES-256-GCM 加密入 SQLite）加权随机调度；实际权重 = 配置权重 × 额度因子（剩余额度 / 总额度），额度耗尽的账号权重自动归零；支持并发上限、失败自动切换、指数退避冷却，额度耗尽类持久错误首次失败即冷却 1 小时
- **额度与倍率**：走 SDK 控制协议查询每个账号的剩余额度明细（流式入不产出消息，零 credits 消耗），服务端每 10 分钟后台预刷新快照；模型列表附带 credit 倍率（`rate` / `is_free`）
- **预热进程池**：常驻少量预热 CLI 进程，热响应约 3 秒（冷启动 12-17 秒），用完即弃、无跨请求上下文共享
- **用户与密钥**：多网关用户，按用户发放 `qk-` 前缀 API Key，按用户授权可用账号与配额（日/月、请求数/token 数），密钥创建后可查看明文（加密副本入库）
- **调用审计**：每次调用记录模型、账号、用户、token 用量、耗时与错误码（SQLite，不存 prompt 正文）
- **双协议出口**：OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`，均支持流式与工具调用字段适配
- **管理控制台**：账号、用户与密钥、用量统计、测试对话、调用测试、系统设置

## 快速开始

需要 Node.js 18+。

**第 1 步：安装 CLI**

CN 后端（必须）：

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

Global 后端（可选）：

```bash
npm install -g @qoder-ai/qodercli
qodercli --version
qodercli login   # 必须登录一次
```

**第 2 步：配置（可选）**

```powershell
npm install
```

`.env` 不是必需的：不存在时首次启动会以 `.env.example` 为模板自动创建（不写入任何密钥——网关访问凭据统一在管理台「用户密钥」中按用户签发）。

也可以手动创建后编辑 `.env`：

```powershell
Copy-Item .env.example .env
```

```env
# 选择后端: "cn" 或 "global"
CLI_BACKEND=cn
```

修改 `.env` 后重启服务即可生效。管理台「系统设置」页保存的配置会同步写回 `.env`。

> **Qoder 账号的 PAT 无需写入 `.env`。** 启动后在管理台「账号管理」页添加账号并填入 PAT，
> 每个账号的 PAT 会以 AES-256-GCM 加密存入 SQLite，多账号加权调度、互不干扰。
> CN 版 PAT 创建入口：https://qoder.com.cn/account/integrations

请妥善保存 Token。不要将 `.env` 提交到 Git，也不要把 Token 填入第三方客户端或分享给他人。

**第 3 步：启动**

```powershell
npm start
```

Windows 也可以双击 `start-proxy.cmd`。默认地址 `http://127.0.0.1:1300`（`PORT` 可改）。

首次启动会自动创建 `data/` 目录（SQLite 数据库 + AES 主密钥）并执行建表迁移，同时创建默认管理员账号：

> **默认管理员为 `admin` / `admin123`。首次登录时会强制弹出「修改初始密码」流程，未修改前管理接口一律拒绝访问，因此无需依赖手动自觉。** 修改默认密码前，不要把代理绑定到非 loopback 地址。

**第 4 步：验证**

```powershell
curl.exe http://127.0.0.1:1300/health
curl.exe http://127.0.0.1:1300/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"reply OK\"}]}"
```

看到模型回复即链路打通。管理控制台在 `http://127.0.0.1:1300/ui`（快捷启动 `.\start-ui.cmd` 自动打开浏览器）。

## 使用教程：从零到第一次真实对话

快速开始让服务跑起来了，本节带你走完从空库到可用的全过程。

### 第 5 步：登录控制台并修改默认密码

1. 打开 `http://127.0.0.1:1300/ui`，用 `admin` / `admin123` 登录
2. 首次登录会**强制弹出**「修改初始密码」：至少 8 位，且不能与默认密码相同，无法跳过
3. 未改密码前，除改密/登出/会话信息外的所有管理接口一律返回 `403 default_password`

### 第 6 步：添加 Qoder 账号

1. 进入「账号管理」→「添加账号」，填写名称与 PAT（CN 版创建入口：https://qoder.com.cn/account/integrations）
2. 保存后点「验证」——加载模型目录，零 token 消耗
3. 「剩余额度」查看分桶明细（服务端每 10 分钟后台自动刷新）
4. 按需调整权重与并发上限；PAT 全程加密存储，页面只显示指纹

### 第 7 步：测试对话

- 「测试对话」页选择账号直接发送消息（可切流式 / 非流式），确认上游链路正常
- 「调用测试」页粘贴 `qk-` API Key，走完整网关链路（鉴权 → 调度 → 配额 → SDK 调用）

### 第 8 步：接入你的客户端

见下一节「接入客户端」：OpenAI 兼容客户端填 Base URL 与 `qk-` API Key 即可；Anthropic 系客户端设置两个环境变量即可。

## 接入客户端

### OpenAI 兼容接口

- Base URL：`http://127.0.0.1:1300/v1`
- API Key：填写管理台「用户密钥」签发的 `qk-` 密钥；一个密钥都不存在时网关对本机开放，可填任意占位值（如 `not-used`）
- Model：从 `/v1/models` 返回列表选择，或手动输入模型 ID

不要将 Qoder Token 填入客户端。Token 只应保存在本机数据库中（管理台添加账号时写入，AES-256-GCM 加密）。

### Anthropic 兼容接口

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:1300"
$env:ANTHROPIC_AUTH_TOKEN = "你的 qk- 密钥"   # 一个密钥都不存在时填任意值
```

`ANTHROPIC_BASE_URL` 不要追加 `/v1`，客户端通常会自动拼接 API 路径。

### OpenCode 示例

仓库自带 `opencode.json` 配置文件，可用于本地兼容性验证：

```powershell
opencode run --model qoder-cn-local/qwen3.8-max --variant high "reply OK"
```

如果签发过 `qk-` 密钥，需要把 `opencode.json` 里 `options.apiKey` 的 `not-used` 换成你的密钥。

## 管理控制台

启动后访问 `http://127.0.0.1:1300/ui`。登录凭据保存在本机 SQLite 中；未被授权任何账号的普通用户不可调用网关。

| 页面 | 说明 |
|-----|------|
| 仪表盘 | 今日 / 累计调用量、账号与密钥概览 |
| 账号管理 | 添加 Qoder 账号（PAT 加密入库）、验证（加载模型目录，零 token 消耗）、剩余额度查询（分桶明细，后台自动预刷新）、权重 / 并发上限 / 冷却状态 |
| 用户与密钥 | 网关用户创建与管理、`qk-` API Key 发放与吊销、按用户授权账号与配额 |
| 用量记录 | 按天 / 模型 / 用户 / 账号多维统计与调用明细 |
| 测试对话 | 指定账号真实对话测试（流式 / 非流式切换） |
| 调用测试 | 粘贴 API Key 走完整网关链路（鉴权 → 调度 → 配额 → SDK 调用） |
| 系统设置 | 可视化编辑运行配置（端口、监听地址、CLI 线路等），保存后自动重启生效 |

用量数据保存在本机 SQLite（`data/qoder-proxy.db`），只记录元数据（模型、token 数、耗时、错误码），**不保存 prompt 与响应正文**；token 数部分来自上游返回、部分为本地估算（标记 `estimated`），不宣称准确。控制台不显示 PAT 明文（仅显示指纹）。

## 工作原理

`qoderclicn` 和 `qodercli` 是命令行工具，接受文本输入并返回文本输出；许多本地客户端期望 OpenAI 或 Anthropic 格式的 HTTP API。本项目作为本地适配层：接收兼容格式请求，经 Agent SDK 转换为 CLI 会话调用（prompt 走 stdin 流式协议，预热池提供热进程），再把 CLI 输出整理为兼容格式响应。

支持两种本地协议格式：

- **OpenAI 兼容格式**：`/v1/chat/completions`
- **Anthropic 兼容格式**：`/v1/messages`

两种格式均支持工具调用字段适配（`tool_calls` / `tool_use`），用于协议兼容性研究。可靠性取决于底层模型是否能稳定输出符合格式的 JSON。

### 工具调用实现方式

由于 CLI 本身只处理文本，不具备原生工具调用通道，本项目采用 Prompt 格式指令 + 输出解析的方式实现工具调用适配：将工具定义作为格式说明加入请求上下文，再从模型文本输出中提取 JSON。

这与直接调用 OpenAI、Anthropic、DeepSeek 等官方 API 不同。官方 API 通常提供原生 `tools` 参数通道；本项目只能做文本层面的协议模拟，因此不应把它视为等价替代。

### 流式输出

当客户端请求 `stream: true` 时，本项目使用 CLI 的 `--output-format stream-json` 进行增量流式输出，并以 SSE 事件实时转发。

包含工具参数的请求同样实时流式：回复的文本部分经过"安全门控"立即转发——门控暂扣仍可能长成工具调用 JSON 块的尾部（未闭合或已闭合的 ` ```json ` 围栏、未配平或含 `"tool_calls"` 的 JSON 对象、末尾的反引号前缀）；流结束后暂扣部分被解析，工具调用以结构化 `tool_calls` / `tool_use` 块一次性补齐。因此 Claude Code 等代理客户端可以实时看到执行进度，同时结构化工具调用行为不变。

例外：开启 `SERVER_TOOL_EXECUTION=1`（服务端执行工具）时，带工具的流式请求仍走缓冲路径。

### 当前限制

- 工具调用通过 Prompt 格式指令 + 文本解析实现，非模型原生能力；模型输出非法 JSON 或拒绝工具格式时降级为纯文本
- 流式模式下，工具调用的 JSON 部分在流末尾一次性补齐（不完整的 JSON 无法提前解析）；普通回复里未闭合的代码围栏会暂扣到围栏闭合后再显示（保守门控：宁可延迟显示，绝不把工具 JSON 泄漏为文本）
- 对话请求使用独立 CLI 子进程；默认开启预热进程池消除冷启动（`QODER_WARM_POOL=0` 关闭，关闭后每次请求冷启动 12-17 秒）
- 流式响应中的 usage 不由上游逐 chunk 下发，服务端按 tracker/估算记入用量（`estimated` 标记）

## 配置参考

### 双后端切换

通过 `.env` 中的 `CLI_BACKEND` 切换，切换后重启生效：

| 配置项 | CN 后端 | Global 后端 |
|---------|--------|----------|
| CLI 命令 | `qoderclicn` | `qodercli` |
| 认证方式 | Personal Access Token | `qodercli login`（OAuth） |
| 认证目录 | `~/.qoderworkcn` | `~/.qoder` |
| PAT 配置 | 账号管理页添加（AES-256-GCM 加密入库） | 无需（登录后自动认证） |

### 推理参数

全局默认值（环境变量）：

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

也可在每次请求中通过 `reasoning_effort`、`context_window`、`max_tokens` 参数单独指定。

### 其他环境变量

- `PORT` / `BIND_HOST`：监听端口与地址（默认 `127.0.0.1:1300`）
- `QODERCN_TIMEOUT_MS`：单次请求超时（毫秒）。代理提示词 + 模型排队可能耗时数分钟，建议保持较大值（默认 300000，`.env.example` 示例为 600000）
- `QODERCN_CLI_TOOLS`：默认禁用 CLI 内置工具（追加 `--tools=`），让模型直接回答而不是在代理目录里跑文件/shell 循环。设为 `1` 可恢复
- 预热池：`QODER_WARM_POOL=0` 整体关闭；`QODER_WARM_POOL_SIZE` / `QODER_WARM_POOL_MAX_TOTAL` / `QODER_WARM_POOL_TTL_MS` / `QODER_WARM_POOL_READY_MS` 调节池大小、总量、回收与成熟门槛（详见 `.env.example`）
- 诊断：`LOG_REQUESTS=1` 记录每个失败请求（脱敏后）

### 支持的模型

`qoder-cn`、`auto`、`ultimate`、`performance`、`efficient`、`lite`、`cantus`、`qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-max`、`qwen3.7-plus`、`kimi-k3`、`kimi-k2.7-code`、`glm-5.3`、`glm-5.3-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`minimax-m3`

推理强度别名：`qwen3.8-max-effort-low`、`-medium`、`-high`、`-max`，以及 `qwen3.7-max-effort-low`、`-medium`、`-high`、`-max`

## API 文档

### 认证方式

| 范围 | 认证方式 |
|------|----------|
| `/v1/*`、`/usage/*` | 存在任何 `qk-` API Key 后必须携带；一个密钥都不存在时对本机开放 |
| `/health` | 始终开放 |
| `/admin/*` | 管理会话：`POST /admin/login` 换取 token，后续请求带 `Authorization: Bearer <token>` |
| `/ui` | 浏览器页面，本地 token 存储 |

请求头两种形式任选：

```text
Authorization: Bearer <key>
x-api-key: <key>
```

### 端点总览

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/health` | 无 | 健康检查 |
| GET | `/v1/models` | 网关密钥 | 模型列表（含 credit 倍率） |
| POST | `/v1/chat/completions` | 网关密钥 | OpenAI 兼容对话，支持 tools 字段适配 |
| POST | `/v1/messages` | 网关密钥 | Anthropic 兼容对话，支持 tool_use 字段适配 |
| POST | `/v1/messages/count_tokens` | 网关密钥 | Token 估算 |
| GET | `/usage/local` | 网关密钥 | 本地用量估算 |
| POST | `/usage/reset-local` | 网关密钥 | 重置本地用量统计 |
| POST | `/admin/login` | 无（限速） | 登录管理台，返回 `token` 与 `mustChangePassword` |
| POST | `/admin/change-password` | 管理会话 | 修改密码（默认密码会被强制修改） |
| POST | `/admin/logout` | 管理会话 | 注销当前会话 |

### 请求参数（`/v1/chat/completions`）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `messages` | array | 是 | OpenAI 消息结构（`role` / `content`） |
| `model` | string | 否 | 默认 `qoder-cn`；可选模型见「配置参考」 |
| `stream` | boolean | 否 | 默认 `false`，SSE 增量输出 |
| `tools` | array | 否 | OpenAI tools 结构（文本层适配，见「工作原理」） |
| `reasoning_effort` | string | 否 | `low` / `medium` / `high` / `max`，也支持 `reasoning.effort` 写法 |
| `context_window` | number | 否 | 覆盖上下文窗口 |
| `max_tokens` | number | 否 | 覆盖最大输出 token |

`/v1/messages` 为 Anthropic 标准请求结构（`model` / `max_tokens` / `system` / `messages`），参数同名映射。

### 响应示例

**模型列表** `GET /v1/models`（外壳为标准 OpenAI 格式；条目完整透传 CLI 模型目录的原始 ModelInfo 字段（`priceFactor`/`isFree` 等），仅叠加 `id`/`object`/`created`/`owned_by` 标准四字段）。字段语义：`id`/`value`/`displayName` = 模型显示名称（第三方客户端读 `id` 展示），`modelId` = CLI 内部代号（与 CLI 交互的字段）；对话请求的 `model` 传显示名称或内部代号均可——网关会按目录统一反查回内部代号再调 CLI：

```json
{
  "object": "list",
  "data": [
    {
      "value": "Qwen3.8-Max",
      "displayName": "Qwen3.8-Max",
      "modelId": "Qmodel_38max",
      "priceFactor": 1.0,
      "isFree": false,
      "isReasoning": true,
      "isDefault": false,
      "isEnabled": true,
      "id": "Qwen3.8-Max",
      "object": "model",
      "created": 0,
      "owned_by": "qodercn"
    }
  ]
}
```

**非流式对话** `POST /v1/chat/completions`（思考类模型带 `reasoning_content`，DeepSeek 生态约定）：

```json
{
  "id": "chatcmpl-1760000000000",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "qoder-cn",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好！",
        "reasoning_content": "用户在打招呼，简短回应即可。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20 }
}
```

**流式对话** `stream: true`（SSE，`data:` 行以空行分隔，结束帧为 `data: [DONE]`）：

```text
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"思考过程…"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好！"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Anthropic 口径（`POST /v1/messages` 流式）依次发 `message_start` → `content_block_start` → `content_block_delta`（`text_delta` / `thinking_delta`）→ `content_block_stop` → `message_delta`（`stop_reason: "end_turn"`）→ `message_stop`。

### 错误格式与错误码

OpenAI 口径（`/v1/*` 默认）：

```json
{ "error": { "message": "…", "type": "invalid_request_error", "code": "invalid_request" } }
```

Anthropic 口径（`/v1/messages*`）：

```json
{ "type": "error", "error": { "type": "invalid_request_error", "message": "…" } }
```

常见错误码：

| 状态码 | code | 含义 |
|--------|------|------|
| 400 | `invalid_request` / `invalid_messages` / `unsupported_role` | 请求体或 messages 结构不合法 |
| 401 | `invalid_api_key` | 密钥缺失或错误 |
| 401 | `cli_token_missing` | 没有任何已配置的 Qoder 账号可用 |
| 401 | `unauthorized` | 管理会话未登录或已过期 |
| 403 | `default_password` | 默认密码未修改，管理接口被拒（见首登强制改密） |
| 403 | `no_account_granted` | 该用户未被授权任何账号 |
| 403 | `host_not_allowed` / `origin_not_allowed` | Host / Origin 校验失败（DNS rebinding、跨源防护） |
| 429 | `quota_exceeded` | 用户配额超限（日/月 token 或请求数） |
| 502 | `cli_not_found` / `upstream_error` | CLI 未安装或上游返回错误 |
| 503 | `no_available_account` | 账号池无可用账号（全部冷却或额度耗尽） |
| 504 | `upstream_timeout` | 请求超时 |

## 安全边界

- 默认仅监听 `127.0.0.1`。`BIND_HOST` 可改绑，但绑定非 loopback 地址时启动日志会打印醒目警告
- **浏览器跨源请求一律拒绝**（仅允许本机 loopback 来源）。否则你访问的任意网页都能在后台调用代理、消耗你的 Qoder 额度
- **`Host` 头不是 loopback 的请求一律拒绝**，用于阻断 DNS rebinding（绑定 `0.0.0.0` 且未配置 `ALLOWED_HOSTS` 时该防护失效，启动日志会警告）
- 管理控制台 `/admin/*` 需要登录；登录接口带内存级限速（60 秒内连续失败 5 次锁定 15 分钟）
- 签发任何 `qk-` API Key 后，`/v1/*` 强制校验密钥；本项目**不提供任何免认证读取密钥的接口**
- 账号 PAT 与 API Key 以 AES-256-GCM 加密存放于 `data/`（主密钥 `data/.secret-key`，首次启动自动生成）；`data/` 已被 `.gitignore` 排除，**绝不要提交、备份或分发该目录**
- 日志自动脱敏 token、cookie、Authorization 头等敏感信息；`.env`、`data/`、日志均不纳入版本控制

需要提醒的是：**一个 API Key 都不存在时（未签发或已全部吊销），本机上任何进程都可以使用这个代理。** loopback 绑定挡的是外部网络，挡不住本机。建议在管理台「用户密钥」签发一个。

### 客户端认证（API Key）

在管理台「用户密钥」签发 `qk-` 密钥后，客户端需要在请求头中携带：

```text
Authorization: Bearer <qk-密钥>
```

或者（Anthropic 系客户端习惯）：

```text
x-api-key: <qk-密钥>
```

一个密钥都不存在时不校验（本机开放模式）。`/health` 始终开放，便于脚本探活。

如果你有本机 Web 应用需要从浏览器调用代理，用 `ALLOWED_ORIGINS` 显式放行；如果你确实要用别的主机名访问，用 `ALLOWED_HOSTS`。这两个开关默认为空——一旦使用，安全模型就需要你自己评估了。

### 上游认证方式

| 后端 | 认证方式 | PAT 配置位置 |
|------|--------|--------|
| CN (`qoderclicn`) | Personal Access Token | 账号管理页添加（AES-256-GCM 加密入库，每账号独立） |
| Global (`qodercli`) | OAuth 登录（`qodercli login`） | 无需配置 |

### 服务端工具执行（默认关闭）

`SERVER_TOOL_EXECUTION=1` 会让代理在**你的机器上**执行模型返回的工具调用，而模型是被客户端发来的 prompt 引导的。除非你的客户端确实无法自己执行工具，否则请保持关闭。开启时：

- 文件操作被限制在 `SERVER_TOOL_WORKSPACE`（默认为代理的工作目录），绝对路径和指向外部的符号链接都会被拒绝
- `Bash` 工具额外需要 `SERVER_TOOL_ALLOW_BASH=1` **且** `SERVER_TOOL_BASH_ALLOWLIST` 非空；命令不经过 shell 执行，因此管道、串联、重定向、命令替换都会被拒绝
- Windows 上因为不走 shell，无法执行 `.cmd`/`.bat` 包装（如 `npm`），只能执行真正的可执行文件（`node`、`git`、`python` 等）

请把这个特性当作实验性功能，并且配合 `qk-` API Key 一起使用（签发后 `/v1/*` 强制校验，防止本机任意进程滥用工具执行）。

## 合规与安全

### 禁止用途 / Abuse Policy

- 禁止公网部署
- 禁止多人共享
- 禁止转售 API
- 禁止绕过官方计费、风控、速率、地域或使用限制
- 禁止收集、保存或转发他人的 Token
- 禁止提供、共享、出租、转售任何账号、Token 或额度

### 安全建议

- 只在本机使用，只监听 `127.0.0.1`
- 默认管理员密码（`admin` / `admin123`）在首次登录时被强制要求修改，无法跳过
- 不要绑定 `0.0.0.0`，不要暴露到公网；确需局域网访问时配置 `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` 并签发 `qk-` API Key
- 不要把 Token 或 `data/` 目录（含加密主密钥）发给别人
- 不要把 `.env` 提交到 Git
- 如果怀疑 Token 泄露，立即到 Qoder 官方账号页面吊销 PAT 并重新创建

### 报告安全问题

请不要在公开 issue 里报告漏洞，使用 GitHub 的私密报告入口：[Report a vulnerability](https://github.com/0paquer/qoder-cli-proxy/security/advisories/new)。详见 [SECURITY.md](SECURITY.md)。

## 测试

```powershell
npm test
```

## 许可证

MIT。详见 [LICENSE](LICENSE)。
