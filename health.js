// 免费 PaaS 要求应用绑定平台注入的端口并响应健康检查，
// 而 direct 模式下的 bridge 只做外连 WebSocket、不起 HTTP 服务，
// 所以单独起这个极简服务来占住端口。
//
// 顺带做远程诊断（容器里没法开 shell，这两个接口就是唯一窗口）：
//   GET /health  —— bridge 与每个接入点的连接状态
//   GET /diag    —— 在容器内部真正跑一次“搜索 + 取播放地址”，复现放歌链路
const http = require('http');
const fs = require('fs');

const BUILD = 'v6-keepalive'; // 换版本时改这里，用来确认 Render 到底部署了哪一版
const port = Number(process.env.PORT || 10000);
const startedAt = Date.now();
const STATUS_FILE = process.env.BRIDGE_STATUS_FILE || '/tmp/bridge-status.json';
const API_BASE = process.env.NCM_API_BASE || 'http://127.0.0.1:3377';
const endpoints = (process.env.XIAOZHI_MCP_ENDPOINTS || process.env.XIAOZHI_MCP_ENDPOINT || '')
  .split(/[\n,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

function readBridgeStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null; // bridge 还没跑起来，或还没写过
  }
}

// 容器内部请求本地网易云 API；超时/连接拒绝要能区分开
// 环境变量名兼容：部署面板用的是 NETEASE_COOKIE，早期代码用的是 NCM_COOKIE。
const COOKIE = (process.env.NETEASE_COOKIE || process.env.NCM_COOKIE || '').trim();

function apiGet(pathname, params, timeoutMs = 15000) {
  const url = new URL(pathname, API_BASE);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  return new Promise((resolve) => {
    const req = http.get(url, {
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        ...(COOKIE ? { Cookie: COOKIE } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (raw.length < 20000) raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* 保留 raw 片段 */ }
        resolve({ status: res.statusCode, body, raw: body ? null : raw.slice(0, 300) });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求 ${pathname} 超时 ${timeoutMs}ms`)));
    req.on('error', (e) => resolve({ error: e.code ? `${e.code} ${e.message}` : e.message }));
  });
}

async function runDiag(keywords) {
  const out = { build: BUILD, api_base: API_BASE, keywords, cookie: Boolean(COOKIE) };

  // 1. API 有没有活着
  const ping = await apiGet('/search/hot', {}, 10000);
  out.api_alive = Boolean(ping.status);
  if (!out.api_alive) {
    out.api_error = ping.error || 'no response';
    out.hint = '网易云 API 进程没起来（generateConfig 失败或端口没绑），看 Render 日志 [api] 行';
    return out;
  }

  // 2. 搜索
  const s = await apiGet('/cloudsearch', { keywords, limit: 3, type: 1, offset: 0 });
  out.search_http = s.status;
  const songs = (s.body && s.body.result && s.body.result.songs) || [];
  out.search_count = songs.length;
  out.search_code = s.body && s.body.code;
  if (!songs.length) {
    out.search_raw = s.raw;
    out.hint = '搜索为空：要么 API 没拿到匿名 token，要么出口 IP 被网易云限流/地区限制';
    return out;
  }
  out.first = {
    id: songs[0].id,
    name: songs[0].name,
    artists: (songs[0].ar || songs[0].artists || []).map((a) => a.name).join('/'),
    fee: songs[0].fee,
  };

  // 3. 取播放地址（放歌失败的真正分界线）
  const u = await apiGet('/song/url', { id: songs[0].id, br: process.env.NCM_PLAY_BITRATE || 128000 });
  out.url_http = u.status;
  const item = (u.body && u.body.data && u.body.data[0]) || {};
  out.url_has_link = Boolean(item.url);
  out.url_code = item.code;
  out.url_br = item.br;
  out.free_trial = item.freeTrialInfo || null;
  if (item.url) {
    try { out.url_host = new URL(item.url).host; } catch { /* ignore */ }
  } else {
    out.hint = '接口没给播放地址：多为地区/版权限制（境外机房 IP 常见），换地区或改用国内中转';
  }

  // 4. 固定探针：十年（65538）—— 有 cookie + 黑胶 时应是完整版（free_trial 为 null），
  //    无 cookie 则只返回 30 秒试听，两者一比就知道 NETEASE_COOKIE 到底生效没有
  const vipId = Number(process.env.DIAG_VIP_ID || 65538);
  const v = await apiGet('/song/url', { id: vipId, br: process.env.NCM_PLAY_BITRATE || 128000 });
  const vi = (v.body && v.body.data && v.body.data[0]) || {};
  out.vip_probe = {
    id: vipId,
    http: v.status,
    has_link: Boolean(vi.url),
    br: vi.br,
    free_trial: vi.freeTrialInfo || null,
    cannot_listen_reason: (vi.freeTrialPrivilege && vi.freeTrialPrivilege.cannotListenReason) || null,
  };
  return out;
}

const server = http.createServer(async (req, res) => {
  // 不打印请求头，避免平台日志里留下 access token 片段
  const u = new URL(req.url, 'http://localhost');
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (u.pathname === '/diag') {
    try {
      send(await runDiag(u.searchParams.get('kw') || '晴天'));
    } catch (e) {
      send({ build: BUILD, diag_error: String(e && e.message || e) });
    }
    return;
  }

  const bridge = readBridgeStatus();
  send({
    ok: true,
    build: BUILD,
    service: 'xiaozhi-netease-mcp',
    mode: process.env.NCM_STREAM_MODE || 'direct',
    endpoints: endpoints.length,
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
    bridge_running: Boolean(bridge),
    bridge_pid: bridge ? bridge.pid : null,
    agents: bridge ? bridge.agents : null,
    diag: '/diag?kw=晴天',
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[health] listening on 0.0.0.0:${port}, build=${BUILD}, endpoints=${endpoints.length}`);
  startSelfPing();
});

// ==== 自保活 ====
// Render 免费实例 15 分钟没有「入站请求」就休眠，休眠后 bridge 的 WebSocket 断开，
// 平台侧这个智能体等于没有音乐工具，设备只会回「找不到歌」。
// GitHub Actions 的 cron 实测漂移严重（有过整小时不触发），所以这里让容器自己
// 定时请求自己的公网 /health —— 请求经 Render 路由进来，同样算入站流量。
function startSelfPing() {
  const base = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').trim();
  if (!base) {
    console.log('[keepalive] 未提供 RENDER_EXTERNAL_URL，跳过自保活');
    return;
  }
  const period = Number(process.env.SELF_PING_MS) > 30000 ? Number(process.env.SELF_PING_MS) : 5 * 60 * 1000;
  const target = `${base.replace(/\/+$/, '')}/health?self=1`;
  let fails = 0;
  console.log(`[keepalive] 每 ${Math.round(period / 1000)}s 自检 ${target}`);
  const tick = async () => {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (fails) console.log('[keepalive] 恢复正常');
      fails = 0;
    } catch (e) {
      fails += 1;
      if (fails === 1 || fails % 6 === 0) console.log(`[keepalive] 自检失败 ${fails} 次: ${e && e.message}`);
    }
  };
  setInterval(tick, period).unref();
  setTimeout(tick, 30 * 1000).unref();
}
