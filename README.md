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

**第 2 步：配置**

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`（可选，用于端口与网关鉴权等基础配置）：

```env
# 选择后端: "cn" 或 "global"
CLI_BACKEND=cn

# 网关调用密钥（推荐设置，保护你的 Qoder 额度）
PROXY_API_KEY=
```

> **Qoder 账号的 PAT 无需写入 `.env`。** 启动后在管理台「账号管理」页添加账号并填入 PAT，
> 每个账号的 PAT 会以 AES-256-GCM 加密存入 SQLite，多账号加权调度、互不干扰。
> CN 版 PAT 创建入口：https://qoder.com.cn/account/integrations

请妥善保存 Token。不要将 `.env` 提交到 Git，也不要把 Token 填入第三方客户端或分享给他人。

**第 3 步：启动**

```powershell
npm start
```

Windows 也可以双击 `start-proxy.cmd`。默认地址 `http://127.0.0.1:3000`（`PORT` 可改）。

首次启动会自动创建 `data/` 目录（SQLite 数据库 + AES 主密钥）并执行建表迁移，同时创建默认管理员账号：

> **默认管理员为 `admin` / `admin123`，首次登录后请立即在控制台修改密码。** 修改默认密码前，不要把代理绑定到非 loopback 地址。

**第 4 步：验证**

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"reply OK\"}]}"
```

看到模型回复即链路打通。管理控制台在 `http://127.0.0.1:3000/ui`（快捷启动 `.\start-ui.cmd` 自动打开浏览器）。

## 接入客户端

### OpenAI 兼容接口

- Base URL：`http://127.0.0.1:3000/v1`
- API Key：填写你在 `.env` 中设置的 `PROXY_API_KEY`；未设置时填任意占位值（如 `not-used`）
- Model：从 `/v1/models` 返回列表选择，或手动输入模型 ID

不要将 Qoder Token 填入客户端。Token 只应保存在本机 `.env` 中。

### Anthropic 兼容接口

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "your-PROXY_API_KEY"   # 未设置 PROXY_API_KEY 时填任意值
```

`ANTHROPIC_BASE_URL` 不要追加 `/v1`，客户端通常会自动拼接 API 路径。

### OpenCode 示例

仓库自带 `opencode.json` 配置文件，可用于本地兼容性验证：

```powershell
opencode run --model qoder-cn-local/qwen3.8-max --variant high "reply OK"
```

如果你设置了 `PROXY_API_KEY`，需要把 `opencode.json` 里 `options.apiKey` 的 `not-used` 换成你的密钥。

## 管理控制台

启动后访问 `http://127.0.0.1:3000/ui`。登录凭据保存在本机 SQLite 中；未被授权任何账号的普通用户不可调用网关。

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

- `PORT` / `BIND_HOST`：监听端口与地址（默认 `127.0.0.1:3000`）
- `QODERCN_TIMEOUT_MS`：单次请求超时（毫秒）。代理提示词 + 模型排队可能耗时数分钟，建议保持较大值（默认 300000，`.env.example` 示例为 600000）
- `QODERCN_CLI_TOOLS`：默认禁用 CLI 内置工具（追加 `--tools=`），让模型直接回答而不是在代理目录里跑文件/shell 循环。设为 `1` 可恢复
- 预热池：`QODER_WARM_POOL=0` 整体关闭；`QODER_WARM_POOL_SIZE` / `QODER_WARM_POOL_MAX_TOTAL` / `QODER_WARM_POOL_TTL_MS` / `QODER_WARM_POOL_READY_MS` 调节池大小、总量、回收与成熟门槛（详见 `.env.example`）
- 诊断：`LOG_REQUESTS=1` 记录每个失败请求（脱敏后）

### 支持的模型

`qoder-cn`、`auto`、`ultimate`、`performance`、`efficient`、`lite`、`cantus`、`qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-max`、`qwen3.7-plus`、`kimi-k3`、`kimi-k2.7-code`、`glm-5.3`、`glm-5.3-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`minimax-m3`

推理强度别名：`qwen3.8-max-effort-low`、`-medium`、`-high`、`-max`，以及 `qwen3.7-max-effort-low`、`-medium`、`-high`、`-max`

## API 端点

设置了 `PROXY_API_KEY` 的话，`/v1/*` 与 `/usage/*` 都需要携带密钥；`/health` 不需要。

| 方法 | 路径 | 需要密钥 | 说明 |
|------|------|------|------|
| GET | `/health` | 否 | 健康检查 |
| GET | `/v1/models` | 是 | 模型列表（含 credit 倍率） |
| POST | `/v1/chat/completions` | 是 | OpenAI 兼容格式对话，支持 tools 字段适配 |
| POST | `/v1/messages` | 是 | Anthropic 兼容格式对话，支持 tool_use 字段适配 |
| POST | `/v1/messages/count_tokens` | 是 | Token 估算 |
| GET | `/usage/local` | 是 | 本地用量估算 |
| POST | `/usage/reset-local` | 是 | 重置本地用量统计 |

## 安全边界

- 默认仅监听 `127.0.0.1`。`BIND_HOST` 可改绑，但绑定非 loopback 地址时启动日志会打印醒目警告
- **浏览器跨源请求一律拒绝**（仅允许本机 loopback 来源）。否则你访问的任意网页都能在后台调用代理、消耗你的 Qoder 额度
- **`Host` 头不是 loopback 的请求一律拒绝**，用于阻断 DNS rebinding（绑定 `0.0.0.0` 且未配置 `ALLOWED_HOSTS` 时该防护失效，启动日志会警告）
- 管理控制台 `/admin/*` 需要登录；登录接口带内存级限速（60 秒内连续失败 5 次锁定 15 分钟）
- 设置 `PROXY_API_KEY` 或存在任何 API Key 后，`/v1/*` 强制校验密钥；本项目**不提供任何免认证读取密钥的接口**
- 账号 PAT 与 API Key 以 AES-256-GCM 加密存放于 `data/`（主密钥 `data/.secret-key`，首次启动自动生成）；`data/` 已被 `.gitignore` 排除，**绝不要提交、备份或分发该目录**
- 日志自动脱敏 token、cookie、Authorization 头等敏感信息；`.env`、`data/`、日志均不纳入版本控制

需要提醒的是：**不设置 `PROXY_API_KEY` 时，本机上任何进程都可以使用这个代理。** loopback 绑定挡的是外部网络，挡不住本机。建议设置一个。

### 客户端认证（PROXY_API_KEY）

在 `.env` 中设置后，客户端需要在请求头中携带：

```text
Authorization: Bearer <PROXY_API_KEY>
```

或者（Anthropic 系客户端习惯）：

```text
x-api-key: <PROXY_API_KEY>
```

留空则不校验密钥。`/health` 始终开放，便于脚本探活。

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

请把这个特性当作实验性功能，并且和 `PROXY_API_KEY` 一起使用。

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
- 首次登录后立即修改默认管理员密码（`admin` / `admin123`）
- 不要绑定 `0.0.0.0`，不要暴露到公网；确需局域网访问时配置 `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` 并设置 `PROXY_API_KEY`
- 不要把 Token 或 `data/` 目录（含加密主密钥）发给别人
- 不要把 `.env` 提交到 Git
- 如果怀疑 Token 泄露，立即到 Qoder 官方账号页面吊销 PAT 并重新创建

### 报告安全问题

请不要在公开 issue 里报告漏洞，使用 GitHub 的私密报告入口：[Report a vulnerability](https://github.com/avaritiachaos/qoder-cli-proxy/security/advisories/new)。详见 [SECURITY.md](SECURITY.md)。

## 测试

```powershell
npm test
```

## 许可证

MIT。详见 [LICENSE](LICENSE)。
