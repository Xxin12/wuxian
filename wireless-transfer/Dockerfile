# 无线传输 - 轻量化 Docker 镜像
# 服务端是「零依赖」Node 程序（仅用内置模块，连 WebSocket 都手搓），
# 因此无需 npm install、无需构建步骤，镜像只装一个 Node 运行时即可。
FROM node:22-alpine

# 以非 root 用户运行，减小攻击面（alpine 自带 node 用户）
WORKDIR /app

# 仅复制运行必需的文件，保持构建上下文与镜像精简
COPY server.js ./
COPY public ./public

# 容器内监听 0.0.0.0，与本地一致；PORT 可用环境变量覆盖
ENV PORT=3000
EXPOSE 3000

USER node

# 健康检查：复用 /healthz
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
