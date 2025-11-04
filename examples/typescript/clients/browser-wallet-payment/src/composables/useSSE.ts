import { ref } from "vue";
import { useWallet } from "./useWallet";
import { createPaymentHeader, selectPaymentRequirements } from "x402/client";
import { PaymentRequirementsSchema } from "x402/types";
import axios from "axios";

export interface SSEMessage {
  type: "message" | "error" | "open" | "close";
  data: string;
  timestamp: string;
}

const sseMessages = ref<SSEMessage[]>([]);
const isConnecting = ref<boolean>(false);
const isConnected = ref<boolean>(false);
const sseError = ref<string | null>(null);
let abortController: AbortController | null = null;

export function useSSE() {
  const wallet = useWallet();

  const connectSSE = async (url: string, params?: Record<string, any>) => {
    if (isConnecting.value || isConnected.value) {
      throw new Error("SSE 连接已存在，请先关闭");
    }

    if (!wallet.isConnected.value || !wallet.signer.value) {
      throw new Error("请先连接钱包");
    }

    isConnecting.value = true;
    sseError.value = null;
    sseMessages.value = [];
    abortController = new AbortController();

    try {
      let fullUrl = url;

      // 如果是完整 URL，直接使用；否则需要构建完整 URL
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        const baseURL =
          import.meta.env.VITE_API_BASE_URL || "http://localhost:4021";
        fullUrl = url.startsWith("/")
          ? `${baseURL}${url}`
          : `${baseURL}/${url}`;
      }

      // Step 1: 使用不带支付拦截器的 axios 获取支付要求（402 响应）
      addSSEMessage("正在获取支付要求...", "message");

      let paymentHeader: string;

      try {
        // 使用普通的 axios 实例（不带支付拦截器）来获取 402 响应
        const baseClient = axios.create({
          headers: {
            "Content-Type": "application/json",
          },
        });

        const response = await baseClient.post(
          fullUrl,
          params || {}, // 将参数作为 JSON body 发送
          {
            validateStatus: (status) => status === 402 || status === 200, // 接受 402 和 200
          }
        );

        if (response.status === 402) {
          // 解析支付要求
          const { x402Version, accepts } = response.data;

          if (!x402Version || !accepts || !Array.isArray(accepts)) {
            throw new Error("无效的 402 响应格式");
          }

          // 解析支付要求
          const parsedPaymentRequirements = accepts.map((x) =>
            PaymentRequirementsSchema.parse(x)
          );

          // 选择支付要求（使用 base-sepolia 网络）
          const selectedPaymentRequirements = selectPaymentRequirements(
            parsedPaymentRequirements,
            "base-sepolia",
            "exact"
          );

          addSSEMessage(
            `支付要求: ${selectedPaymentRequirements.maxAmountRequired} (${selectedPaymentRequirements.network})`,
            "message"
          );

          // 创建支付 header
          addSSEMessage("正在创建支付签名...", "message");
          paymentHeader = await createPaymentHeader(
            wallet.signer.value,
            x402Version,
            selectedPaymentRequirements
          );

          addSSEMessage("支付签名创建成功", "message");
        } else if (response.status === 200) {
          // 如果直接返回 200，说明不需要支付，但 SSE 可能仍然需要支付 header
          // 尝试从响应头中获取支付信息，或者直接尝试连接 SSE
          addSSEMessage("端点不需要支付，直接连接 SSE", "message");
          paymentHeader = ""; // 空支付 header
        } else {
          throw new Error(`意外的响应状态: ${response.status}`);
        }
      } catch (error: any) {
        if (error.response?.status === 402) {
          // 如果捕获到 402，尝试处理
          const { x402Version, accepts } = error.response.data;

          if (!x402Version || !accepts || !Array.isArray(accepts)) {
            throw new Error("无效的 402 响应格式");
          }

          const parsedPaymentRequirements = accepts.map((x) =>
            PaymentRequirementsSchema.parse(x)
          );
          const selectedPaymentRequirements = selectPaymentRequirements(
            parsedPaymentRequirements,
            "base-sepolia",
            "exact"
          );

          addSSEMessage(
            `支付要求: ${selectedPaymentRequirements.maxAmountRequired} (${selectedPaymentRequirements.network})`,
            "message"
          );

          addSSEMessage("正在创建支付签名...", "message");
          paymentHeader = await createPaymentHeader(
            wallet.signer.value,
            x402Version,
            selectedPaymentRequirements
          );

          addSSEMessage("支付签名创建成功", "message");
        } else {
          throw error;
        }
      }

      // Step 2: 使用 fetch API 建立 SSE 连接（支持自定义 headers）
      addSSEMessage("正在建立 SSE 连接...", "message");

      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      };

      // 如果有支付 header，添加到请求头
      if (paymentHeader) {
        headers["X-PAYMENT"] = paymentHeader;
      }

      const response = await fetch(fullUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(params || {}), // 将参数作为 JSON body 发送
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(
          `SSE 连接失败: ${response.status} ${response.statusText}`
        );
      }

      if (!response.body) {
        throw new Error("响应体不可读");
      }

      isConnected.value = true;
      addSSEMessage("SSE 连接已建立", "open");

      // Step 3: 读取 SSE 流
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              addSSEMessage("SSE 流已结束", "close");
              break;
            }

            // 解码数据块
            buffer += decoder.decode(value, { stream: true });

            // 处理完整的 SSE 消息（以 \n\n 分隔）
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // 保留最后一个不完整的行

            let eventType = "message";
            let data = "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.substring(7).trim();
              } else if (line.startsWith("data: ")) {
                data += line.substring(6) + "\n";
              } else if (line === "") {
                // 空行表示消息结束
                if (data) {
                  addSSEMessage(data.trim(), eventType as any);
                  data = "";
                }
              }
            }

            // 处理最后一个消息（如果有）
            if (data) {
              addSSEMessage(data.trim(), eventType as any);
            }
          }
        } catch (error: any) {
          if (error.name === "AbortError") {
            addSSEMessage("SSE 连接已取消", "close");
          } else {
            addSSEMessage(`读取错误: ${error.message}`, "error");
            sseError.value = error.message;
          }
        } finally {
          isConnected.value = false;
          isConnecting.value = false;
        }
      };

      // 开始读取流
      readStream();
    } catch (error: any) {
      isConnecting.value = false;
      isConnected.value = false;
      const errorMsg = error.message || String(error);
      sseError.value = errorMsg;
      addSSEMessage(`连接错误: ${errorMsg}`, "error");
      throw error;
    } finally {
      // 如果连接过程中出错，确保状态重置
      if (!isConnected.value) {
        isConnecting.value = false;
      }
    }
  };

  const disconnectSSE = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    isConnected.value = false;
    isConnecting.value = false;
    addSSEMessage("SSE 连接已断开", "close");
  };

  const clearMessages = () => {
    sseMessages.value = [];
  };

  const addSSEMessage = (
    data: string,
    type: SSEMessage["type"] = "message"
  ) => {
    sseMessages.value.push({
      type,
      data,
      timestamp: new Date().toLocaleTimeString("zh-CN"),
    });
  };

  return {
    sseMessages,
    isConnecting,
    isConnected,
    sseError,
    connectSSE,
    disconnectSSE,
    clearMessages,
  };
}
