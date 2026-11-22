// 免费 PaaS 要求应用绑定平台注入的端口并响应健康检查，
// 而 direct 模式下的 bridge 只做外连 WebSocket、不起 HTTP 服务，
// 所以单独起这个极简服务来占住端口。
const http = require('http');

const port = Number(process.env.PORT || 10000);
const startedAt = Date.now();
const endpoints = (process.env.XIAOZHI_MCP_ENDPOINTS || process.env.XIAOZHI_MCP_ENDPOINT || '')
  .split(/[\n,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

const server = http.createServer((req, res) => {
  // 不打印请求头，避免平台日志里留下 access token 片段
  const body = JSON.stringify({
    ok: true,
    service: 'xiaozhi-netease-mcp',
    mode: process.env.NCM_STREAM_MODE || 'direct',
    endpoints: endpoints.length,
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
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
