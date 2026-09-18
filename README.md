# LocalMCP - 让 ChatGPT 安全地使用本机开发能力

让 ChatGPT 网页端使用你的本机开发能力：文件操作、Shell、持久进程、Skills 和可插拔 MCP Server。

![LocalMCP 工作原理：ChatGPT 经 Cloudflare Worker 中继，连接本机 Agent 和工具](localmcp.png)

本机主动通过 WebSocket 连接 Cloudflare Worker，由 Worker 负责认证与请求中继，无需公网 IP 或开放入站端口。

> [!IMPORTANT]
> LocalMCP 是一个**高权限本地代理**，以当前操作系统用户权限运行。启用 Shell、持久进程或任意外部 MCP Server，等价于把相应的本机能力授权给远程 MCP 调用方。请先阅读 [SECURITY.md](SECURITY.md)。

## 快速开始

需要 **Node.js 22+**。

```sh
npm install -g @daodao97/localmcp
localmcp ui
```

首次运行会：

- 创建 `~/.localmcp/`
- 以当前初始化目录作为显式 workspace
- 如果从用户 Home 启动，则使用 `~/.localmcp/workspace`，不会默认暴露整个 Home
- 文件读取默认开启
- 文件写入、删除/移动默认关闭
- Shell、持久进程、外部 MCP 默认关闭
- **先要求显式选择 Relay，Agent 不会自动启动**
- Control Center 会预填默认公共 Relay；只有点击 `Save & Start Agent` 后才保存 Relay、注册设备并启动 Agent
- Agent 启动后默认处于 **LOCKED**

默认公共 Worker 是可信中继基础设施，它会终止 TLS 并转发 MCP 请求/响应；当前架构**不是 ChatGPT 到本机 Agent 的端到端加密**。公共 Relay 只作为首次设置的预填建议值，不再作为 Agent 的隐式运行时 fallback。敏感开发环境建议使用自建 Worker。

### 获取 MCP URL

普通状态查看：

```sh
localmcp status
```

`status` 只显示**脱敏后的 MCP URL**。

需要配置 ChatGPT 时，显式执行：

```sh
localmcp url
```

完整 MCP URL 本身就是访问凭证，请勿：

- 提交到 Git
- 放入 issue
- 公开截图
- 写入普通日志

在 ChatGPT 中添加 MCP 连接时，服务器 URL 填入 `localmcp url` 输出的完整地址，身份验证选择 **None**。

## 常用命令

```sh
localmcp                    # 已配置 Relay 后启动后台 Agent；重复执行会复用已有进程
localmcp status             # 查看运行状态、LOCK 状态、脱敏 URL、配置/日志路径
localmcp url                # 显式显示完整 MCP URL
localmcp unlock             # 本机临时解锁危险能力，默认 30 分钟
localmcp unlock --minutes 5 # 指定 1-480 分钟
localmcp lock               # 立即重新锁定
localmcp rotate             # 轮换 Agent/MCP 凭证（设备模式）
localmcp reload             # 校验并重新加载配置
localmcp ui                 # 启动仅限本机访问的 Web 控制界面
localmcp stop               # 停止后台服务
localmcp agent              # 前台运行，便于调试
```

Agent 每次重新启动都会恢复为 **LOCKED**。

日志位于：

```text
~/.localmcp/agent.log
```

结构化安全审计日志位于：

```text
~/.localmcp/audit.log
```

也支持 `localmcp stdio`，或通过：

```sh
LOCALMCP_TOKEN=<至少32字符的密钥> localmcp http
```

启动本地 HTTP 服务。

## 安全模型摘要

LocalMCP 使用两层授权：

1. **配置能力**：某项能力必须显式启用
2. **本地 LOCK / UNLOCK**：危险能力即使已配置，在 LOCKED 时也不能调用

危险能力包括：

- 文件写入/编辑
- 新建目录
- 删除/移动
- Shell
- 持久进程
- 启动/调用外部 MCP Server

工具列表会隐藏当前不可用的工具，但服务端仍会在每次调用时重新授权，不能把“工具没显示”当成唯一安全边界。

### Workspace 不是 Shell 沙箱

文件工具受 workspace 路径边界保护。

**Shell 不受这个边界沙箱化。**

例如一个以 workspace 为 `cwd` 的命令，仍然可以访问：

- 其他目录
- 其他盘符
- 网络资源
- 当前 OS 用户有权限访问的其他内容

因此 Shell 必须同时满足：

- 配置显式开启
- Agent 已在本机解锁

LocalMCP 不会在此版本中伪造一个不可靠的跨平台 Shell sandbox。

更多细节见 [SECURITY.md](SECURITY.md)。

## 自建 Worker

对于包含源码、凭证、内部系统访问等敏感场景，推荐使用自己的 Cloudflare Worker。

### 1. 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/daodao97/localmcp)

也可以命令行部署：

```sh
git clone https://github.com/daodao97/localmcp.git
cd localmcp
npm ci
npx wrangler login
npm run worker:deploy
```

部署后记录 Worker origin，例如：

```text
https://localmcp-relay.YOUR-SUBDOMAIN.workers.dev
```

### 2. 可选：保护 `/register`

默认情况下，为兼容现有部署，Worker 的设备注册可以保持开放。

自建 Worker 建议配置：

```text
REGISTRATION_TOKEN_HASH
```

它应为一段随机 raw token 的 SHA-256 hex。

可生成一对 token/hash：

```sh
node -e "const c=require('node:crypto');const t=c.randomBytes(32).toString('hex');console.log('token='+t);console.log('sha256='+c.createHash('sha256').update(t).digest('hex'))"
```

将 `sha256` 配置为 Worker 的 `REGISTRATION_TOKEN_HASH`，本机首次注册时提供 raw token：

```sh
LOCALMCP_WORKER_URL=https://localmcp-relay.YOUR-SUBDOMAIN.workers.dev \
LOCALMCP_REGISTRATION_TOKEN=<raw-token> \
localmcp
```

注册密钥通过 `Authorization` header 发送，不放在 URL 中。桌面版 / Control Center 也可以在首次 Relay 设置中填写 registration token；它只会临时保存在受限权限的 `~/.localmcp/registration-token.pending`，注册成功后立即删除，不写入 `localmcp.json`、audit 或 MCP URL。

### 3. 连接自建 Worker

可以在首次 Control Center 向导中直接填写自建 Worker URL（以及可选 registration token），或者使用环境变量：

```sh
LOCALMCP_WORKER_URL=https://localmcp-relay.YOUR-SUBDOMAIN.workers.dev localmcp
```

首次连接会把设备地址和凭证保存到：

```text
~/.localmcp/worker.json
```

之后直接执行 `localmcp` 即可。

如果已经连接过其他 Worker，可以在 Control Center 中显式切换。Agent 运行时会执行 re-registration；Agent 停止时则先保存新的 Relay，下一次启动时再注册。切换只更新本地注册状态，不会自动撤销旧 Worker 上的远端设备注册，必要时请在旧 Worker 侧单独撤销或轮换。

## 在 ChatGPT 中使用

1. 在本机执行：

   ```sh
   localmcp url
   ```

2. 在 ChatGPT 网页端打开开发者模式。

   ![在 ChatGPT 中开启开发者模式](chatgpt_setting.png)

3. 新建 MCP / Connector，并填入完整 URL。

   ![在 ChatGPT 中添加 LocalMCP 插件](chatgpt_plugin.png)

4. 在对话中 `@LocalMCP` 使用。

如果要调用危险能力，先在本机明确执行：

```sh
localmcp unlock --minutes 30
```

完成后可以立即：

```sh
localmcp lock
```

## 配置

配置文件：

```text
~/.localmcp/localmcp.json
```

Fresh install 示例：

```json
{
  "workspaces": {
    "project": "/Users/me/code/project"
  },
  "defaultWorkspace": "project",
  "features": {
    "files": {
      "read": true,
      "write": false,
      "delete": false
    },
    "shell": false,
    "processes": false,
    "externalMcp": false
  },
  "skills": {
    "dir": "skills",
    "enabled": ["local-development"]
  },
  "mcpServers": {}
}
```

### 文件权限

新配置使用：

```json
"files": {
  "read": true,
  "write": false,
  "delete": false
}
```

其中：

- `read`：目录、搜索、读取、stat
- `write`：write/edit/apply_patch/create_directory
- `delete`：delete_path/move_path

旧配置：

```json
"files": true
```

仍然按兼容逻辑解释为 read/write/delete 全部已配置，但写/删依旧受本地 LOCK gate 约束。

### Shell / Processes

```json
{
  "shell": true,
  "processes": true
}
```

表示能力已配置，不表示远程调用方可以立即执行。

必须再由本机：

```sh
localmcp unlock
```

才能实际使用。

### Skills

把说明文件放在：

```text
~/.localmcp/skills/<名称>/SKILL.md
```

并通过 `skills.enabled` 控制加载。

### 外部 MCP

示例：

```json
{
  "features": {
    "externalMcp": true
  },
  "mcpServers": {
    "computer": {
      "enabled": true,
      "command": "cua-driver",
      "args": ["mcp"]
    }
  }
}
```

外部 MCP 使用固定入口：

| 工具 | 用途 |
| --- | --- |
| `list_mcp_servers` | 列出配置的 MCP Server；不会因此启动它 |
| `list_mcp_tools` | 启动/查询指定 Server 的工具；需要本地解锁 |
| `call_mcp_tool` | 调用指定外部 MCP 工具；需要本地解锁 |

外部 MCP 是 **lazy start**：仅配置 Server 不会在 Agent 启动时自动执行。

外部 MCP 返回的 tool description / annotations 只被视为元数据，**不会被信任为授权边界**。

## 热更新

`localmcp.json` 内容稳定后会自动热更新。

热更新会：

- 校验 JSON/schema
- 校验 workspace
- 重新加载 Skills
- 替换 MCP 配置
- 保留正在进行中的本地调用和 ProcessManager

无效 JSON、非法路径等错误不会覆盖当前有效运行配置。

修改 Worker origin / 凭证仍需要重启 Agent。

## 凭证轮换

设备模式下可以执行：

```sh
localmcp rotate
```

成功后 Worker 会：

- 替换 Agent token hash
- 替换 MCP token hash
- 断开旧 Agent WebSocket
- 使旧凭证失效

旧的单用户 Worker 模式不保证具备相同的设备级撤销能力；LocalMCP 会明确报告该限制。

## 本地状态文件

`~/.localmcp/` 中可能包含：

- `localmcp.json`
- `worker.json`
- `connection.json`
- `control.secret`
- `audit.log`
- Agent 日志和状态文件

敏感状态会尽量使用严格文件权限。

在 Windows 上，LocalMCP 会 best-effort 使用 `icacls` 收紧 ACL。POSIX 的 `0600` 不能被当成 Windows ACL 边界。

## 开发

```sh
npm ci
npm run check
npm test
npm run build
```

`npm test` 会先 build，再执行完整测试，避免测试依赖过期或不存在的 `dist/`。

GitHub Actions 在：

- Windows
- Linux
- macOS

上运行完整测试，并覆盖项目支持的 Node 版本矩阵。

`start:quick` 已统一到正常 lifecycle，不再维护第二套 Quick Tunnel / `.localmcp` 安全模型。

## 本地 Web 控制 UI

运行：

```sh
localmcp ui
```

会启动一个轻量 Web 控制界面，并仅绑定到动态分配的 `127.0.0.1` 端口。命令会打印本地 URL，并在可用时尝试打开默认浏览器；浏览器打开失败不会影响 URL 输出。调试或自动化时可使用：

```sh
localmcp ui --no-open
```

控制 UI 不会启动第二个 Agent。它作为本机控制客户端，通过现有的认证控制 IPC 管理 Agent 生命周期、安全状态、Worker 注册和配置，并与远程 MCP 数据面保持分离。

浏览器控制 API 使用随机、短期、`HttpOnly`、`SameSite=Strict` 的本机会话 Cookie，并要求严格同源 `Origin`。`control.secret` 不会写入 URL、HTML、JavaScript、浏览器历史、普通日志或 MCP 响应。

UI v2 支持：

- Dashboard：Agent、Relay、Security、默认 Workspace 一屏总览
- Agent Start / Stop / Restart / Reload
- 5 / 30 / 60 分钟解锁与立即锁定
- Workspace 新增、修改、删除、默认 Workspace 切换；保存前使用同一配置解析器验证目录边界
- `files.read`、`files.write`、`files.delete`、`shell`、`processes`、`externalMcp` 配置编辑
- 同时显示 Configured / Effective config / Current availability，明确区分“配置允许”和“当前可调用”
- 配置校验、原子写入与运行中 Agent reload
- Worker origin、连接状态、device ID 与默认脱敏 MCP URL
- 通过 Agent 控制 IPC 显式重新注册 Worker；注册 token 不进入浏览器或普通配置文件；切换 Worker 不宣称会自动撤销旧 Worker 上的远端注册
- `LOCALMCP_WORKER_URL` 环境覆盖存在时，UI 明确显示该来源并禁止改写 Worker
- 显式 Reveal / Copy 完整 MCP URL
- 显式确认后进行 credential rotation
- 脱敏 audit history：类别/文本筛选、10/25/50 条分页、上一页/下一页与当前结果计数

启用 Shell 时，UI 会明确提示：LocalMCP Shell 以当前 OS 用户权限执行，Workspace **不是** Shell sandbox。

完整 MCP URL 只会在本机用户显式确认 reveal 后返回给浏览器。控制 UI 不提供远程管理入口，也不会把 unlock、rotate 或配置管理暴露成 MCP tool。

### Desktop Shell

如果希望把 Control Center 作为独立应用窗口启动，而不是普通浏览器标签页：

```sh
localmcp desktop
```

Desktop Shell 仍然启动同一个仅绑定 `127.0.0.1` 的 Control Center，不引入第二套后端或授权逻辑。Windows 会优先寻找 Microsoft Edge / Google Chrome 并使用 `--app=` 模式打开独立窗口；macOS / Linux 使用对应的 Edge / Chrome / Chromium app-mode。找不到可用 app-mode 浏览器时，会退回系统默认浏览器。

可通过 `LOCALMCP_DESKTOP_BROWSER` 指定 Edge/Chrome/Chromium 可执行文件或命令名。启动过程使用参数数组调用，不经过 shell 插值。Control Center 的本地 UI URL 不包含 MCP credential。

Desktop Shell v1 仍然只是浏览器 app-mode 包装；如果需要真正的系统托盘，可以使用 Tauri Tray v1：

```sh
npm run tray:build
localmcp tray
```

Tray v1 继续复用同一个 loopback Control Center 与 Agent IPC。Windows 上关闭窗口只会隐藏到托盘；托盘菜单提供 Show / Hide / Quit，左键托盘图标会重新显示窗口。Quit 会结束 Tray 并关闭对应的本地 UI host，但不会停止独立运行的 LocalMCP Agent。

Tray WebView 只接受 `http://127.0.0.1:<port>/` Control Center URL，并限制页面导航继续留在同一个 loopback origin；Rust 壳不持有 MCP URL credential，也没有重新实现 unlock / rotate / config authorization。源码开发版不提交 `src-tauri/target/` 或预编译 `.exe`，需要在本机先运行 `npm run tray:build`。

### Windows Installer

Windows 可以构建独立的 NSIS 安装包：

```sh
npm run desktop:bundle
```

输出位于：

```text
src-tauri/target/release/bundle/nsis/LocalMCP_<version>_x64-setup.exe
```

安装版由 Tauri 原生壳作为主进程，并随安装包携带当前构建使用的 Node runtime、LocalMCP `dist/`、skills 与 production dependencies。目标 PC 不需要另外安装 Node、npm 或 Rust。首次启动时，Tauri 会用隐藏的 bundled Node 子进程启动同一个 loopback Control Center；已有的 Agent / IPC / LOCK / feature gate 安全模型保持不变。

Windows 后台命令执行默认抑制控制台窗口：`run_command`、`start_process`、Agent 启动、Agent 内部 HTTP 与 Tray 子进程都使用 hidden-window 启动方式；这不会改变 stdout/stderr、stdin、退出码或进程终止语义。External MCP 的官方 SDK transport 也默认在 Windows 隐藏其子进程窗口。

实现与安全设计记录见：

```text
docs/tasks/LOCAL-CONTROL-UI.md
docs/tasks/LOCAL-CONTROL-UI-V2.md
docs/tasks/LOCAL-CONTROL-DESKTOP-V1.md
docs/tasks/LOCAL-CONTROL-TRAY-V1.md
docs/tasks/WINDOWS-DESKTOP-DISTRIBUTION-V1.md
docs/tasks/FIRST-RUN-RELAY-SETUP-V1.md
```

## License

MIT
