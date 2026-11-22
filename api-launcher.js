// 只把网易云 API 绑在回环地址 127.0.0.1。
// 原因：Render 会扫描容器里所有监听端口，API 若绑 0.0.0.0:3377 会被平台记成
// “Detected a new open port”，有把主端口判错的风险；而且这个 API 只给同容器的
// bridge 调用，完全不需要对外。
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.API_PORT || 3377);
const HOST = process.env.API_HOST || '127.0.0.1';

(async () => {
  // app.js 启动前会确保这个空文件存在，generateConfig 依赖它
  const tokenPath = path.resolve(os.tmpdir(), 'anonymous_token');
  try {
    if (!fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, '', 'utf-8');
  } catch (e) {
    console.warn('[api] 创建 anonymous_token 失败:', e.message);
  }

  try {
    await require('NeteaseCloudMusicApi/generateConfig')();
  } catch (e) {
    // 拿不到匿名 token 也继续：部分接口仍可用，失败了只影响搜索
    console.warn('[api] generateConfig 失败（继续启动）:', e.message);
  }

  // checkVersion:false —— 省掉启动时对 npm 的一次版本检查，容器里没意义还拖慢冷启动
  await require('NeteaseCloudMusicApi/server').serveNcmApi({
    port: PORT,
    host: HOST,
    checkVersion: false,
  });
  console.log(`[api] 网易云 API 监听 ${HOST}:${PORT}`);
})().catch((e) => {
  console.error('[api] 启动失败:', e);
  process.exit(1);
});
