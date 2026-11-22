// 免费 PaaS 要求应用绑定平台注入的端口并响应健康检查，
// 而 direct 模式下的 bridge 只做外连 WebSocket、不起 HTTP 服务，
// 所以单独起这个极简服务来占住端口。
//
// 顺带做远程诊断：读 bridge 写下的 /tmp/bridge-status.json，
// 把每个接入点的连接状态回显出来——云端的连接问题不用翻 Render 日志。
const http = require('http');
const fs = require('fs');

const port = Number(process.env.PORT || 10000);
const startedAt = Date.now();
const STATUS_FILE = process.env.BRIDGE_STATUS_FILE || '/tmp/bridge-status.json';
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

const server = http.createServer((req, res) => {
  // 不打印请求头，避免平台日志里留下 access token 片段
  const bridge = readBridgeStatus();
  const body = JSON.stringify({
    ok: true,
    service: 'xiaozhi-netease-mcp',
    mode: process.env.NCM_STREAM_MODE || 'direct',
    endpoints: endpoints.length,
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
    bridge_running: Boolean(bridge),
    agents: bridge ? bridge.agents : null,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[health] listening on 0.0.0.0:${port}, endpoints=${endpoints.length}`);
});
