#!/usr/bin/env node
// 小智 MCP 接入点 bridge：把歌曲搜索/排行榜封装为 MCP 工具。
// 接入点地址只从环境变量 XIAOZHI_MCP_ENDPOINT 或用户目录下的私有文件读取，
// 绝不写入仓库、stdout/stderr 或日志文件。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const API_BASE = process.env.NCM_API_BASE || 'http://127.0.0.1:3377';
const PRIVATE_DIR = path.join(os.homedir(), '.config', 'xiaozhi-netease-mcp');
// 网易云登录态。未登录时 VIP / 独家版权的歌只能拿到 30 秒试听片段
// （响应里带 freeTrialInfo，end=30），听感就是"播了几句就没了"。
// 把浏览器登录后的 cookie（关键字段 MUSIC_U）写进私有 config.json 的
// netease_cookie，或用环境变量 NCM_COOKIE 传入，即可拿到完整音源。
// 同时兼容 NCM_COOKIE / NETEASE_COOKIE 两个环境变量名（部署面板填的是后者），
// 以及 config.json 里的 netease_cookie / cookie 两个键名。
const NCM_COOKIE = String(resolveSetting(['netease_cookie', 'cookie'],
  ['NCM_COOKIE', 'NETEASE_COOKIE'], '') || '');
// 支持多个智能体：默认读取 endpoint.txt，可选再读取 endpoint_*.txt。
const EXTRA_ENDPOINT_FILES = ['endpoint_axi.txt'];
const PROTOCOL_VERSION = '2024-11-05';

// 流畅度优化：复用 HTTP 连接、降低默认码率、缓存短时效结果。
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const SEARCH_CACHE_MS = 30_000;
const URL_CACHE_MS = 180_000;
const CHART_CACHE_MS = 600_000;
const DEFAULT_BITRATE = 128_000;
const PLAY_BITRATE = (() => {
  const n = Number(process.env.NCM_PLAY_BITRATE);
  return Number.isFinite(n) && n >= 32_000 && n <= 320_000 ? n : DEFAULT_BITRATE;
})();
const cache = new Map();
// 拉取 CDN 音频时伪装成浏览器：ffmpeg 默认 UA（Lavf/...）会被部分网易云节点 403。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ==== 播放流畅度：本地转码代理 ====
// 设备直连网易 CDN 时首包约 600ms，且固件 MP3 通路要把 44.1kHz 立体声混单再重采样到
// 16k/24k，既费 CPU 又没有预缓冲，网络稍有抖动就断音。
// 开启后设备改为从本机局域网拉流：延迟 <5ms、带宽充裕，且音频已预转成
// 目标采样率的单声道 MP3，固件跳过重采样。
const STREAM_MODE = resolveSetting('stream_mode', 'NCM_STREAM_MODE', 'direct').toLowerCase();
const PROXY_PORT = Number(resolveSetting('proxy_port', 'NCM_PROXY_PORT', 8899));
const TRANSCODE_SR = (() => {
  const n = Number(resolveSetting('transcode_sr', 'NCM_TRANSCODE_SR', 24000));
  return [8000, 16000, 24000, 32000, 44100, 48000].includes(n) ? n : 24000;
})();
const TRANSCODE_BR = (() => {
  const n = Number(resolveSetting('transcode_br', 'NCM_TRANSCODE_BR', 48));
  return Number.isFinite(n) && n >= 16 && n <= 128 ? Math.round(n) : 48; // kbps
})();
const MEDIA_CACHE_DIR = path.join(os.homedir(), '.cache', 'xiaozhi-netease-mcp', 'media');
const PREFETCH_WAIT_MS = 6000;     // 返回地址前等整首转码完成的最长时间（冷启动几秒，之后全走缓存）
const TRANSCODE_WAIT_MS = 1500;    // 设备来拉流时先等转码完成，但必须小于固件的连接超时（2s），
                                   // 否则设备在拿到响应头之前就 "Wait for HTTP headers receive timeout"。
                                   // 超过这个时间就降级为边转边发，让设备至少先拿到响应头。
const MEDIA_CACHE_LIMIT = 800 * 1024 * 1024; // 转码缓存上限，超出按最旧清理

function lanIp() {
  if (process.env.NCM_PROXY_HOST) return String(process.env.NCM_PROXY_HOST).trim();
  const v4 = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4 || a.internal) continue;
      const ip = a.address;
      if (/^(198\.(18|19)\.|169\.254\.|0\.)/.test(ip)) continue; // Clash TUN / 链路本地
      if (/^192\.168\.(137|144|88)\./.test(ip)) continue;         // Windows 热点、VMware 虚拟网卡
      v4.push({ ip, name });
    }
  }
  if (!v4.length) return '';
  // 优先真实物理网卡上的 192.168.x
  v4.sort((a, b) => {
    const score = (x) => (/^192\.168\./.test(x.ip) ? 0 : /^10\./.test(x.ip) ? 1 : 2)
      + (/vmware|virtual|loopback|vEthernet|本地连接\*|蓝牙/i.test(x.name) ? 10 : 0);
    return score(a) - score(b);
  });
  return v4[0].ip;
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const probes = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312',
      'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311',
      'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'),
  ];
  for (const dir of probes) {
    try {
      const exe = fs.readdirSync(dir).find(f => /^ffmpeg.*\.exe$/i.test(f));
      if (exe) return path.join(dir, exe);
    } catch { /* 目录不存在 */ }
  }
  return 'ffmpeg'; // 交给 PATH
}

const FFMPEG_BIN = findFfmpeg();
// songId -> { file, proc, done, error, startedAt }
const mediaJobs = new Map();
// 自愈：统计本地地址是否真的被设备拉取过。一次都没成功过就回退官方直链。
const localOffer = { total: 0, served: 0, lastAt: 0, disabled: false, offeredIds: new Set() };

function markLocalServed(songId) {
  if (localOffer.offeredIds.has(songId)) localOffer.served += 1;
}

// 设备若根本访问不到本机（不同网段/防火墙拦截），本地地址永远不会有请求过来。
// 试过一次且 20 秒内没人来拉，就判定不可用并永久回退，避免一直"播放失败"。
function localModeUsable() {
  if (localOffer.disabled) return false;
  if (localOffer.served > 0) return true;
  if (localOffer.total > 0 && Date.now() - localOffer.lastAt > 20000) {
    localOffer.disabled = true;
    log('[media] 本地地址从未被设备拉取，判定设备无法访问本机，本次运行改为官方直链');
    return false;
  }
  return true;
}

function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const promise = Promise.resolve().then(loader).then((value) => {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { value: promise, expires: now + ttlMs });
  return promise;
}

// 配置优先级：环境变量 > 私有 config.json > 内置默认值。
// 私有配置放在仓库外的 PRIVATE_DIR，便于持久化且不会被提交。
function resolveSetting(configKeys, envNames, fallback) {
  const keys = Array.isArray(configKeys) ? configKeys : [configKeys];
  const envs = Array.isArray(envNames) ? envNames : [envNames];
  for (const envName of envs) {
    const envVal = process.env[envName];
    if (envVal !== undefined && String(envVal).trim() !== '') return String(envVal).trim();
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PRIVATE_DIR, 'config.json'), 'utf8'));
    for (const k of keys) {
      if (cfg && cfg[k] !== undefined && cfg[k] !== null && String(cfg[k]).trim() !== '') return cfg[k];
    }
  } catch { /* 未配置则用默认值 */ }
  return fallback;
}

function readEndpoints() {
  // 环境变量优先，可包含多个地址（换行或逗号分隔），用于覆盖所有私有文件。
  const envVal = (process.env.XIAOZHI_MCP_ENDPOINTS || process.env.XIAOZHI_MCP_ENDPOINT || '').trim();
  if (envVal) {
    return envVal.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  }
  const files = [path.join(PRIVATE_DIR, 'endpoint.txt'),
    ...EXTRA_ENDPOINT_FILES.map(f => path.join(PRIVATE_DIR, f))];
  const list = [];
  for (const file of files) {
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v) list.push(v);
    } catch { /* 文件不存在则跳过 */ }
  }
  return list;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function redactError(err) {
  const msg = String(err && err.message || err);
  // 防止 URL/token 随异常进入日志
  return msg.replace(/[?&]token=[^&\s"'<>]+/gi, 'token=[REDACTED]')
            .replace(/wss?:\/\/[^\s"'<>]+/gi, '[ENDPOINT_REDACTED]');
}

// ---- 状态外泄通道 ----
// health.js 是独立进程，读不到 bridge 的内存。这里把每个接入点的连接状态落到
// 临时文件，health.js 读出来塞进 /health，于是浏览器里直接能看到“云端连没连上、
// 被拒的真实原因”，不必去翻 Render 日志。
const STATUS_FILE = process.env.BRIDGE_STATUS_FILE || '/tmp/bridge-status.json';
const statusMap = Object.create(null);
function publishStatus(label, patch) {
  const cur = statusMap[label] || (statusMap[label] = { attempts: 0 });
  if (patch.state === 'connecting') cur.attempts = (cur.attempts || 0) + 1;
  Object.assign(cur, patch);
  cur.ts = new Date().toISOString();
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      pid: process.pid,
      mode: process.env.NCM_STREAM_MODE || 'direct',
      agents: statusMap,
    }));
  } catch { /* 写不进去不影响播放 */ }
}

function apiGet(endpoint, params, timeoutMs = 8000) {
  const url = new URL(endpoint, API_BASE);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  return new Promise((resolve, reject) => {
    const req = http.get(url, {
      headers: {
        Accept: 'application/json',
        ...(NCM_COOKIE ? { Cookie: NCM_COOKIE } : {}),
      },
      agent: httpAgent,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 4e6) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`API 返回非 JSON (HTTP ${res.statusCode})`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('本地音乐 API 超时')));
    req.on('error', reject);
  });
}

function normalizeSong(s) {
  const artists = Array.isArray(s.artists) ? s.artists.map(a => a.name).join('、')
    : (Array.isArray(s.ar) ? s.ar.map(a => a.name).join('、') : '');
  const album = (s.album && s.album.name) || (s.al && s.al.name) || '';
  return {
    id: s.id,
    name: s.name,
    artists,
    album,
    durationMs: s.duration || s.dt || null,
  };
}

// 仅使用网易云官方接口返回的可播放地址；无地址时不编造、不绕过会员/版权限制。
// 指定较低码率，减少 ESP32 侧网络与解码压力，播放更稳。
// 同时带回 freeTrial（试听片段）信息：VIP 歌曲官方只给前 30 秒，必须如实告知，
// 否则用户会把"30 秒后停止"误认为卡顿。
async function getPlayableInfo(songId) {
  const key = `url:${songId}:${PLAY_BITRATE}`;
  return cached(key, URL_CACHE_MS, async () => {
    try {
      const data = await apiGet('/song/url', { id: songId, br: PLAY_BITRATE });
      const item = Array.isArray(data.data) ? data.data[0] : null;
      if (!item || typeof item.url !== 'string' || !item.url) return { url: '', trial: null };
      const ft = item.freeTrialInfo;
      const trial = ft && typeof ft.end === 'number' ? { start: ft.start || 0, end: ft.end } : null;
      return { url: item.url, trial };
    } catch {
      return { url: '', trial: null };
    }
  });
}

async function getPlayableUrl(songId) {
  const info = await getPlayableInfo(songId);
  return info.url;
}

// 绕过缓存重新取一条播放地址：网易云 CDN 链接会绑定节点与时效，
// 部分节点（m801 / jdymusi 等）对非浏览器请求回 403/5XX，换一条通常就好了。
async function refreshPlayableUrl(songId, currentUrl) {
  cache.delete(`url:${songId}:${PLAY_BITRATE}`);
  // 403 通常是某个 CDN 节点级防盗链。换码率会落到不同节点，
  // 而且要优先取"和失败的那条不一样"的链接，否则重试等于原地打转。
  let fallback = '';
  for (const br of [PLAY_BITRATE, 192000, 128000, 320000]) {
    try {
      const data = await apiGet('/song/url', { id: songId, br });
      const item = Array.isArray(data.data) ? data.data[0] : null;
      if (!item || typeof item.url !== 'string' || !item.url) continue;
      if (!fallback) fallback = item.url;
      if (!currentUrl || item.url !== currentUrl) return item.url;
    } catch { /* 试下一个码率 */ }
  }
  return fallback;
}

// ==== 本地转码代理实现 ====

function mediaFile(songId) {
  return path.join(MEDIA_CACHE_DIR, `${songId}-${TRANSCODE_SR}-${TRANSCODE_BR}k.mp3`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 转码缓存超过上限时按最旧清理，避免长期运行占用过多磁盘。
function cleanupMediaCache() {
  try {
    const rows = [];
    for (const f of fs.readdirSync(MEDIA_CACHE_DIR)) {
      if (!f.endsWith('.mp3')) continue;
      const p = path.join(MEDIA_CACHE_DIR, f);
      try { const st = fs.statSync(p); rows.push({ p, size: st.size, mtime: st.mtimeMs }); } catch { /* 忽略 */ }
    }
    let total = rows.reduce((a, b) => a + b.size, 0);
    if (total <= MEDIA_CACHE_LIMIT) return;
    rows.sort((a, b) => a.mtime - b.mtime);
    for (const r of rows) {
      if (total <= MEDIA_CACHE_LIMIT * 0.7) break;
      try { fs.rmSync(r.p, { force: true }); total -= r.size; } catch { /* 忽略 */ }
    }
    log(`[media] 缓存已清理至 ${(total / 1024 / 1024).toFixed(0)} MB`);
  } catch { /* 目录不存在等，忽略 */ }
}

// 启动（或复用）转码任务：CDN 原流 → 目标采样率单声道 MP3 文件。
function startTranscode(rawId, cdnUrl) {
  const songId = String(rawId); // 与 URL 路径中的字符串 key 保持一致
  const existing = mediaJobs.get(songId);
  if (existing) return existing;

  const file = mediaFile(songId);
  const job = { file, proc: null, done: false, error: null, attempt: 0 };
  mediaJobs.set(songId, job);

  try {
    fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
    // 已完整转码过则直接复用（缓存命中，秒开）
    if (fs.existsSync(file) && fs.statSync(file).size > 8192) {
      job.done = true;
      return job;
    }
  } catch { /* 忽略缓存目录异常 */ }

  const tmp = `${file}.part`;
  try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }

  // 网易云不同 CDN 节点（m801 / jdymusi 等）对 ffmpeg 默认 UA 的处理不一致，
  // 部分节点会直接回 403。带上浏览器 UA 与 Referer，并对失败做换节点重试。
  const spawnOnce = (url) => {
    job.currentUrl = url;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-user_agent', BROWSER_UA,
      '-headers', 'Referer: https://music.163.com/\r\n',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', url,
      '-vn', '-ac', '1', '-ar', String(TRANSCODE_SR),
      '-c:a', 'libmp3lame', '-b:a', `${TRANSCODE_BR}k`,
      '-flush_packets', '1', // 及时落盘，设备尽早拿到首包
      '-f', 'mp3', '-y', tmp,
    ];
    let proc;
    try {
      proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    } catch (e) {
      job.error = e;
      return null;
    }
    job.proc = proc;
    proc.stderr.on('data', (b) => {
      const s = String(b).trim();
      if (s) log('[media] ffmpeg:', s.slice(0, 200));
    });
    proc.on('error', (e) => { job.error = e; log('[media] ffmpeg 启动失败:', e.message); });
    proc.on('close', (code) => {
      if (code === 0) {
        try { fs.rmSync(file, { force: true }); fs.renameSync(tmp, file); job.done = true; } catch (e) { job.error = e; }
        const size = job.done ? fs.statSync(file).size : 0;
        log(`[media] 转码完成 ${songId}，${(size / 1024).toFixed(0)} KB`);
        cleanupMediaCache();
        mediaJobs.set(songId, job);
        return;
      }
      if (code === null) { mediaJobs.set(songId, job); return; }
      // 换一个 CDN 链接重试：403/5XX 多为节点级防盗链或链接瞬时失效
      const MAX_RETRY = 2;
      if (job.attempt < MAX_RETRY && !stopped) {
        job.attempt += 1;
        log(`[media] 转码失败 ${songId}（退出码 ${code}），换链接重试第 ${job.attempt} 次`);
        refreshPlayableUrl(songId, job.currentUrl)
          .then((fresh) => {
            if (!fresh) {
              job.error = new Error(`ffmpeg 退出码 ${code}`);
              log(`[media] 换链失败，放弃本地加速 ${songId}`);
              mediaJobs.set(songId, job);
              return;
            }
            spawnOnce(fresh);
          })
          .catch(() => { job.error = new Error(`ffmpeg 退出码 ${code}`); mediaJobs.set(songId, job); });
        return;
      }
      job.error = new Error(`ffmpeg 退出码 ${code}`);
      log(`[media] 转码最终失败 ${songId}（退出码 ${code}）`);
      mediaJobs.set(songId, job);
    });
    return proc;
  };
  spawnOnce(cdnUrl);
  log(`[media] 开始转码歌曲 ${songId} → ${TRANSCODE_SR}Hz 单声道 ${TRANSCODE_BR}kbps`);
  return job;
}

// 等整首转码完成再返回地址：设备拿到的永远是"定长 + 支持 Range"的完整文件，
// 不会再落到"边转边发"的 chunked 分支（设备对 chunked 处理不稳，拉几十 KB 就断，
// 日志表现是 expected 0 bytes / Keep-alive 提前关闭）。冷启动多等几秒，值得。
async function waitPrefetch(job) {
  const deadline = Date.now() + PREFETCH_WAIT_MS;
  while (Date.now() < deadline) {
    if (job.done) return true;
    if (job.error) return false;
    await sleep(100);
  }
  // 超时不代表失败：ffmpeg 仍在跑，让设备先连上来等数据
  return !job.error;
}

// 把音频分块写给设备：已转码部分立即发送，未完成则边转边发。
// 已转码完成的文件：支持 Range（206），让固件断线后能从断点续传。
function serveCompleteFile(res, job, songId, start, reportEnd) {
  const size = fs.statSync(job.file).size;
  const from = Math.min(Math.max(start, 0), size);
  if (from > 0) {
    res.writeHead(206, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(size - from),
      'Content-Range': `bytes ${from}-${size - 1}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Connection': 'close',
    });
    log(`[media] 断点续传 ${songId}：从 ${(from / 1024).toFixed(0)}KB 处继续，剩余 ${((size - from) / 1024).toFixed(0)}KB`);
  } else {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Connection': 'close', // 明确告知结束，避免设备等下一次响应
    });
    log(`[media] 命中缓存，推送 ${songId}，${(size / 1024).toFixed(0)} KB`);
  }
  let sent = 0;
  const rs = fs.createReadStream(job.file, { start: from, highWaterMark: 8 * 1024 });
  rs.on('data', (c) => { sent += c.length; });
  rs.on('error', (e) => {
    log('[media] 读取文件失败:', redactError(e));
    try { res.destroy(); } catch { /* 忽略 */ }
  });
  res.on('close', () => {
    reportEnd(sent < size - from ? '设备提前断开' : '完整发送', sent);
  });
  rs.pipe(res);
}

async function streamMedia(res, job, songId, startOffset = 0) {
  const startedAt = Date.now();
  let sent = 0;
  const reportEnd = (how, bytes) => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const n = bytes === undefined ? sent : bytes;
    log(`[media] 传输结束 ${songId}：${how}，已发 ${(n / 1024).toFixed(0)} KB，用时 ${secs}s`);
  };
  try {
    // 只发"完整文件"这一种响应：定长 Content-Length + 支持 Range。
    // 曾经的"边转边发"是 chunked 响应，没有 Content-Length，固件把它当成
    // expected 0 bytes，读几十 KB 就判定提前关闭，听感是"换首歌就卡/秒退"。
    // 所以转码没完成时干脆回 503，让固件隔一秒重试，等文件好了再一次性推。
    if (!job.done) {
      const deadline = Date.now() + TRANSCODE_WAIT_MS;
      while (!job.done && !job.error && Date.now() < deadline) await sleep(100);
    }

    if (job.done) {
      serveCompleteFile(res, job, songId, startOffset, reportEnd);
      return;
    }

    // 还没转完 / 转码失败（多是源链接 403）：明确返回 503，
    // 固件会重试（内部 kOpenRetries 次，约 12 秒预算），而不是拿到 0 字节的 200 空流干等。
    const reason = job.error ? `转码失败：${job.error.message}` : '转码中，请稍后重试';
    log(`[media] 返回 503 ${songId}（${reason}）`);
    res.writeHead(503, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '1',
      'Connection': 'close',
    });
    res.end(reason);
    reportEnd(job.error ? '转码失败(503)' : '转码中(503)', 0);
  } catch (e) {
    log('[media] 推送失败:', redactError(e));
    try { res.destroy(); } catch { /* 忽略 */ }
  }
}

let proxyServer = null;

function startProxyServer() {
  if (proxyServer) return;
  proxyServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    const m = url.pathname.match(/^\/p\/(\d+)\.mp3$/);
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    const songId = m[1];
    const ua = String(req.headers['user-agent'] || '-').slice(0, 60);
    const range = String(req.headers.range || '-');
    const rangeMatch = range.match(/bytes=(\d+)-/);
    const startOffset = rangeMatch ? Number(rangeMatch[1]) : 0;
    log(`[media] 设备请求拉流 ${songId}（远端 ${req.socket.remoteAddress || '-'}，UA=${ua}，Range=${range}）`);
    markLocalServed(songId);
    // 没有预热任务时按需转码：兼容 bridge 重启后设备仍拿着旧地址的情况。
    (async () => {
      let job = mediaJobs.get(songId);
      if (!job) {
        const cdn = await getPlayableUrl(songId);
        if (!cdn) { res.writeHead(404); res.end('no url'); return; }
        job = startTranscode(songId, cdn);
      }
      await streamMedia(res, job, songId, startOffset);
    })().catch(e => {
      log('[media] 流异常:', redactError(e));
      try { res.destroy(); } catch { /* 忽略 */ }
    });
  });
  proxyServer.on('error', (e) => log('[media] 本地服务异常:', redactError(e)));
  proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    log(`[media] 本地流媒体服务已启动：http://${lanIp() || '0.0.0.0'}:${PROXY_PORT}/`);
  });
}

// local 模式下返回局域网地址；拿不到网卡或 ffmpeg 不可用则回退官方直链。
function localStreamUrl(songId) {
  const host = lanIp();
  if (!host) return '';
  return `http://${host}:${PROXY_PORT}/p/${songId}.mp3`;
}

async function searchSongsRaw(keywords, limit) {
  const key = `search:${keywords}:${limit}`;
  return cached(key, SEARCH_CACHE_MS, async () => {
    const data = await apiGet('/cloudsearch', { keywords, limit, type: 1, offset: 0 });
    return (data.result && data.result.songs) || [];
  });
}

async function searchSongs(args) {
  const keywords = String(args.keywords || '').trim();
  if (!keywords) throw new Error('请提供 keywords（歌曲名、歌手或关键词）');
  const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 10);
  const songs = await searchSongsRaw(keywords, limit);
  if (!songs.length) return `没有找到与「${keywords}」相关的歌曲。`;
  const withUrls = await Promise.all(songs.slice(0, limit).map(async (s) => ({
    song: normalizeSong(s),
    info: await getPlayableInfo(s.id),
  })));
  const lines = withUrls.map((x, i) => {
    const n = x.song;
    const head = `${i + 1}. ${n.name} — ${n.artists || '未知歌手'}（ID：${n.id}）`;
    if (!x.info.url) {
      return `${head}\n   （官方接口未返回可播放地址，可能受会员/版权限制，本工具不绕过）`;
    }
    let playUrl = x.info.url;
    if (STREAM_MODE === 'local') {
      const lp = localStreamUrl(n.id);
      if (lp) {
        playUrl = lp;
        localOffer.total += 1;
        localOffer.lastAt = Date.now();
        localOffer.offeredIds.add(String(n.id));
      }
    }
    const trialTag = x.info.trial
      ? `（仅 ${x.info.trial.end - x.info.trial.start} 秒试听片段）` : '';
    return `${head}${trialTag}\n   audio_url：${playUrl}`;
  });
  return `搜索「${keywords}」：\n${lines.join('\n')}` +
    '\n\n用户想直接听歌时优先调用 play_song；若已选本列表歌曲，把 audio_url 作为 song 参数调用 ' +
    'self.music.play_song，并在调用之后不要再输出任何文字或语音（设备收到播报会立刻停掉音乐）。不要朗读地址。';
}

// 一步到位：搜索并解析出一首可播放歌曲，减少一次用户选择与一次长文本播报。
async function playSong(args) {
  const rawKeywords = String(args.keywords || '').trim();
  const artist = String(args.artist || '').trim();
  const keywords = artist && !rawKeywords.includes(artist)
    ? `${artist} ${rawKeywords}` : rawKeywords;
  if (!keywords) throw new Error('请提供 keywords（歌曲名、歌手或关键词）');
  // 取 10 首而不是 3 首：无登录态时版权差异极大，前几首常常整批 404，
  // 多几个候选能明显提高“总能找到一首能放”的概率（实测晴天前 3 首全 null）
  const songs = await searchSongsRaw(keywords, 10);
  if (!songs.length) return `没有找到与「${keywords}」相关的歌曲。`;

  // 先并行确认候选曲目的可播放性，再挑一首最合适的：
  // 完整曲目优先，其次是官方试听片段，避免直接把 30 秒试听当成"播放成功"。
  const candidates = await Promise.all(songs.map(async (s) => ({
    song: s, info: await getPlayableInfo(s.id),
  })));
  const playable = candidates.filter(c => c.info.url);
  if (!playable.length) {
    const names = songs.slice(0, 3).map(s => normalizeSong(s).name).join('、');
    return `「${keywords}」搜到 ${songs.length} 首（${names} 等），但都没有可播放地址：` +
      '原唱多需黑胶会员，未登录时官方接口会直接返回空（试听片段也不给）。' +
      '可以换个歌手版本重试，或让管理员填 NETEASE_COOKIE 解锁完整版。';
  }
  // 候选多了以后不能盲取第一首，否则「晴天」会放成某个翻唱：
  // 完整曲目 +10，歌名/歌手命中关键词每项 +3
  const tokens = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = playable.map((c) => {
    const n = normalizeSong(c.song);
    const hay = `${n.name || ''} ${n.artists || ''}`.toLowerCase();
    const hit = tokens.filter((t) => hay.includes(t)).length;
    return { c, s: (c.info.trial ? 0 : 10) + hit * 3 };
  });
  scored.sort((a, b) => b.s - a.s);
  const chosen = scored[0].c;

  {
    const s = chosen.song;
    const info = chosen.info;
    const cdnUrl = info.url;
    const n = normalizeSong(s);

    // local 模式：让设备从本机局域网拉已转码音频，避开公网抖动与固件重采样。
    let url = cdnUrl;
    if (STREAM_MODE === 'local' && localModeUsable()) {
      const job = startTranscode(s.id, cdnUrl);
      await waitPrefetch(job);
      const local = localStreamUrl(s.id);
      if (local && !job.error) {
        url = local;
        localOffer.total += 1;
        localOffer.lastAt = Date.now();
        localOffer.offeredIds.add(String(s.id));
      } else {
        log('[media] 本地代理不可用，本次回退官方直链');
      }
    }

    const trialNote = info.trial
      ? `\n注意：该曲目受版权限制，官方仅提供 ${info.trial.end - info.trial.start} 秒试听片段，` +
        `播完会自动停止，这是官方限制而非卡顿，请如实告知用户。`
      : '';

    return `已解析到可播放歌曲：\n歌曲：${n.name} — ${n.artists || '未知歌手'}\n` +
      `audio_url：${url}${trialNote}\n` +
      `立即调用 self.music.play_song，参数 song = 上面的 audio_url，auto_next=false。\n` +
      `调用完成后本轮必须静默：不要生成任何回复文字。设备收到播报会立刻切断音乐，` +
      `音乐已经出声，无需再语音确认。不要朗读地址或本说明。`;
  }
}

async function musicChart(args) {
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
  const list = await cached('toplist', CHART_CACHE_MS, () => apiGet('/toplist'));
  const items = Array.isArray(list.list) ? list.list : [];
  if (!items.length) throw new Error('排行榜暂时不可用');
  return `网易云音乐排行榜（共 ${items.length} 个，按更新时间排序，节选 ${Math.min(limit, items.length)} 个）：\n` +
    items.slice(0, limit).map((it, i) =>
      `${i + 1}. ${it.name}（ID：${it.id}，${it.updateFrequency || '更新频率未知'}）`
    ).join('\n');
}

// 设备固件里还有一个「内置网络曲库」工具 self.music.get_playlist / set_playlist_url，
// 它的曲库地址存在 NVS 的 music/playlist_url，默认是空的，调用只会得到「曲库不可用」。
// 这里统一在工具描述里把模型引导到本 MCP 的检索工具，避免它去调那个空曲库报错。
const BUILTIN_PLAYLIST_HINT =
  '\n【重要】设备固件内置曲库（self.music.get_playlist、self.music.set_playlist_url）未配置，调用必定返回“曲库不可用”。' +
  '用户问“有哪些歌手”“有什么歌”“曲库里有什么”“帮我看看歌单”时，不要调用 self.music.get_playlist，' +
  '改用 search_songs 按关键词检索，或用 music_chart 查排行榜。\n' +
  '【禁止自行查询状态或停止播放】绝对不要在播放开始后调用 self.music.control。' +
  '无论是 action=status 还是 action=stop，都会让音乐立刻中断，用户听到的就是“秒退”。' +
  '你对“是否在播”不需要任何确认：上一次 play_song 调用成功返回即表示已在播放。' +
  '只有在用户明确说“停一下”“别放了”“暂停”“下一首”时，才允许调用 self.music.control 的 stop / pause / next。';

const TOOLS = [
  {
    name: 'play_song',
    description: '用户想直接听歌/播放歌曲时的首选工具，内部完成搜索并返回可直接播放的音频地址。\n' +
      '【严格的调用时序，顺序错了音乐会被掐断】\n' +
      '1) 先把你需要对用户说的话全部说完（例如“好的，为你播放谢霆锋的黄种人”），让语音播报结束；\n' +
      '2) 然后调用本工具拿到 audio_url；\n' +
      '3) 紧接着把该 audio_url 作为 song 参数调用设备工具 self.music.play_song；\n' +
      '4) 这一步之后本轮回复必须为空：不要输出任何文字、不要再说“正在播放”、不要解释或总结。\n' +
      '原因：设备一旦在音乐开始后收到任何播报，会立即停止播放。音乐本身已经出声，用户不需要再被语音确认。\n' +
      '【播放期间保持安静】音乐开始后，只要用户没有提出新问题，就不要再输出任何文字或语音；' +
      '不要为了“确认是否在播”而把同一首歌再调一次，也不要主动汇报进度或道歉。' +
      '一次成功的 play_song 之后就是彻底静音，直到用户再次开口。\n' +
      '【连播多首】用户说“全部”“都放一遍”时，可以对每一首依次调用 self.music.play_song：' +
      '设备会把第一首之后的歌排进队列，当前这首播完自动接下一首，不会打断正在播放的歌，' +
      '也不需要道歉或重放。同一首歌不要重复调用。\n' +
      '【播放期间不要调用任何工具】不要调 self.music.control（status / stop 都不行），也不要调 get_playlist。' +
      '这些调用都会打断当前音乐。\n' +
      '不要朗读地址或结果文本。' + BUILTIN_PLAYLIST_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: '歌曲名、歌手名或“歌手+歌名”等关键词' },
        artist: { type: 'string', description: '可选歌手名，用于缩小范围，如“毛不易”' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'search_songs',
    description: '在网易云音乐曲库搜索多首歌曲并列出可播放地址。仅当用户想比较/选择多首歌时使用；用户明确要听歌时优先用 play_song，减少等待与播报。不要朗读地址。' + BUILTIN_PLAYLIST_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: '搜索关键词，如歌名、歌手名' },
        limit: { type: 'integer', description: '返回数量，1-10，默认 3', minimum: 1, maximum: 10 },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'music_chart',
    description: '查询网易云音乐排行榜列表（如飙升榜、热歌榜、新歌榜）。当用户问有哪些排行榜、最近热门歌曲榜单时使用。' + BUILTIN_PLAYLIST_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回榜单数量，1-30，默认 10', minimum: 1, maximum: 30 },
      },
    },
  },
];

// 每个接入点独立管理连接与退避重连，互不影响。
const clients = new Map(); // endpoint -> { ws, timer, delay, label }
let stopped = false;

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (!msg || msg.jsonrpc !== '2.0' || !msg.method) return;
  // 只记录方法名，绝不记录参数或 endpoint
  log('收到 MCP 方法:', msg.method);
  const id = msg.id;
  try {
    switch (msg.method) {
      case 'initialize':
        send(ws, ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'xiaozhi-netease-music', version: '1.0.0' },
        }));
        break;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        break;
      case 'tools/list':
        send(ws, ok(id, { tools: TOOLS }));
        break;
      case 'tools/call': {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        let text;
        if (name === 'play_song') text = await playSong(args);
        else if (name === 'search_songs') text = await searchSongs(args);
        else if (name === 'music_chart') text = await musicChart(args);
        else throw new Error(`未知工具: ${name}`);
        send(ws, ok(id, { content: [{ type: 'text', text }], isError: false }));
        break;
      }
      case 'ping':
        send(ws, ok(id, {}));
        break;
      case 'resources/list':
        send(ws, ok(id, { resources: [] }));
        break;
      case 'prompts/list':
        send(ws, ok(id, { prompts: [] }));
        break;
      default:
        if (id !== undefined) send(ws, fail(id, -32601, 'Method not found'));
    }
  } catch (e) {
    log('MCP 调用失败:', nameOf(msg), redactError(e));
    if (id !== undefined) {
      send(ws, ok(id, { content: [{ type: 'text', text: redactError(e) }], isError: true }));
    }
  }
}

function nameOf(msg) { return (msg.params && msg.params.name) || msg.method || 'unknown'; }

function connect(endpoint, label) {
  if (stopped) return;
  let state = clients.get(endpoint);
  if (!state) {
    state = { ws: null, timer: null, delay: 1000, label };
    clients.set(endpoint, state);
  }
  log(`[${label}] 正在连接小智 MCP 接入点…（地址已隐藏）`);
  publishStatus(label, { state: 'connecting', lastError: null });
  const ws = new WebSocket(endpoint, { handshakeTimeout: 15000 });
  state.ws = ws;
  ws.on('open', () => {
    state.delay = 1000;
    log(`[${label}] MCP 接入点已连接`);
    publishStatus(label, { state: 'connected', lastError: null });
  });
  ws.on('message', (data) => { handleMessage(ws, data).catch(e => log(`[${label}] 处理消息异常:`, redactError(e))); });
  // 握手被拒时 ws 只会说 "Unexpected server response: 400"，
  // 真正原因（token 失效 / 同一接入点已有连接 / 接入点未启用）在响应 body 里，必须读出来
  ws.on('unexpected-response', (req, res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { if (body.length < 500) body += c; });
    res.on('end', () => {
      const detail = `HTTP ${res.statusCode}${body ? ' ' + body.replace(/\s+/g, ' ').slice(0, 240) : ''}`;
      const msg = redactError(detail);
      log(`[${label}] 握手被拒:`, msg);
      publishStatus(label, { state: 'rejected', httpStatus: res.statusCode, lastError: msg });
      try { ws.terminate(); } catch { /* ignore */ }
    });
    res.on('error', () => { try { ws.terminate(); } catch { /* ignore */ } });
  });
  ws.on('error', (err) => {
    const msg = redactError(err);
    log(`[${label}] 接入点连接错误:`, msg);
    publishStatus(label, { state: 'error', lastError: msg });
  });
  ws.on('close', () => {
    if (state.ws === ws) state.ws = null;
    if (stopped) return;
    log(`[${label}] 接入点断开，将在退避后重连`);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => connect(endpoint, label), state.delay);
    state.delay = Math.min(state.delay * 2, 60000);
  });
}

function main() {
  const endpoints = readEndpoints();
  if (!endpoints.length) {
    log('未配置小智 MCP 接入点：设置 XIAOZHI_MCP_ENDPOINTS 或写入私有文件');
    process.exitCode = 2;
    return;
  }
  const valid = [];
  for (const ep of endpoints) {
    if (!/^wss:\/\//i.test(ep)) {
      log('检测到格式无效的接入点地址（应为 wss://），已跳过：' + redactError(ep));
      continue;
    }
    valid.push(ep);
  }
  if (!valid.length) {
    log('没有有效的接入点地址');
    process.exitCode = 2;
    return;
  }
  log(`共配置 ${valid.length} 个 MCP 接入点`);
  if (STREAM_MODE === 'local') {
    const ip = lanIp();
    if (ip) {
      startProxyServer();
      log(`播放模式 local：设备从 http://${ip}:${PROXY_PORT}/ 拉流，音频 ${TRANSCODE_SR}Hz 单声道 ${TRANSCODE_BR}kbps`);
    } else {
      log('播放模式 local 但未找到可用局域网地址，本次回退官方直链');
    }
  } else {
    log('播放模式 direct：设备直连网易 CDN');
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  valid.forEach((ep, i) => connect(ep, `agent#${i + 1}`));
}

function shutdown() {
  stopped = true;
  for (const state of clients.values()) {
    clearTimeout(state.timer);
    if (state.ws) state.ws.close();
  }
  for (const job of mediaJobs.values()) {
    if (job.proc && !job.done) { try { job.proc.kill(); } catch { /* 忽略 */ } }
  }
  if (proxyServer) { try { proxyServer.close(); } catch { /* 忽略 */ } }
}

if (require.main === module) main();
module.exports = {
  TOOLS, playSong, searchSongs, musicChart, handleMessage, ok, fail,
  startProxyServer, startTranscode, mediaJobs, lanIp,
};
