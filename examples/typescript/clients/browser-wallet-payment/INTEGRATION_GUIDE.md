# 浏览器钱包集成指南

本文档介绍如何在其他 Vue3 项目中集成浏览器钱包登录、签名和 x402 支付功能模块。

> **重要说明**：本项目的 POST 请求功能已从 SSE（Server-Sent Events）流式连接改为普通的 HTTP POST 请求。虽然相关文件仍命名为 `useSSE.ts`，但实际功能已改为处理标准 HTTP POST 请求，支持自动处理 x402 支付流程。

## 目录

- [概述](#概述)
- [依赖安装](#依赖安装)
- [核心模块说明](#核心模块说明)
- [集成步骤](#集成步骤)
- [使用示例](#使用示例)
- [API 参考](#api-参考)
- [常见问题](#常见问题)

## 概述

本项目提供了三个核心功能模块：

1. **钱包连接（useWallet）** - 连接浏览器钱包（如 MetaMask），创建签名器，并自动切换网络
2. **支付请求（usePayment）** - 使用 x402 协议自动处理支付请求（GET 请求）
3. **POST 请求（usePost）** - 使用 x402 协议处理带支付功能的 HTTP POST 请求

### 技术栈

- Vue 3 (Composition API)
- x402-axios - 自动处理 402 支付响应
- x402/client - 创建支付签名
- axios - HTTP 客户端
- viem - 以太坊交互库

## 依赖安装

### 1. 安装核心依赖

```bash
npm install axios x402-axios x402 viem
```

或者使用 yarn:

```bash
yarn add axios x402-axios x402 viem
```

### 2. 安装开发依赖（如未安装）

```bash
npm install -D typescript @types/node
```

## 核心模块说明

### 1. useWallet - 钱包管理

位置: `src/composables/useWallet.ts`

**功能：**

- 检测并连接浏览器钱包（MetaMask、Coinbase Wallet 等）
- 自动切换到 Base Sepolia 测试网络
- 创建签名器（Signer）用于支付签名
- 创建带支付拦截器的 Axios 实例
- 监听账户和网络变化

**导出函数：**

- `connectWallet()` - 连接钱包
- `disconnectWallet()` - 断开钱包连接
- `getApiClient()` - 获取带支付拦截器的 API 客户端
- `useWallet()` - 返回钱包状态和方法的组合式函数

### 2. usePayment - 支付请求（GET）

位置: `src/composables/usePayment.ts`

**功能：**

- 使用带支付拦截器的 API 客户端发起 GET 请求
- 自动处理 402 支付响应
- 解析支付响应头信息

**导出函数：**

- `usePayment()` - 返回支付相关的状态和方法

### 3. usePost - POST 请求处理

位置: `src/composables/useSSE.ts`（注意：文件名仍为 useSSE，但功能已改为 POST 请求）

**功能：**

- 使用普通 HTTP POST 请求自动处理支付流程
- 支持自定义请求体（JSON）
- 自动处理 402 支付响应并重试请求

**工作流程：**

1. 首次发起 POST 请求获取支付要求（可能返回 402 响应）
2. 解析支付要求并创建支付签名
3. 再次发起 POST 请求，携带 `X-PAYMENT` header
4. 返回最终响应结果

**导出函数：**

- `usePost()` / `useSSE()` - 返回 POST 请求相关的状态和方法（两种命名方式都支持）

## 集成步骤

### 步骤 1: 复制核心文件

将以下文件复制到你的 Vue3 项目中：

```
src/
  composables/
    useWallet.ts      # 钱包管理
    usePayment.ts     # 支付请求（GET）
    useSSE.ts         # POST 请求处理（注意：文件名仍为 useSSE，但功能已改为 POST）
```

### 步骤 2: 配置环境变量

在项目根目录创建或更新 `.env` 文件：

```env
VITE_API_BASE_URL=http://localhost:3001
```

### 步骤 3: 在组件中使用

#### 基础使用示例

```vue
<template>
  <div>
    <!-- 钱包连接 -->
    <div v-if="!isConnected">
      <button @click="handleConnect">连接钱包</button>
    </div>
    <div v-else>
      <p>已连接: {{ address }}</p>
      <button @click="handleDisconnect">断开连接</button>
    </div>

    <!-- 支付请求 -->
    <div v-if="isConnected">
      <input v-model="endpoint" placeholder="API 端点" />
      <button @click="makeRequest" :disabled="isRequesting">
        {{ isRequesting ? "请求中..." : "发起请求" }}
      </button>
      <div v-if="paymentResult">
        <pre>{{ JSON.stringify(paymentResult, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import {
  connectWallet,
  disconnectWallet as disconnect,
  useWallet,
} from "./composables/useWallet";
import { usePayment } from "./composables/usePayment";

// 钱包状态
const wallet = useWallet();
const isConnected = wallet.isConnected;
const address = wallet.address;

// 支付状态
const endpoint = ref("");
const payment = usePayment();
const paymentResult = payment.paymentResult;
const isRequesting = payment.isRequesting;

// 连接钱包
const handleConnect = async () => {
  try {
    await connectWallet();
    console.log("钱包连接成功");
  } catch (error: any) {
    console.error("钱包连接失败:", error.message);
  }
};

// 断开钱包
const handleDisconnect = () => {
  disconnect();
};

// 发起支付请求
const makeRequest = async () => {
  if (!endpoint.value.trim()) {
    alert("请输入 API 端点");
    return;
  }

  try {
    await payment.makePaymentRequest(endpoint.value);
    console.log("请求成功");
  } catch (error: any) {
    console.error("请求失败:", error.message);
  }
};
</script>
```

## 使用示例

### 示例 1: 基础钱包连接

```typescript
import { connectWallet, useWallet } from "./composables/useWallet";

const wallet = useWallet();

// 连接钱包
async function connect() {
  try {
    await connectWallet();
    console.log("钱包地址:", wallet.address.value);
    console.log("网络:", wallet.network.value);
  } catch (error) {
    console.error("连接失败:", error);
  }
}

// 断开钱包
function disconnect() {
  wallet.disconnectWallet();
}
```

### 示例 2: 发起支付请求

```typescript
import { usePayment } from "./composables/usePayment";

const payment = usePayment();

async function requestPremiumContent() {
  try {
    const result = await payment.makePaymentRequest("/api/premium-content");

    if (result.success) {
      console.log("数据:", result.data);
      console.log("支付响应:", result.paymentResponse);
    } else {
      console.error("请求失败:", result.error);
    }
  } catch (error: any) {
    console.error("请求异常:", error.message);
  }
}
```

### 示例 3: POST 请求处理

```vue
<template>
  <div>
    <div class="post-controls">
      <div>
        <label>URL:</label>
        <input v-model="postUrl" placeholder="http://localhost:4021/generate" />
      </div>
      <div>
        <label>请求体 (JSON):</label>
        <textarea
          v-model="postBody"
          placeholder='{"prompt": "Hello"}'
        ></textarea>
      </div>
      <button @click="makePostRequest" :disabled="isRequestingPost">
        {{ isRequestingPost ? "提交中..." : "提交请求" }}
      </button>
      <button @click="clearPostResponse" :disabled="!postResponse">
        清除结果
      </button>
    </div>

    <!-- 错误信息 -->
    <div v-if="postError" class="error">{{ postError }}</div>

    <!-- 响应结果 -->
    <div v-if="postResponse" class="response">
      <h3>响应结果:</h3>
      <div class="response-status">
        <span
          >状态: {{ postResponse.status }}
          {{ postResponse.statusText || "" }}</span
        >
      </div>
      <pre>{{ JSON.stringify(postResponse, null, 2) }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useSSE } from "./composables/useSSE";

const postUrl = ref("http://localhost:4021/generate");
const postBody = ref('{"prompt": "Hello"}');

const post = useSSE(); // 注意：虽然文件名是 useSSE，但功能是 POST 请求
const postResponse = post.postResponse;
const isRequestingPost = post.isRequesting;
const postError = post.postError;

async function makePostRequest() {
  if (!postUrl.value.trim()) {
    alert("请输入 URL");
    return;
  }

  try {
    // 解析请求体
    let body: Record<string, any> | undefined;
    if (postBody.value.trim()) {
      try {
        body = JSON.parse(postBody.value);
      } catch (error) {
        alert("无效的 JSON 格式");
        return;
      }
    }

    await post.makePostRequest(postUrl.value, body);
    console.log("POST 请求成功");
  } catch (error: any) {
    console.error("POST 请求失败:", error.message);
  }
}

function clearPostResponse() {
  post.clearResponse();
}
</script>
```

### 示例 4: 自定义 API 客户端

```typescript
import { useWallet } from "./composables/useWallet";
import axios from "axios";

const wallet = useWallet();

// 获取带支付拦截器的 API 客户端
function getCustomApiClient() {
  if (!wallet.isConnected.value) {
    throw new Error("请先连接钱包");
  }

  return wallet.getApiClient();
}

// 使用自定义配置
async function customRequest() {
  const api = getCustomApiClient();

  try {
    const response = await api.post("/api/custom-endpoint", {
      data: "example",
    });
    console.log("响应:", response.data);
  } catch (error: any) {
    console.error("请求失败:", error.message);
  }
}
```

## API 参考

### useWallet()

返回钱包状态和方法的组合式函数。

**返回值：**

```typescript
{
  isConnected: ComputedRef<boolean>;      // 是否已连接
  address: ComputedRef<string | null>;    // 钱包地址
  network: ComputedRef<string>;          // 当前网络
  isConnecting: ComputedRef<boolean>;    // 是否正在连接
  walletError: ComputedRef<string | null>; // 错误信息
  signer: ComputedRef<Signer | null>;    // 签名器实例
  connectWallet: () => Promise<void>;    // 连接钱包
  disconnectWallet: () => void;          // 断开钱包
  getApiClient: () => AxiosInstance;     // 获取 API 客户端
}
```

**方法说明：**

#### `connectWallet()`

连接浏览器钱包并创建签名器。

```typescript
await connectWallet();
```

**抛出错误：**

- `Error: Please install MetaMask or another Ethereum wallet` - 未检测到钱包
- `Error: No accounts found` - 没有找到账户
- `Error: Unable to add Base Sepolia network` - 无法添加网络

#### `disconnectWallet()`

断开钱包连接并清理资源。

```typescript
disconnectWallet();
```

#### `getApiClient()`

获取带支付拦截器的 Axios 实例。

```typescript
const api = getApiClient();
const response = await api.get("/api/endpoint");
```

**抛出错误：**

- `Error: Please connect wallet first` - 钱包未连接

---

### usePayment()

返回支付相关的状态和方法。

**返回值：**

```typescript
{
  paymentResult: Ref<any>; // 支付结果
  isRequesting: Ref<boolean>; // 是否正在请求
  makePaymentRequest: (endpoint: string) => Promise<PaymentResult>;
}
```

**方法说明：**

#### `makePaymentRequest(endpoint: string)`

发起支付请求。如果 API 返回 402 响应，会自动处理支付并重试请求。

```typescript
const result = await payment.makePaymentRequest("/api/premium-content");
```

**参数：**

- `endpoint: string` - API 端点路径（支持相对路径和完整 URL）

**返回值：**

```typescript
{
  success: boolean;
  data?: any;                    // 响应数据
  paymentResponse?: any;          // 支付响应信息
  status?: number;                // HTTP 状态码
  headers?: Record<string, any>;  // 响应头
  error?: string;                 // 错误信息
  errorDetails?: string;          // 详细错误信息
}
```

**抛出错误：**

- `Error: Please enter API endpoint` - 端点为空
- `Error: Please connect wallet first` - 钱包未连接
- 其他请求错误

---

### usePost() / useSSE()

返回 POST 请求相关的状态和方法。

**注意：** 虽然文件名是 `useSSE.ts`，但功能已改为处理 HTTP POST 请求。两种命名方式都支持。

**返回值：**

```typescript
{
  postResponse: Ref<PostResponse | null>;  // POST 响应结果
  isRequesting: Ref<boolean>;              // 是否正在请求
  postError: Ref<string | null>;           // 错误信息
  makePostRequest: (url: string, body?: Record<string, any>) => Promise<PostResponse>;
  clearResponse: () => void;               // 清除响应
}
```

**类型定义：**

```typescript
interface PostResponse {
  success: boolean;
  data?: any; // 响应数据
  status?: number; // HTTP 状态码
  statusText?: string; // HTTP 状态文本
  headers?: Record<string, string>; // 响应头
  error?: string; // 错误信息
  errorDetails?: any; // 详细错误信息
}
```

**方法说明：**

#### `makePostRequest(url: string, body?: Record<string, any>)`

发起 POST 请求并自动处理支付。

```typescript
await post.makePostRequest("http://localhost:4021/generate", {
  prompt: "Hello",
});
```

**参数：**

- `url: string` - API 端点 URL（支持相对路径和完整 URL）
- `body?: Record<string, any>` - 请求体（JSON 对象）

**工作流程：**

1. **首次请求**：使用普通 axios 客户端发起 POST 请求
   - 如果返回 200，直接返回响应（无需支付）
   - 如果返回 402，解析支付要求
2. **处理支付**：
   - 解析 402 响应中的支付要求
   - 选择支付方案（base-sepolia 网络，exact 方案）
   - 使用钱包签名器创建支付 header
3. **重试请求**：再次发起 POST 请求，携带 `X-PAYMENT` header
4. **返回结果**：返回最终响应结果

**返回值：**

```typescript
{
  success: true,
  data: any,                    // 响应数据
  status: 200,                  // HTTP 状态码
  statusText: "OK",             // HTTP 状态文本
  headers: Record<string, string> // 响应头
}
```

**抛出错误：**

- `Error: 请求正在进行中，请稍候` - 已有请求在进行
- `Error: 请先连接钱包` - 钱包未连接
- `Error: 无效的 402 响应格式` - 支付响应格式错误
- 其他请求错误

#### `clearResponse()`

清除响应结果。

```typescript
post.clearResponse();
```

## 常见问题

### Q1: 如何切换到其他网络？

默认网络为 `base-sepolia`。要切换到其他网络，需要修改 `useWallet.ts` 中的以下部分：

```typescript
// 修改网络名称
const network = ref<string>("your-network-name");

// 修改链 ID（在 switchToBaseSepolia 函数中）
const chainId = "0xYourChainId";
```

支持的网络名称请参考 `x402/types` 包中的网络定义。

### Q2: 如何自定义 API 基础 URL？

在 `.env` 文件中设置：

```env
VITE_API_BASE_URL=https://your-api.com
```

或在 `useWallet.ts` 中直接修改：

```typescript
const baseClient = axios.create({
  baseURL: "https://your-api.com", // 修改这里
  headers: {
    "Content-Type": "application/json",
  },
});
```

### Q3: 支付请求失败怎么办？

检查以下几点：

1. **钱包是否已连接**：确保调用 `connectWallet()` 成功
2. **网络是否正确**：确保钱包连接到 Base Sepolia 网络
3. **余额是否充足**：确保钱包中有足够的 USDC 代币
4. **端点是否正确**：检查 API 端点路径是否正确
5. **查看控制台日志**：检查浏览器控制台的错误信息

### Q4: POST 请求如何处理支付流程？

POST 请求的支付处理流程如下：

1. **首次请求**：发起不带支付 header 的 POST 请求

   - 如果服务器返回 200，说明不需要支付，直接返回结果
   - 如果服务器返回 402，说明需要支付，进入下一步

2. **支付处理**：

   - 解析 402 响应中的 `x402Version` 和 `accepts` 字段
   - 选择匹配的支付方案（默认使用 base-sepolia 网络和 exact 方案）
   - 使用钱包签名器创建支付签名
   - 生成 `X-PAYMENT` header

3. **重试请求**：携带 `X-PAYMENT` header 再次发起 POST 请求
   - 服务器验证支付签名
   - 如果验证通过，返回 200 和实际数据
   - 如果验证失败，可能返回 402 或其他错误

**示例代码：**

```typescript
import { useSSE } from "./composables/useSSE";

const post = useSSE(); // 注意：虽然文件名是 useSSE，但功能是 POST 请求

// 发起 POST 请求，自动处理支付
try {
  const result = await post.makePostRequest("http://localhost:4021/generate", {
    prompt: "Hello",
  });

  if (result.success) {
    console.log("请求成功:", result.data);
  }
} catch (error) {
  console.error("请求失败:", error);
}
```

### Q5: 如何处理多个钱包提供者？

当前实现使用 `window.ethereum`，它会自动检测第一个可用的钱包。如果需要支持多个钱包，可以：

1. 使用 `window.ethereum.providers` 检测多个提供者
2. 让用户选择钱包
3. 使用选中的提供者创建签名器

### Q6: 如何在 Nuxt 3 中使用？

1. 将 composables 文件放在 `composables/` 目录
2. 确保在客户端使用（使用 `<ClientOnly>` 组件或 `process.client` 检查）
3. 钱包相关代码只能在浏览器环境运行

```vue
<template>
  <ClientOnly>
    <WalletComponent />
  </ClientOnly>
</template>
```

### Q7: 如何测试支付功能？

1. **使用测试网络**：确保连接到 Base Sepolia 测试网络
2. **获取测试代币**：从 Base Sepolia 水龙头获取测试 USDC
3. **测试端点**：使用支持 x402 协议的测试 API 端点
4. **检查日志**：查看浏览器控制台的详细日志

### Q8: POST 请求和 GET 请求的区别？

- **GET 请求（usePayment）**：

  - 使用 `x402-axios` 的支付拦截器自动处理
  - 适用于不需要请求体的简单请求
  - 自动重试机制，无需手动处理

- **POST 请求（usePost）**：
  - 手动处理支付流程（先获取 402，再重试）
  - 支持自定义请求体（JSON）
  - 更灵活，可以控制请求的具体流程

**选择建议：**

- 如果只需要简单的 GET 请求，使用 `usePayment`
- 如果需要发送请求体或需要更多控制，使用 `usePost`

## 更多资源

- [x402 协议文档](https://github.com/your-repo/x402)
- [x402-axios 文档](../../../packages/x402-axios/README.md)
- [示例项目](../browser-wallet-payment/)

## 许可证

MIT
