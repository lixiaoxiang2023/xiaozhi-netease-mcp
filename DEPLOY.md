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

## 二、把代码推到一个 Git 仓库

Render 的 Blueprint 从 Git 仓库拉代码。私有仓库也可以（首次授权 GitHub 即可）。

```bash
cd xiaozhi-netease-mcp
git init
git add bridge.js health.js start.sh Dockerfile render.yaml .dockerignore
git commit -m "deploy: 云端版（direct 模式，单容器双进程）"
git remote add origin <你的仓库地址>
git push -u origin main
```

注意 `.dockerignore` 已排除 `node_modules`、`tools/`、`*.json`，不会把本地登录态或缓存带上去。

## 三、在 Render 创建

1. 登录 render.com → **New** → **Blueprint**
2. 选中刚推的仓库，Render 会自动读到 `render.yaml`
3. 它会把 `XIAOZHI_MCP_ENDPOINTS` 和 `NETEASE_COOKIE` 标记为**需要手填**，逐个填上
4. 点 **Apply**，等构建（首次约 3~5 分钟，要装 NeteaseCloudMusicApi 的依赖）

## 四、必须做的一步：保活

Render 免费层**15 分钟没有入站请求就休眠**，休眠后接入点断开，你对设备说“放歌”会失败。

去 [cron-job.org](https://cron-job.org)（免费）建一个任务：

- URL：`https://<你的服务名>.onrender.com/health`
- 间隔：**每 10 分钟**

这样服务不会睡。如果不想保活，就要接受“每次用之前先等一下唤醒（30~50 秒）”。

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
| 日志反复 `已断开，3 秒后重连` | 接入点 token 失效，回控制台重新生成接入点 |
| 控制台工具列表为空 | bridge 没连上；先看日志有没有 `已连接` |
| 设备说“播放失败” | 看 bridge 日志的 `[media]` 行；`direct` 模式下应直接出现 CDN 域名 |
| 播放只有 30 秒 | 未填 `NETEASE_COOKIE`，或账号非黑胶 VIP |
