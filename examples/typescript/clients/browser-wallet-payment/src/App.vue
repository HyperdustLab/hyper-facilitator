<template>
  <div class="app">
    <header>
      <h1>🚀 x402 Browser Wallet Payment Example</h1>
      <p>Use browser wallets (e.g., MetaMask) to sign and complete payments</p>
    </header>

    <main>
      <!-- Wallet connection section -->
      <section class="wallet-section">
        <h2>1. Connect Wallet</h2>
        <div v-if="!isConnected" class="wallet-status">
          <div class="status-disconnected">
            <p>Please connect your wallet first</p>
            <button
              @click="handleConnectWallet"
              :disabled="isConnecting"
              class="btn btn-primary"
            >
              {{ isConnecting ? "Connecting..." : "Connect Wallet" }}
            </button>
          </div>
        </div>
        <div v-else class="wallet-info">
          <div class="info-row">
            <span class="label">Wallet Address:</span>
            <span class="value">{{ formatAddress(address) }}</span>
          </div>
          <div class="info-row">
            <span class="label">Network:</span>
            <span class="value">{{ network || "Unknown" }}</span>
          </div>
          <button @click="handleDisconnectWallet" class="btn btn-secondary">
            Disconnect
          </button>
        </div>
        <div v-if="walletError" class="error-message">{{ walletError }}</div>
      </section>

      <!-- Payment section -->
      <section class="payment-section">
        <h2>2. Make Payment Request</h2>
        <div class="request-controls">
          <input
            v-model="endpoint"
            type="text"
            placeholder="Enter API endpoint (e.g., /api/premium-content)"
            class="input-field"
            :disabled="!isConnected || isRequesting"
          />
          <button
            @click="makePaymentRequest"
            :disabled="!isConnected || !endpoint || isRequesting"
            class="btn btn-primary"
          >
            {{ isRequesting ? "Processing..." : "Make Request" }}
          </button>
        </div>

        <div v-if="paymentResult" class="payment-result">
          <h3>Request Result:</h3>
          <div class="result-content">
            <pre>{{ JSON.stringify(paymentResult, null, 2) }}</pre>
          </div>
        </div>
      </section>

      <!-- SSE section -->
      <section class="sse-section">
        <h2>3. SSE Stream Request</h2>
        <div class="sse-controls">
          <div class="sse-url-input">
            <label for="sse-url">SSE URL:</label>
            <input
              id="sse-url"
              v-model="sseUrl"
              type="text"
              placeholder="http://localhost:4021/generate"
              class="input-field"
              :disabled="!isConnected || isConnectingSSE || isConnectedSSE"
            />
          </div>
          <div class="sse-params-input">
            <label for="sse-params">Parameters (JSON):</label>
            <textarea
              id="sse-params"
              v-model="sseParams"
              placeholder='{"prompt": "Hello"}'
              class="textarea-field"
              :disabled="!isConnected || isConnectingSSE || isConnectedSSE"
              rows="4"
            ></textarea>
          </div>
          <div class="sse-buttons">
            <button
              @click="handleConnectSSE"
              :disabled="
                !isConnected || !sseUrl || isConnectingSSE || isConnectedSSE
              "
              class="btn btn-primary"
            >
              {{
                isConnectingSSE
                  ? "Connecting..."
                  : isConnectedSSE
                  ? "Connected"
                  : "Connect SSE"
              }}
            </button>
            <button
              @click="handleDisconnectSSE"
              :disabled="!isConnectedSSE && !isConnectingSSE"
              class="btn btn-secondary"
            >
              Disconnect
            </button>
            <button @click="clearSSEMessages" class="btn btn-secondary">
              Clear Messages
            </button>
          </div>
        </div>

        <div v-if="sseError" class="error-message">{{ sseError }}</div>

        <div class="sse-messages">
          <h3>SSE Messages:</h3>
          <div class="messages-container">
            <div
              v-for="(msg, index) in sseMessages"
              :key="index"
              :class="['message-item', `message-${msg.type}`]"
            >
              <span class="message-time">{{ msg.timestamp }}</span>
              <span class="message-type">[{{ msg.type.toUpperCase() }}]</span>
              <span class="message-data">{{ msg.data }}</span>
            </div>
            <div v-if="sseMessages.length === 0" class="message-empty">
              No SSE messages yet
            </div>
          </div>
        </div>
      </section>

      <!-- Logs section -->
      <section class="logs-section">
        <h2>4. Operation Logs</h2>
        <div class="logs-container">
          <div
            v-for="(log, index) in logs"
            :key="index"
            :class="['log-item', `log-${log.type}`]"
          >
            <span class="log-time">{{ log.time }}</span>
            <span class="log-message">{{ log.message }}</span>
          </div>
          <div v-if="logs.length === 0" class="log-empty">No logs yet</div>
        </div>
        <button @click="clearLogs" class="btn btn-secondary">Clear Logs</button>
      </section>
    </main>

    <footer>
      <p>
        <strong>Note:</strong> This example demonstrates how to use the
        <code>createSignerFromProvider</code>
        function to integrate browser wallets and complete x402 payments.
      </p>
      <p>
        Make sure your wallet is connected to the
        <strong>Base Sepolia</strong> network and has sufficient USDC tokens.
      </p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import {
  connectWallet,
  disconnectWallet as disconnect,
  useWallet,
} from "./composables/useWallet";
import { usePayment } from "./composables/usePayment";
import { useSSE } from "./composables/useSSE";
import { addLog } from "./utils/logger";

// Wallet state
const wallet = useWallet();
const isConnected = wallet.isConnected;
const address = wallet.address;
const network = wallet.network;
const isConnecting = wallet.isConnecting;
const walletError = wallet.walletError;

// Payment state
const endpoint = ref<string>("");
const payment = usePayment();
const paymentResult = payment.paymentResult;
const isRequesting = payment.isRequesting;

// SSE state
const sseUrl = ref<string>("http://localhost:4021/generate");
const sseParams = ref<string>("");
const sse = useSSE();
const sseMessages = sse.sseMessages;
const isConnectingSSE = sse.isConnecting;
const isConnectedSSE = sse.isConnected;
const sseError = sse.sseError;

// Logs
const logs = ref<Array<{ time: string; message: string; type: string }>>([]);

// Format address
const formatAddress = (addr: string | null): string => {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
};

// Connect wallet
const handleConnectWallet = async () => {
  try {
    await connectWallet();
    addLog("Wallet connected successfully", "success", logs);
  } catch (error: any) {
    addLog(`Wallet connection failed: ${error.message}`, "error", logs);
  }
};

// Disconnect wallet
const handleDisconnectWallet = () => {
  disconnect();
  addLog("Wallet disconnected", "info", logs);
  paymentResult.value = null;
  // Also disconnect SSE if connected
  if (isConnectedSSE.value) {
    sse.disconnectSSE();
  }
};

// Make payment request
const makePaymentRequest = async () => {
  if (!endpoint.value.trim()) {
    addLog("Please enter API endpoint", "error", logs);
    return;
  }

  try {
    addLog(`Requesting: ${endpoint.value}`, "info", logs);
    const result = await payment.makePaymentRequest(endpoint.value);

    if (result.success) {
      addLog("Payment request successful", "success", logs);
      if (result.paymentResponse) {
        addLog(
          `Payment response: ${JSON.stringify(result.paymentResponse)}`,
          "info",
          logs
        );
      }
    } else {
      addLog(`Payment request failed: ${result.error}`, "error", logs);
      if (result.errorDetails) {
        addLog(`Error details: ${result.errorDetails}`, "error", logs);
      }
    }
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    addLog(`Payment request failed: ${errorMsg}`, "error", logs);

    // If it's a 402 error, provide more detailed information
    if (error.response?.status === 402) {
      addLog(
        "Received 402 payment required, processing payment...",
        "info",
        logs
      );
      const errorData = error.response?.data;
      if (errorData?.x402Version && errorData?.accepts) {
        addLog(
          `Payment requirements: x402Version=${errorData.x402Version}, accepting ${errorData.accepts.length} payment methods`,
          "info",
          logs
        );
      }
    }
  }
};

// Connect SSE
const handleConnectSSE = async () => {
  if (!sseUrl.value.trim()) {
    addLog("Please enter SSE URL", "error", logs);
    return;
  }

  try {
    addLog(`Connecting to SSE: ${sseUrl.value}`, "info", logs);

    // Parse parameters if provided
    let params: Record<string, any> | undefined;
    if (sseParams.value.trim()) {
      try {
        params = JSON.parse(sseParams.value);
      } catch (error) {
        addLog("Invalid JSON parameters, ignoring", "error", logs);
      }
    }

    await sse.connectSSE(sseUrl.value, params);
    addLog("SSE connection initiated", "success", logs);
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    addLog(`SSE connection failed: ${errorMsg}`, "error", logs);
  }
};

// Disconnect SSE
const handleDisconnectSSE = () => {
  sse.disconnectSSE();
  addLog("SSE disconnected", "info", logs);
};

// Clear SSE messages
const clearSSEMessages = () => {
  sse.clearMessages();
};

// Clear logs
const clearLogs = () => {
  logs.value = [];
};

// Check wallet connection when component is mounted
onMounted(() => {
  addLog("Page loaded", "info", logs);
});
</script>

<style scoped>
.app {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
}

header {
  text-align: center;
  margin-bottom: 40px;
}

header h1 {
  font-size: 2.5rem;
  margin-bottom: 10px;
  color: #333;
}

header p {
  color: #666;
  font-size: 1.1rem;
}

main section {
  background: white;
  border-radius: 8px;
  padding: 24px;
  margin-bottom: 24px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

section h2 {
  font-size: 1.5rem;
  margin-bottom: 20px;
  color: #333;
  border-bottom: 2px solid #4caf50;
  padding-bottom: 10px;
}

/* Wallet section */
.wallet-status {
  text-align: center;
}

.status-disconnected p {
  margin-bottom: 16px;
  color: #666;
}

.wallet-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.label {
  font-weight: 600;
  color: #333;
}

.value {
  font-family: "Courier New", monospace;
  color: #4caf50;
  background: #f0f9f0;
  padding: 4px 8px;
  border-radius: 4px;
}

/* Request section */
.request-controls {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.input-field {
  flex: 1;
  padding: 12px;
  border: 2px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
}

.input-field:focus {
  outline: none;
  border-color: #4caf50;
}

.input-field:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

/* Buttons */
.btn {
  padding: 12px 24px;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-primary {
  background: #4caf50;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #45a049;
}

.btn-primary:disabled {
  background: #ccc;
  cursor: not-allowed;
}

.btn-secondary {
  background: #666;
  color: white;
}

.btn-secondary:hover {
  background: #555;
}

/* Error message */
.error-message {
  margin-top: 12px;
  padding: 12px;
  background: #ffebee;
  color: #c62828;
  border-radius: 4px;
  border-left: 4px solid #c62828;
}

/* Payment result */
.payment-result {
  margin-top: 20px;
}

.result-content {
  background: #f5f5f5;
  padding: 16px;
  border-radius: 4px;
  overflow-x: auto;
}

.result-content pre {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
}

/* SSE section */
.sse-section {
  background: #f9f9f9;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 20px;
  margin-top: 24px;
}

.sse-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.sse-url-input,
.sse-params-input {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sse-url-input label,
.sse-params-input label {
  font-weight: 600;
  color: #333;
  min-width: 80px;
}

.textarea-field {
  flex: 1;
  padding: 12px;
  border: 2px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
  resize: vertical;
  min-height: 80px;
}

.textarea-field:focus {
  outline: none;
  border-color: #4caf50;
}

.textarea-field:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

.sse-buttons {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

/* SSE Messages */
.sse-messages {
  background: #f0f9eb; /* Light green background */
  border: 1px solid #a5d6a7; /* Green border */
  border-radius: 4px;
  padding: 16px;
  max-height: 300px;
  overflow-y: auto;
  margin-top: 20px;
}

.sse-messages h3 {
  margin-top: 0;
  margin-bottom: 10px;
  color: #4caf50;
  border-bottom: 1px solid #a5d6a7;
  padding-bottom: 5px;
}

.messages-container {
  display: flex;
  flex-direction: column;
}

.message-item {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed #e0f2f7; /* Light blue dashed border */
}

.message-item:last-child {
  border-bottom: none;
}

.message-time {
  color: #999;
  font-size: 0.85rem;
  min-width: 120px;
}

.message-type {
  font-weight: bold;
  color: #2196f3; /* Blue color for type */
}

.message-data {
  flex: 1;
  font-family: "Courier New", monospace;
  font-size: 0.9rem;
  color: #333;
  background: #e0f2f7; /* Light blue background for data */
  padding: 4px 8px;
  border-radius: 4px;
}

.message-success .message-data {
  color: #4caf50; /* Green for success */
  background: #e8f5e9;
}

.message-error .message-data {
  color: #c62828; /* Red for error */
  background: #ffebee;
}

.message-info .message-data {
  color: #2196f3; /* Blue for info */
  background: #e3f2fd;
}

.message-empty {
  text-align: center;
  color: #999;
  padding: 20px;
}

/* Logs section */
.logs-container {
  max-height: 300px;
  overflow-y: auto;
  background: #f5f5f5;
  padding: 16px;
  border-radius: 4px;
  margin-bottom: 16px;
}

.log-item {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #ddd;
}

.log-item:last-child {
  border-bottom: none;
}

.log-time {
  color: #999;
  font-size: 0.85rem;
  min-width: 120px;
}

.log-message {
  flex: 1;
}

.log-success .log-message {
  color: #4caf50;
}

.log-error .log-message {
  color: #c62828;
}

.log-info .log-message {
  color: #2196f3;
}

.log-empty {
  text-align: center;
  color: #999;
  padding: 20px;
}

/* Footer */
footer {
  margin-top: 40px;
  padding: 20px;
  background: #f5f5f5;
  border-radius: 8px;
  text-align: center;
}

footer p {
  margin: 8px 0;
  color: #666;
  line-height: 1.6;
}

footer code {
  background: #e0e0e0;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: "Courier New", monospace;
}
</style>
