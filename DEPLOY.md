# 部署到免费云平台（不用电脑）

把 bridge 和网易云 API 装进**一个容器**，部署到 Render 免费层。部署完成后电脑可以关机，设备照常放歌。

## 这套服务在做什么

```
小智平台 (api.xiaozhi.me)
      ▲  bridge 主动外连（出向 WebSocket，不需要公网 IP）
      │
[ 容器 ]  bridge.js ──► 127.0.0.1:3377 (NeteaseCloudMusicApi)
      │                        │
      │ 返回网易云 CDN 直链     ▼
      └──────────────► 设备直接 GET CDN（206 / 支持 Range）
```

三个关键取舍：

| 决定 | 原因 |
|---|---|
| 一个容器跑两个进程 | 免费层按「每服务 750 小时/月」计费，拆两个服务各占 730 小时会超额 |
| `NCM_STREAM_MODE=direct` | 设备直连 CDN，砍掉 ffmpeg 和对外媒体端口；实测 4 首歌（含 VIP）全部 206 |
| 单独起 `health.js` | direct 模式下 bridge 不起 HTTP 服务，但平台要求必须绑端口并通过健康检查 |

## 一、准备两个值

**1. MCP 接入点地址**（必填）

本机上这两个文件里各有一行，就是你要填的值：

```
~/.config/xiaozhi-netease-mcp/endpoint.txt
~/.config/xiaozhi-netease-mcp/endpoint_axi.txt
```

多个地址用**英文逗号**连接，填到环境变量 `XIAOZHI_MCP_ENDPOINTS`。

> 这是访问凭据，只填进平台的 Secret/环境变量，不要提交到仓库、不要贴到聊天里。

**2. 网易云 Cookie**（可选，想听 VIP 完整版才需要）

不填也能用，但 VIP 曲目只有 30~45 秒试听片段。填了才有完整版。值就是 `MUSIC_U=...` 那一串。

## 二、代码仓库（已完成）

代码已推到 **public** 仓库：

```
https://github.com/lixiaoxiang2023/xiaozhi-netease-mcp
```

选 public 的原因：Actions 分钟数不计费，保活可以直接用 GitHub 定时任务；同时 Render 可以直接用「Public Git repository」部署，**不需要授权 GitHub 账号**。仓库里没有任何凭据（`.gitignore` 已排除 `config.json`、`endpoint*.txt`、`*.log`）。

## 三、在 Render 创建（两种方式，选一种）

**方式 A：Public Git repository（推荐，不授权、不装 GitHub App）**

1. render.com → **New** → **Web Service**
2. 选最下面 **Public Git repository**，填 `https://github.com/lixiaoxiang2023/xiaozhi-netease-mcp`
3. Runtime 选 **Docker**，Region 选 **Singapore**，Plan 选 **Free**
4. 展开 **Advanced** → **Add Environment Variable**，逐个填：

| Key | Value |
|---|---|
| `NCM_STREAM_MODE` | `direct` |
| `NCM_PLAY_BITRATE` | `128000` |
| `XIAOZHI_MCP_ENDPOINTS` | 两个接入点，英文逗号拼接 |
| `NETEASE_COOKIE` | 可留空（VIP 完整版才需要） |

5. Health Check Path 填 `/health`，点 **Create Web Service**

**方式 B：Blueprint（env 已预声明，但要授权一次 GitHub）**

1. render.com → **New** → **Blueprint** → 选中本仓库
2. 自动读 `render.yaml`，把标了 `sync: false` 的两项手填
3. 点 **Apply**

首次构建约 3~5 分钟（要装 NeteaseCloudMusicApi 的依赖）。

## 四、必须做的一步：保活

Render 免费层**15 分钟没有入站请求就休眠**，休眠后接入点断开，你对设备说“放歌”会失败。

仓库里已带 `.github/workflows/keepalive.yml`，默认按 `https://xiaozhi-netease-mcp.onrender.com/health` 每 10 分钟敲一次。**域名对不上时要改**：

1. 打开仓库 → Settings → Secrets and variables → Actions → **Variables**
2. New repository variable：Name `HEALTH_URL`，Value `https://<你的服务名>.onrender.com/health`
3. Actions 页面手动 Run 一次 `keepalive`，看到 `HTTP 200` 即成功

> 服务名不是 `xiaozhi-netease-mcp` 时（重名会被加后缀），第一步就看 Render 控制台顶部的 URL。
>
> 更稳的替代：去 [cron-job.org](https://cron-job.org) 建任务，每 5 分钟 GET 同一个 `/health`。它有 1 分钟级精度，不受 GitHub cron 排队影响。

## 五、验证顺序

1. **Render 日志**应出现：

```
[boot] API 就绪
[boot] 健康检查端口 10000
[agent#1] 已连接
[agent#2] 已连接
```

2. **小智控制台** → 智能体 → MCP 接入点，刷新工具列表，应能看到 `play_song` / `search_songs` / `music_chart`
3. **对设备说「播放晴天」**

## 六、本地服务可以关掉

确认云端跑通后，本机这两个进程就不需要了：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'bridge\.js|NeteaseCloudMusicApi' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 七、换成别的平台

`Dockerfile` 是通用的，下面这些平台直接选 Docker 部署即可，环境变量同上：

| 平台 | 免费额度 | 注意 |
|---|---|---|
| Render | 750 小时/月 | 会休眠，需保活 |
| Fly.io | 按用量，有免费额度 | 需绑卡；`fly launch` 直接读 Dockerfile |
| Zeabur / Sealos | 小额免费额度 | 国内访问较快 |
| Oracle Cloud 永久免费 | 4 核 24G ARM，不停机 | 需绑卡，注册有门槛；最稳 |

## 八、排错

| 现象 | 原因 |
|---|---|
| 日志 `没有有效的接入点地址` | `XIAOZHI_MCP_ENDPOINTS` 没填，或不是 `wss://` 开头 |
| 日志 `握手被拒: HTTP 400` | 该接入点已被别处占用（本机 bridge 没停）或 token 失效；body 里写着原因 |
| 日志反复 `已断开，3 秒后重连` | 接入点 token 失效，回控制台重新生成接入点 |
| 控制台工具列表为空 | bridge 没连上；先看日志有没有 `已连接` |
| 设备说“播放失败” | 看 bridge 日志的 `[media]` 行；`direct` 模式下应直接出现 CDN 域名 |
| 播放只有 30 秒 | 未填 `NETEASE_COOKIE`，或账号非黑胶 VIP |

**最快的排查方式**：浏览器打开 `https://<你的服务名>.onrender.com/health`，返回里 `agents` 就是每个接入点的实时状态，不用翻 Render 日志：

```json
{"bridge_running":true,"agents":{
  "agent#1":{"state":"connected","attempts":1,"lastError":null},
  "agent#2":{"state":"rejected","httpStatus":400,"lastError":"HTTP 400 {\"error\":...}"}}}
```

`state`：`connecting` / `connected` / `rejected`（握手被拒）/ `error`。

> 网易云 API（3377）现在只绑 `127.0.0.1`，不再被 Render 记成“新增开放端口”——那句 `Detected a new open port HTTP:3377` 不会再出现。
