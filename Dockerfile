FROM node:20-slim

ENV NODE_ENV=production \
    NCM_API_BASE=http://127.0.0.1:3377 \
    NCM_STREAM_MODE=direct \
    API_PORT=3377

WORKDIR /app

# 只装运行时真正需要的两个包。
# 不读 package.json 是为了跳过 leveldown：它是本地提取浏览器登录态用的 native 模块，
# 在 Linux 容器里编译要拉全量 node-gyp 工具链，而云端根本用不到。
RUN npm install --omit=dev --no-audit --no-fund \
        ws@^8 \
        NeteaseCloudMusicApi@^4.34.1

COPY bridge.js health.js start.sh ./
RUN chmod +x start.sh

EXPOSE 10000

CMD ["sh", "start.sh"]
