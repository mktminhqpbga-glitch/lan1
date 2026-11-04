# Muse—Canvas

> 把 **Muse(muse.ai)** 的生图 / 生视频 / 对话能力接进 **无限画布**，再用 **DeepSeek + Codex Agent** 让 AI 直接操作画布。
>
> A self-hosted AI canvas that connects **Muse(muse.ai)** image / video / chat models to **Infinite Canvas**, with a server-side **DeepSeek + Codex Agent** that can operate the canvas.

[中文](#中文) · [English](#english) · [GitHub](https://github.com/huwanbin/Muse-Canvas)

---

## 中文

### 这是什么

这个仓库把两个优秀的开源项目组合成一套可部署的完整系统：

1. **[muse2api](https://github.com/czg86389-hub/muse2api)**：把 Muse 的网页能力逆向封装成 OpenAI 兼容 API，支持文生图、图生图、文生视频、图生视频和对话。
2. **[infinite-canvas](https://github.com/basketikun/infinite-canvas)**：面向 AI 创作的无限画布工作台，浏览器端直接调用 OpenAI 兼容接口。
3. **本仓库新增的粘合层**：
   - 让无限画布的默认渠道由服务器 `.env` 固定，网页端不能改地址、Key 和模型；
   - 把 Agent 的地址、Token 固定到 `canvas-agent.json`，网页端只读并自动连接；
   - 提供 `canvas_server.py`，用纯 Python 托管构建好的前端，不依赖 Node；
   - 提供 `install.sh`、1Panel 进程守护配置、Nginx SSE 反代示例和中英教程；
   - 对 muse2api 做了兼容补丁：支持画布传来的 `multipart/form-data` 视频参数、`n` 张图片、`first_frame` / `last_frame` / `image[]` 参考图等。

### 功能

- 无限画布：文本、图片、视频、音频节点，参考图，画布项目管理。
- Muse 渠道：`muse-image` 生图、`muse-video` 生视频、`muse-spark` 对话/代码。
- 服务端 Agent：Codex App Server 使用 DeepSeek Responses API，通过 MCP 工具直接操作画布。
- 渠道锁定：`MUSE_API_BASE`、`MUSE_API_KEY`、模型列表只在服务器 `.env` 中维护。
- Agent 锁定：浏览器地址和 Token 只从 `agent/.infinite-canvas/canvas-agent.json` 读取。
- 一条 `install.sh` 完成 Python 环境、Node Agent、Codex 配置、密钥和进程守护参数生成。
- 中英双语文档 + 可复现的 1Panel / Nginx 部署步骤。

### 架构

```text
┌──────────────────────────────┐
│ 浏览器                        │
│ https://canvas.example.com   │
│  ├─ 无限画布（静态前端）       │
│  ├─ /config.js 由后端动态注入  │
│  └─ Agent 面板（只读地址/Token）│
└──────────────┬───────────────┘
               │ HTTPS
     ┌─────────┴──────────┐
     │                    │
┌────▼─────────┐   ┌──────▼─────────────┐
│ canvas_server│   │ agent.example.com  │
│ :521         │   │ Nginx → 127.0.0.1  │
│ 静态文件      │   │ :17371             │
└────┬─────────┘   └──────┬─────────────┘
     │                    │
     │ /config.js         │ SSE + HTTP
     │                    │
┌────▼─────────┐   ┌──────▼─────────────┐
│ muse2api     │   │ canvas-agent        │
│ :1314        │   │ Codex app-server    │
│ FastAPI      │   │ DeepSeek Responses  │
└────┬─────────┘   └──────┬─────────────┘
     │                    │
┌────▼─────────┐   ┌──────▼─────────────┐
│ Muse 账号池   │   │ api.deepseek.com   │
│ Chromium CDP │   │ MCP → 画布工具      │
└──────────────┘   └────────────────────┘
```

### 目录结构

```text
Muse-Canvas/
├── README.md                     # 本文件（中英对照）
├── LICENSE                       # MIT
├── NOTICE                        # 上游项目与致谢
├── .env.example                  # 服务器环境变量模板
├── install.sh                    # 一键安装（Debian / Ubuntu）
├── start-api.sh                  # 启动 muse2api
├── start-canvas.sh               # 启动画布静态服务
├── canvas_server.py              # 纯 Python 静态服务器 + /config.js 注入
├── supervisor.conf.example       # 1Panel 进程守护参考
├── nginx-agent.conf.example      # Agent 的 Nginx/SSE 反代参考
├── muse2api/                     # 已打补丁的 Muse API 源码
├── canvas/
│   └── dist/                     # 构建好的无限画布前端
├── agent/
│   ├── package.json              # @basketikun/canvas-agent
│   ├── start-agent.sh            # 服务端 Agent 启动脚本
│   └── codex/                    # Codex + DeepSeek 配置与模型目录
└── source/
    └── infinite-canvas/          # 无限画布上游源码（便于二次开发）
```

### 环境要求

- Linux：Debian 12+ / Ubuntu 22.04+（其他发行版需自行安装依赖）。
- Python 3.10+。
- Node.js 18+（推荐 20/22）。
- Chromium 或 Google Chrome（muse2api 需要）。
- 至少 2 核 4 GB；视频生成建议 4 核 8 GB。
- 一个能登录 Muse 的账号（通过 Cookie 导入）。
- 一个 DeepSeek API Key（Agent 使用，`sk-` 开头）。

### 快速开始

#### 1. 上传并解压

```bash
sudo mkdir -p /Muse
sudo tar -xzf Muse-Canvas.tar.gz -C /Muse --strip-components=1
cd /Muse
```

也可以把仓库直接 `git clone` 到 `/Muse`。

#### 2. 准备环境变量

```bash
cp .env.example .env
nano .env
```

至少修改：

```ini
MUSE_API_BASE=https://api.example.com
MUSE_API_KEY=换成一个随机长字符串
DEEPSEEK_API_KEY=sk-你的DeepSeekKey
```

说明：

- `MUSE_API_BASE` 是**浏览器**访问 Muse API 的地址，末尾不要带 `/`，也不要带 `/v1`；
- 如果画布用 HTTPS 打开，这里也必须是 HTTPS，否则浏览器会拦截混合内容；
- `MUSE_API_KEY` 是 muse2api 的访问密钥，不是 Muse 账号密码；
- `DEEPSEEK_API_KEY` 只给服务端 Agent 用，不会写进前端。

#### 3. 一键安装

```bash
sudo -E bash install.sh
```

安装脚本会：

1. 安装 Python、Chromium、Node、字体等依赖；
2. 创建 `.venv` 并安装 muse2api 依赖；
3. 保留已有 `.env`，没有则生成随机 `MUSE_API_KEY`；
4. 校验并写入 `DEEPSEEK_API_KEY`；
5. 在 `agent/` 安装 `@basketikun/canvas-agent@0.6.0`；
6. 生成 `agent/.infinite-canvas/canvas-agent.json`（Token、公网地址、允许来源、工作区）；
7. 打印 1Panel 三条进程守护参数、Agent Token 和管理台地址。

如果域名不是 `agent.example.com` / `muse.example.com`，安装时覆盖：

```bash
sudo -E env \
  AGENT_PUBLIC_URL="https://agent.example.com" \
  AGENT_ORIGINS="https://canvas.example.com https://muse.example.com" \
  bash install.sh
```

#### 4. 1Panel 进程守护

在 1Panel 的「工具箱 → 进程守护」中安装 Supervisor，然后创建三条：

| 名称 | 运行用户 | 运行目录 | 启动命令 |
| --- | --- | --- | --- |
| `muse2api` | root | `/Muse` | `/bin/bash /Muse/start-api.sh` |
| `muse-canvas` | root | `/Muse` | `/bin/bash /Muse/start-canvas.sh` |
| `muse-agent` | root | `/Muse/agent` | `/bin/bash /Muse/agent/start-agent.sh` |

进程数都填 `1`，保存后启动。日志在 `/Muse/logs/`。

#### 5. 反向代理与 HTTPS

建议三个域名：

| 域名 | 反代到 | 用途 |
| --- | --- | --- |
| `canvas.example.com` | `127.0.0.1:521` | 无限画布 |
| `api.example.com` | `127.0.0.1:1314` | Muse API |
| `agent.example.com` | `127.0.0.1:17371` | 服务端 Agent |

API 的 Nginx 关键配置（生图/视频可能超过 60 秒）：

```nginx
proxy_connect_timeout 60s;
proxy_send_timeout    600s;
proxy_read_timeout    600s;
proxy_buffering       off;
client_max_body_size  200M;
```

Agent 的 Nginx 关键配置（SSE 不能缓冲）：

```nginx
proxy_http_version 1.1;
proxy_set_header   Host $host;
proxy_set_header   X-Real-IP $remote_addr;
proxy_buffering    off;
proxy_cache        off;
gzip               off;
proxy_read_timeout 3600s;
client_max_body_size 100M;
```

> 画布和 API 必须同为 HTTPS，或同为 HTTP。HTTPS 画布调用 HTTP API 会被浏览器拦截。

#### 6. 导入 Muse 账号

浏览器打开：

```text
https://api.example.com/admin?key=你的MUSE_API_KEY
```

在管理台导入 Muse Cookie：

- 使用 `muse2api/extension/` 里的 Chrome 扩展；或
- 从浏览器 DevTools → Application → Cookies → `muse.ai` 复制 `hatch_sess`、`hatch_vml`，粘贴为：

```text
hatch_sess=......; hatch_vml=......
```

导入后点账号的「测试」，状态可用即可。

#### 7. 配置 Agent 与固定渠道

画布后台只需要维护两个文件：

**`/Muse/.env`**（渠道固定来源）

```ini
MUSE_API_BASE=https://api.example.com
MUSE_API_KEY=你的随机长Key
MUSE_CHANNEL_NAME=Muse
DEEPSEEK_API_KEY=sk-...
```

**`/Muse/agent/.infinite-canvas/canvas-agent.json`**（Agent 唯一来源）

```json
{
  "url": "http://127.0.0.1:17371",
  "publicUrl": "https://agent.example.com",
  "token": "安装脚本生成的36位Token",
  "origins": [
    "https://canvas.example.com"
  ],
  "workspace": {
    "workspacePath": "/Muse/agent/workspace"
  }
}
```

改完后：

```bash
supervisorctl restart muse2api muse-canvas muse-agent
```

刷新画布：

- 「配置 → 渠道」显示只读提示，地址、Key、模型都不能改；
- Agent 面板地址和 Token 输入框置灰锁定；
- 页面右上角 Agent 自动连接，模型为 `DeepSeek-Flash`。

### 从源码构建前端

仓库已经包含构建好的 `canvas/dist`，一般不需要重新构建。修改 `source/infinite-canvas/web` 后：

```bash
cd source/infinite-canvas/web
npm install --legacy-peer-deps --ignore-scripts
npm run build
rm -rf ../../../canvas/dist
cp -a dist ../../../canvas/dist
```

再重启 `muse-canvas`。

### 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MUSE_API_BASE` | `http://127.0.0.1:1314` | 浏览器访问 API 的地址，不带 `/v1` |
| `MUSE_API_KEY` | 随机生成 | muse2api 访问密钥 |
| `MUSE_CHANNEL_NAME` | `Muse` | 画布渠道显示名 |
| `MUSE2API_HOST` | `0.0.0.0` | API 监听地址 |
| `MUSE2API_PORT` | `1314` | API 端口 |
| `MUSE2API_CONCURRENCY` | `2` | 同时并发的 Muse 任务数 |
| `MUSE2API_CHROMIUM` | 空 | 留空自动探测，或写 `/usr/bin/chromium` |
| `DEEPSEEK_API_KEY` | 空 | 服务端 Agent 的 DeepSeek Key |
| `CANVAS_HOST` | `0.0.0.0` | 画布监听地址 |
| `CANVAS_PORT` | `521` | 画布端口 |
| `CANVAS_ROOT` | 空 | 默认 `canvas/dist` |
| `TZ` | `Asia/Shanghai` | 时区 |

### 常见问题

**画布请求 `http://.../v1` 返回 `{"detail":"Not Found"}`**
接口地址只填到域名或 IP，不要带 `/v1`。画布会自动拼接 `/v1/models`、`/v1/images/generations`。

**浏览器直接打开 `/v1/models` 返回 401**
正常。浏览器地址栏不会带 `Authorization`，画布会自动带 `Bearer`。

**`Failed to fetch` / 混合内容**
HTTPS 画布不能请求 HTTP API。把 `MUSE_API_BASE` 改成 HTTPS，或改用 HTTP 访问画布。

**生图超过 60 秒返回 504**
Nginx 默认 60 秒太短，按上面的 `proxy_read_timeout 600s` 修改。

**Agent 报 `DEEPSEEK_API_KEY ... 未配置`**
`/Muse/.env` 中没有 Key。写入 `DEEPSEEK_API_KEY=sk-...`，`chmod 600`，重启 `muse-agent`。

**Agent 面板 `origin not allowed`**
用 `https://canvas.example.com` 打开画布，或把该来源加入 `canvas-agent.json` 的 `origins`。

**Agent 显示已连接，但发消息报 401**
DeepSeek Key 无效、余额不足或复制时带了空格。重新写入并重启 `muse-agent`。

**视频生成超时**
确认 Nginx 读超时 ≥ 600 秒，并把 `.env` 的 `MUSE2API_CONCURRENCY` 调到机器能承受的值。

### 安全说明

- 本项目默认以 **root** 运行 Agent，Codex 具备执行命令的能力；不要把 Agent 端口裸露给不可信网络。
- `canvas-agent.json` 里的 `token` 会通过 `/config.js` 暴露给能打开画布的人；请给画布加访问控制、防火墙白名单或反向代理认证。
- `.env`、`canvas-agent.json`、Muse Cookie 都是敏感凭据，权限保持 `600`，不要提交到 Git。
- 如果要把本项目公开部署，请自行增加登录、限流和审计。

### 致谢

由衷感谢两个上游项目的作者，没有他们就没有这套组合：

- **muse2api** — 作者 [@czg86389-hub](https://github.com/czg86389-hub)  
  仓库：<https://github.com/czg86389-hub/muse2api>  
  感谢把 Muse 封装成稳定的 OpenAI 兼容接口，并提供了账号池、任务队列和管理台。
- **infinite-canvas** — 作者 [@basketikun](https://github.com/basketikun)  
  仓库：<https://github.com/basketikun/infinite-canvas>  
  感谢做出这么好用的无限画布、Agent 协议和前端工程。

两个上游项目均为 **MIT License**；本仓库的集成代码同样以 MIT 发布，详见 `LICENSE` 与 `NOTICE`。

---

## English

### What is this

This repository combines two excellent open-source projects into one deployable system:

1. **[muse2api](https://github.com/czg86389-hub/muse2api)** — reverse-engineers Muse(muse.ai) into an OpenAI-compatible API for image generation/editing, video generation, and chat.
2. **[infinite-canvas](https://github.com/basketikun/infinite-canvas)** — an infinite canvas workspace for AI creation that calls OpenAI-compatible APIs directly from the browser.
3. **The integration layer added here**:
   - Locks the default canvas provider to server-side `.env` values; the browser cannot edit the base URL, key, or models.
   - Locks the Agent URL/token to `canvas-agent.json`; the browser shows read-only fields and auto-connects.
   - Adds `canvas_server.py`, a dependency-free Python static server for the built frontend.
   - Adds `install.sh`, 1Panel Supervisor examples, Nginx SSE examples, and bilingual docs.
   - Patches muse2api to accept canvas multipart video requests, `n` images, and `first_frame` / `last_frame` / `image[]` references.

### Features

- Infinite canvas with text, image, video, and audio nodes, references, and projects.
- Muse models: `muse-image`, `muse-video`, `muse-spark`.
- Server-side Agent: Codex App Server talks to DeepSeek's Responses API and controls the canvas through MCP tools.
- Provider lock: `MUSE_API_BASE`, `MUSE_API_KEY`, and the model list live only in server `.env`.
- Agent lock: browser URL and token come only from `agent/.infinite-canvas/canvas-agent.json`.
- One `install.sh` sets up Python, the Node Agent, Codex, secrets, and Supervisor arguments.
- Bilingual documentation and reproducible 1Panel / Nginx deployment steps.

### Architecture

```text
Browser (https://canvas.example.com)
  ├─ Infinite Canvas static app
  ├─ /config.js injected by canvas_server.py
  └─ Agent panel (read-only URL/token)
        │
        ├── HTTPS ──> canvas_server :521
        │                 └─ static files + /config.js
        │
        └── HTTPS ──> Nginx ──> canvas-agent :17371
                              └─ Codex app-server
                                   ├─ DeepSeek Responses API
                                   └─ MCP tools → canvas

canvas ──> muse2api :1314 ──> Muse account pool + Chromium CDP
```

### Repository layout

```text
Muse-Canvas/
├── README.md                     # This file (Chinese + English)
├── LICENSE                       # MIT
├── NOTICE                        # Upstream attribution
├── .env.example                  # Server environment template
├── install.sh                    # One-shot installer (Debian / Ubuntu)
├── start-api.sh                  # Start muse2api
├── start-canvas.sh               # Start the canvas static server
├── canvas_server.py              # Python static server + /config.js injection
├── supervisor.conf.example       # 1Panel Supervisor reference
├── nginx-agent.conf.example      # Nginx/SSE reference for the Agent
├── muse2api/                     # Patched Muse API source
├── canvas/dist/                  # Prebuilt Infinite Canvas frontend
├── agent/
│   ├── package.json              # @basketikun/canvas-agent
│   ├── start-agent.sh            # Server-side Agent launcher
│   └── codex/                    # Codex + DeepSeek config and model catalog
└── source/infinite-canvas/       # Upstream Infinite Canvas source
```

### Requirements

- Debian 12+ / Ubuntu 22.04+ (other distros: install dependencies manually).
- Python 3.10+.
- Node.js 18+ (20/22 recommended).
- Chromium or Google Chrome (required by muse2api).
- 2 vCPU / 4 GB RAM minimum; 4 vCPU / 8 GB recommended for video.
- A Muse account (Cookie import).
- A DeepSeek API key (`sk-...`) for the Agent.

### Quick start

#### 1. Upload and extract

```bash
sudo mkdir -p /Muse
sudo tar -xzf Muse-Canvas.tar.gz -C /Muse --strip-components=1
cd /Muse
```

You can also `git clone` the repository into `/Muse`.

#### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

At minimum:

```ini
MUSE_API_BASE=https://api.example.com
MUSE_API_KEY=replace-with-a-long-random-string
DEEPSEEK_API_KEY=sk-your-deepseek-key
```

Notes:

- `MUSE_API_BASE` is the **browser-facing** Muse API URL. No trailing `/`, no `/v1`.
- If the canvas is served over HTTPS, this must also be HTTPS, otherwise browsers block mixed content.
- `MUSE_API_KEY` is the muse2api access key, not the Muse account password.
- `DEEPSEEK_API_KEY` is only used by the server-side Agent and is never shipped to the frontend.

#### 3. Install

```bash
sudo -E bash install.sh
```

The installer:

1. Installs Python, Chromium, Node, fonts, and related packages.
2. Creates `.venv` and installs muse2api dependencies.
3. Keeps an existing `.env`; generates a random `MUSE_API_KEY` when creating a new one.
4. Validates and stores `DEEPSEEK_API_KEY`.
5. Installs `@basketikun/canvas-agent@0.6.0` under `agent/`.
6. Creates `agent/.infinite-canvas/canvas-agent.json` (token, public URL, allowed origins, workspace).
7. Prints the three Supervisor entries, the Agent token, and the admin URL.

Override the placeholders when your domains differ:

```bash
sudo -E env \
  AGENT_PUBLIC_URL="https://agent.example.com" \
  AGENT_ORIGINS="https://canvas.example.com https://muse.example.com" \
  bash install.sh
```

#### 4. 1Panel Supervisor

Install Supervisor from 1Panel's Toolbox, then create:

| Name | User | Working directory | Command |
| --- | --- | --- | --- |
| `muse2api` | root | `/Muse` | `/bin/bash /Muse/start-api.sh` |
| `muse-canvas` | root | `/Muse` | `/bin/bash /Muse/start-canvas.sh` |
| `muse-agent` | root | `/Muse/agent` | `/bin/bash /Muse/agent/start-agent.sh` |

Use one process per entry. Logs are under `/Muse/logs/`.

#### 5. Reverse proxy and HTTPS

Recommended domains:

| Domain | Upstream | Purpose |
| --- | --- | --- |
| `canvas.example.com` | `127.0.0.1:521` | Infinite Canvas |
| `api.example.com` | `127.0.0.1:1314` | Muse API |
| `agent.example.com` | `127.0.0.1:17371` | Server-side Agent |

API Nginx settings (generation can exceed 60 seconds):

```nginx
proxy_connect_timeout 60s;
proxy_send_timeout    600s;
proxy_read_timeout    600s;
proxy_buffering       off;
client_max_body_size  200M;
```

Agent Nginx settings (SSE must not be buffered):

```nginx
proxy_http_version 1.1;
proxy_set_header   Host $host;
proxy_set_header   X-Real-IP $remote_addr;
proxy_buffering    off;
proxy_cache        off;
gzip               off;
proxy_read_timeout 3600s;
client_max_body_size 100M;
```

> The canvas and API must both use HTTPS or both use HTTP. An HTTPS canvas cannot call an HTTP API.

#### 6. Import a Muse account

Open:

```text
https://api.example.com/admin?key=YOUR_MUSE_API_KEY
```

Import Muse cookies with the Chrome extension in `muse2api/extension/`, or paste `hatch_sess` / `hatch_vml` from DevTools:

```text
hatch_sess=......; hatch_vml=......
```

Then click "Test" on the account.

#### 7. Locked configuration

Only two files matter:

**`/Muse/.env`** — provider lock:

```ini
MUSE_API_BASE=https://api.example.com
MUSE_API_KEY=your-random-key
MUSE_CHANNEL_NAME=Muse
DEEPSEEK_API_KEY=sk-...
```

**`/Muse/agent/.infinite-canvas/canvas-agent.json`** — Agent lock:

```json
{
  "url": "http://127.0.0.1:17371",
  "publicUrl": "https://agent.example.com",
  "token": "36-char token generated by the installer",
  "origins": ["https://canvas.example.com"],
  "workspace": { "workspacePath": "/Muse/agent/workspace" }
}
```

Restart after changes:

```bash
supervisorctl restart muse2api muse-canvas muse-agent
```

On refresh:

- Settings → Providers shows a read-only notice; URL, key, and models cannot be edited.
- The Agent URL/token fields are disabled.
- The Agent auto-connects with `DeepSeek-Flash`.

### Build the frontend from source

A prebuilt `canvas/dist` is included. To rebuild:

```bash
cd source/infinite-canvas/web
npm install --legacy-peer-deps --ignore-scripts
npm run build
rm -rf ../../../canvas/dist
cp -a dist ../../../canvas/dist
```

Restart `muse-canvas`.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `MUSE_API_BASE` | `http://127.0.0.1:1314` | Browser-facing API URL; no `/v1` |
| `MUSE_API_KEY` | random | muse2api access key |
| `MUSE_CHANNEL_NAME` | `Muse` | Provider display name |
| `MUSE2API_HOST` | `0.0.0.0` | API bind address |
| `MUSE2API_PORT` | `1314` | API port |
| `MUSE2API_CONCURRENCY` | `2` | Concurrent Muse tasks |
| `MUSE2API_CHROMIUM` | empty | Auto-detect, or set `/usr/bin/chromium` |
| `DEEPSEEK_API_KEY` | empty | DeepSeek key for the Agent |
| `CANVAS_HOST` | `0.0.0.0` | Canvas bind address |
| `CANVAS_PORT` | `521` | Canvas port |
| `CANVAS_ROOT` | empty | Defaults to `canvas/dist` |
| `TZ` | `Asia/Shanghai` | Time zone |

### Troubleshooting

**`{"detail":"Not Found"}` for `http://.../v1`**  
Use the root URL only; the canvas appends `/v1/...` itself.

**401 when opening `/v1/models` in a browser**  
Expected: browsers do not send `Authorization`. The canvas sends the Bearer token.

**`Failed to fetch` / mixed content**  
An HTTPS canvas cannot call an HTTP API. Switch `MUSE_API_BASE` to HTTPS or serve the canvas over HTTP.

**Image generation returns 504 after ~60s**  
Raise Nginx `proxy_read_timeout` to 600s and disable buffering.

**Agent reports `DEEPSEEK_API_KEY ... 未配置`**  
Add `DEEPSEEK_API_KEY=sk-...` to `/Muse/.env`, `chmod 600`, restart `muse-agent`.

**Agent says `origin not allowed`**  
Open the canvas at `https://canvas.example.com` or add that origin to `canvas-agent.json`.

**Agent connects but a turn returns 401**  
The DeepSeek key is invalid, out of credit, or has whitespace. Rewrite it and restart `muse-agent`.

**Video generation times out**  
Set Nginx read timeout ≥ 600s and tune `MUSE2API_CONCURRENCY`.

### Security

- The Agent runs as **root** and Codex can execute commands. Do not expose `agent.example.com` to untrusted networks.
- The `token` in `canvas-agent.json` is embedded in `/config.js` and is visible to anyone who can open the canvas. Add access control, firewall rules, or reverse-proxy auth.
- `.env`, `canvas-agent.json`, and Muse cookies are secrets. Keep them `600` and never commit them.
- Add login, rate limiting, and auditing before exposing this publicly.

### Credits

Huge thanks to the upstream authors:

- **muse2api** — [@czg86389-hub](https://github.com/czg86389-hub)  
  <https://github.com/czg86389-hub/muse2api>  
  For turning Muse into a stable OpenAI-compatible API, with account pooling, task queues, and an admin UI.
- **infinite-canvas** — [@basketikun](https://github.com/basketikun)  
  <https://github.com/basketikun/infinite-canvas>  
  For the excellent infinite canvas, Agent protocol, and frontend engineering.

Both upstream projects are **MIT licensed**. The integration code here is also released under MIT; see `LICENSE` and `NOTICE`.

---

If this project helps you, please star the two upstream repositories as well — most of the credit belongs to their authors.
