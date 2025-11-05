# 使用 Node.js 官方镜像
FROM node:20-slim

# 安装 pnpm
RUN npm install -g pnpm@10.7.0

# 设置工作目录
WORKDIR /app

# 复制 typescript monorepo 配置文件
COPY typescript/package.json typescript/
COPY typescript/pnpm-workspace.yaml typescript/
COPY typescript/pnpm-lock.yaml typescript/
COPY typescript/tsconfig.base.json typescript/

# 复制 x402 包（advanced 服务的依赖）
COPY typescript/packages/x402/ typescript/packages/x402/

# 复制 examples/typescript workspace 配置
COPY examples/typescript/package.json examples/typescript/
COPY examples/typescript/pnpm-workspace.yaml examples/typescript/
COPY examples/typescript/pnpm-lock.yaml examples/typescript/

# 复制 advanced 服务文件
COPY examples/typescript/servers/advanced/ examples/typescript/servers/advanced/

# 设置工作目录到 examples/typescript
WORKDIR /app/examples/typescript

# 安装依赖
RUN pnpm install

# 暴露服务端口
EXPOSE 4021

# 设置环境变量默认值（可以通过 docker run -e 覆盖）
ENV FACILITATOR_URL=""
ENV ADDRESS=""
ENV PROXY_TARGET_URL="http://127.0.0.1:9999"

# 启动服务
CMD ["pnpm", "--filter", "advanced-server-example", "dev"]

