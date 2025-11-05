# Advanced Server Docker 配置

本目录包含用于构建和运行 `examples/typescript/servers/advanced` 服务的 Docker 配置文件。

## 使用方法

### 构建镜像

在项目根目录执行：

```bash
docker build -f advanced-server/Dockerfile -t advanced-server .
```

### 运行容器

```bash
docker run -d \
  -p 4021:4021 \
  -e FACILITATOR_URL="https://your-facilitator-url.com" \
  -e ADDRESS="0xYourEthereumAddress" \
  -e PROXY_TARGET_URL="http://127.0.0.1:9999" \
  --name advanced-server \
  advanced-server
```

### 使用环境变量文件

```bash
docker run -d \
  -p 4021:4021 \
  --env-file .env \
  --name advanced-server \
  advanced-server
```

## 环境变量

- `FACILITATOR_URL` (必需): Facilitator 服务的 URL
- `ADDRESS` (必需): 接收支付的以太坊地址
- `PROXY_TARGET_URL` (可选): 代理目标 URL，默认为 `http://127.0.0.1:9999`

## 端口

服务默认监听在 `4021` 端口。

