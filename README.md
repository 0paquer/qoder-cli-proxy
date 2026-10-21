# Qoder CLI Proxy

把 Qoder CLI 订阅转换为本机 OpenAI / Anthropic 兼容 API 的多账号网关。

[English](README.en.md)

## 免责声明

本项目仅用于个人账号的本地兼容性实验与协议适配研究，与 Qoder 官方无关。
使用者必须自行持有合法的 Qoder 账号和 Personal Access Token；本项目不提供、共享、转售任何账号、Token 或额度。
禁止公网部署、多人共享、转售 API；禁止用于规避 Qoder 官方的计费、风控、速率、地域或使用限制。
请遵守 Qoder 官方服务条款；如官方不允许，请立即停止使用。

## 特性

- **多账号调度**：每账号独立 PAT（AES-256-GCM 加密入 SQLite），加权随机 × 剩余额度因子，失败自动切换、指数退避冷却、并发上限
- **双协议出口**：OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`，支持流式与工具调用字段适配
- **预热进程池**：热响应约 3 秒（冷启动 12-17 秒）；启动预热 + 空闲保温 + 切换模型按需预热
- **用户与配额**：多网关用户、`qk-` API Key、按用户授权账号与日/月配额（请求数 / token 数）
- **额度与审计**：额度查询零 credits 消耗；每次调用记录模型、账号、用量、耗时，不存 prompt 正文
- **管理控制台**：账号、用户与密钥、用量统计、测试对话、调用测试、系统设置

对话执行由 [@qoder-ai/qoder-agent-sdk](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk) 驱动。支持两个后端：**CN**（`qoderclicn` → qoder.com.cn，PAT 认证）与 **Global**（`qodercli` → qoder.com，OAuth 登录），由 `CLI_BACKEND` 切换。

## 快速开始

需要 Node.js 18+。

**1. 安装 CLI**

```bash
# CN 后端（必须）
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version

# Global 后端（可选）
npm install -g @qoder-ai/qodercli
qodercli --version
qodercli login   # 必须登录一次
```

**2. 安装依赖**

```powershell
npm install
```

`.env` 非必需：不存在时首次启动按 `.env.example` 自动创建，关键配置只有 `CLI_BACKEND=cn`。手动创建用 `Copy-Item .env.example .env`，修改后重启生效（管理台「系统设置」保存会同步写回 `.env`）。

> **PAT 不写入 `.env`。** 启动后在管理台「账号管理」页添加账号并填入 PAT，以 AES-256-GCM 加密存入 SQLite，多账号互不干扰。CN 版 PAT 创建入口：https://qoder.com.cn/account/integrations

**3. 启动**

```powershell
npm start
```

Windows 可双击 `start-proxy.cmd`。默认地址 `http://127.0.0.1:1300`（`PORT` 可改）。首次启动自动创建 `data/`（SQLite + AES 主密钥）并建表，同时创建默认管理员 **`admin` / `admin123`**——首次登录强制修改密码，未修改前管理接口一律拒绝（`403 default_password`）。

**4. 验证**

```powershell
curl.exe http://127.0.0.1:1300/health
curl.exe http://127.0.0.1:1300/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"reply OK\"}]}"
```

**5. 控制台初始化**（`http://127.0.0.1:1300/ui`，`start-ui.cmd` 可快捷打开）

1. `admin` / `admin123` 登录 → 强制改密（至少 8 位，不能与默认密码相同，无法跳过）
2. 「账号管理」添加 Qoder 账号 → 点「验证」加载模型目录（零 token 消耗）→ 查看剩余额度
3. 「测试对话」发一条消息确认上游链路；「用户密钥」签发 `qk-` 密钥给客户端使用

## 接入客户端

**OpenAI 兼容**：Base URL `http://127.0.0.1:1300/v1`，API Key 填 `qk-` 密钥，Model 从 `/v1/models` 选择。未签发任何密钥时网关对本机开放，可填任意占位值。不要把 Qoder Token 填进客户端。

**Anthropic 兼容**：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:1300"   # 不要追加 /v1，客户端自动拼接
$env:ANTHROPIC_AUTH_TOKEN = "你的 qk- 密钥"
```

**OpenCode**（仓库自带 `opencode.json`，本地验证用）：

```powershell
opencode run --model qoder-cn-local/qwen3.8-max --variant high "reply OK"
```

签发过 `qk-` 密钥的话，把 `opencode.json` 里的 `apiKey` 从 `not-used` 换成你的密钥。

## 管理控制台

| 页面 | 说明 |
|-----|------|
| 仪表盘 | 今日 / 累计调用量、账号与密钥概览 |
| 账号管理 | 添加账号（PAT 加密入库）、验证、剩余额度、权重 / 并发 / 冷却状态 |
| 用户与密钥 | 网关用户、`qk-` 密钥发放与吊销、按用户授权账号与配额 |
| 用量记录 | 按天 / 模型 / 用户 / 账号统计与调用明细 |
| 测试对话 | 指定账号直接对话（流式 / 非流式切换） |
| 调用测试 | 粘贴 API Key 走完整网关链路（鉴权 → 调度 → 配额） |
| 系统设置 | 可视化编辑运行配置、运行状态、预热进程池管理，保存后自动重启 |

用量存于本机 `data/qoder-proxy.db`，只记元数据（模型、token 数、耗时、错误码），**不保存 prompt 与响应正文**；token 数部分为本地估算（标记 `estimated`）。控制台不显示 PAT 明文（仅指纹）。

## 工作原理与限制

CLI 只接受文本进出，本项目作为本地适配层：接收 OpenAI / Anthropic 格式请求，经 Agent SDK 转为 CLI 会话调用（prompt 走 stdin 流式协议，预热池提供热进程），再把输出整理为兼容格式响应。

**工具调用**是 Prompt 格式指令 + 输出解析实现的文本层适配，不是模型原生能力——与官方 API 的 `tools` 参数通道不同，不应视为等价替代；模型输出非法 JSON 或拒绝工具格式时降级为纯文本。流式时回复文本经门控实时转发（暂扣仍可能长成工具 JSON 的尾部），工具调用在流末尾一次性补齐——因此未闭合的代码围栏会暂扣到闭合后再显示（宁可延迟，绝不把工具 JSON 泄漏为文本）。

当前限制：

- 对话请求使用独立 CLI 子进程，预热池消除冷启动（`QODER_WARM_POOL=0` 关闭后每次冷启动 12-17 秒）
- 流式响应 usage 不由上游逐 chunk 下发，按 tracker / 估算记入用量（`estimated`）
- `SERVER_TOOL_EXECUTION=1` 开启时，带工具的流式请求改走缓冲路径

## 配置参考

**双后端**（`.env` 的 `CLI_BACKEND`，重启生效）：

| 配置项 | CN 后端 | Global 后端 |
|---------|--------|----------|
| CLI 命令 | `qoderclicn` | `qodercli` |
| 认证方式 | PAT（账号管理页添加，加密入库） | `qodercli login`（OAuth，无需配置） |
| 认证目录 | `~/.qoderworkcn` | `~/.qoder` |

**推理参数**（全局默认；也可按请求用 `reasoning_effort` / `context_window` / `max_tokens` 单独覆盖）：

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

**其他环境变量**：

- `PORT` / `BIND_HOST`：监听端口与地址（默认 `127.0.0.1:1300`）
- `QODERCN_TIMEOUT_MS`：单次请求超时，默认 300000（代理提示词 + 排队可能耗数分钟，不建议调小）
- `QODERCN_CLI_TOOLS=1`：恢复 CLI 内置工具（默认禁用，避免模型在代理目录里跑文件 / shell 循环）
- 预热池：`QODER_WARM_POOL=0` 整体关闭；`QODER_WARM_POOL_SIZE` / `_MAX_TOTAL` / `_TTL_MS` / `_READY_MS` 调节池容量与回收，详见 `.env.example`
- `LOG_REQUESTS=1`：记录每个失败请求（脱敏后）

**支持的模型**：`qoder-cn`、`auto`、`ultimate`、`performance`、`efficient`、`lite`、`cantus`、`qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-max`、`qwen3.7-plus`、`kimi-k3`、`kimi-k2.7-code`、`glm-5.3`、`glm-5.3-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`minimax-m3`；推理强度别名 `qwen3.8-max-effort-low|-medium|-high|-max`（`qwen3.7-max` 同理）。

## API

**认证**：

- `/health` 始终开放
- `/v1/*`、`/usage/*`：签发过任何 `qk-` 密钥后必须携带 `Authorization: Bearer <key>` 或 `x-api-key: <key>`；一个密钥都没有时对本机开放（任意占位值即可）
- `/admin/*`：`POST /admin/login` 换 token，后续带 `Authorization: Bearer <token>`；登录限速（60 秒内失败 5 次锁定 15 分钟）

**端点**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/v1/models` | 模型列表（含 credit 倍率；`id`/`displayName` 为显示名、`modelId` 为 CLI 内部代号，对话两者均可传，网关统一反查） |
| POST | `/v1/chat/completions` | OpenAI 兼容对话，支持 tools 字段适配 |
| POST | `/v1/messages` | Anthropic 兼容对话，支持 tool_use 字段适配 |
| POST | `/v1/messages/count_tokens` | Token 估算 |
| GET | `/usage/local` · POST `/usage/reset-local` | 本地用量估算与重置 |
| POST | `/admin/login` · `/admin/logout` · `/admin/change-password` | 会话管理（管理台其余接口以控制台实际调用为准） |

**`/v1/chat/completions` 参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `messages` | array | 是 | OpenAI 消息结构（`role` / `content`） |
| `model` | string | 否 | 默认 `qoder-cn`，显示名或内部代号均可 |
| `stream` | boolean | 否 | 默认 `false`，SSE 增量输出 |
| `tools` | array | 否 | 文本层适配，见「工作原理与限制」 |
| `reasoning_effort` | string | 否 | `low` / `medium` / `high` / `max`（也支持 `reasoning.effort` 写法） |
| `context_window` · `max_tokens` | number | 否 | 覆盖上下文窗口 / 最大输出 token |

`/v1/messages` 为 Anthropic 标准结构（`model` / `max_tokens` / `system` / `messages`），参数同名映射。错误响应：OpenAI 口径 `{"error":{"message","type","code"}}`，Anthropic 口径 `{"type":"error","error":{...}}`。

**常见错误码**：

| 状态码 | code | 含义 |
|--------|------|------|
| 400 | `invalid_request` / `invalid_messages` | 请求体或 messages 结构不合法 |
| 401 | `invalid_api_key` | 密钥缺失或错误 |
| 401 | `cli_token_missing` | 无任何已配置的 Qoder 账号 |
| 403 | `default_password` | 默认密码未修改（首登强制改密） |
| 403 | `no_account_granted` | 该用户未被授权任何账号 |
| 429 | `quota_exceeded` | 用户配额超限（日 / 月 token 或请求数） |
| 502 | `cli_not_found` / `upstream_error` | CLI 未安装或上游返回错误 |
| 503 | `no_available_account` | 账号池无可用账号（全部冷却或额度耗尽） |
| 504 | `upstream_timeout` | 请求超时 |

## 安全边界

- 默认仅监听 `127.0.0.1`；`BIND_HOST` 改绑非 loopback 地址时启动日志打印醒目警告
- **浏览器跨源请求一律拒绝**（仅允许 loopback 来源），否则任意网页都能后台调用代理消耗你的额度；**`Host` 非 loopback 一律拒绝**（防 DNS rebinding；绑 `0.0.0.0` 且未配 `ALLOWED_HOSTS` 时该防护失效，启动日志会警告）
- **一个 `qk-` 密钥都不存在时，本机任何进程都可以使用代理**——loopback 绑定挡外部网络，挡不住本机，建议先在「用户密钥」签发一个
- PAT 与 API Key 以 AES-256-GCM 存于 `data/`（主密钥 `data/.secret-key`，首次启动自动生成）；`data/`、`.env`、日志均已排除版本控制，**绝不要提交、备份或分发 `data/`**
- 日志自动脱敏 token、cookie、Authorization 头；管理接口需登录且带限速
- `SERVER_TOOL_EXECUTION=1`（默认关闭）会在本机执行模型返回的工具调用：工作目录限制在 `SERVER_TOOL_WORKSPACE`，Bash 需 `SERVER_TOOL_ALLOW_BASH=1` + 白名单且不走 shell（Windows 下无法执行 `.cmd`/`.bat` 包装）。保持关闭，开启时务必配合 `qk-` 密钥
- 本机 Web 应用需从浏览器调用时用 `ALLOWED_ORIGINS` 放行；确需其他主机名访问用 `ALLOWED_HOSTS`——一旦使用，安全模型需自行评估
- 怀疑 Token 泄露：立即到 Qoder 官方账号页面吊销 PAT 并重建。漏洞请勿开公开 issue，走私密报告：[Report a vulnerability](https://github.com/0paquer/qoder-cli-proxy/security/advisories/new)，详见 [SECURITY.md](SECURITY.md)

## 测试

```powershell
npm test
```

## 许可证

MIT。详见 [LICENSE](LICENSE)。
