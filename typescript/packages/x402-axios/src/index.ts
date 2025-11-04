import { AxiosInstance, AxiosError } from "axios";
import {
  ChainIdToNetwork,
  PaymentRequirements,
  PaymentRequirementsSchema,
  Signer,
  MultiNetworkSigner,
  isMultiNetworkSigner,
  isSvmSignerWallet,
  Network,
  evm,
  X402Config,
} from "x402/types";
import {
  createPaymentHeader,
  PaymentRequirementsSelector,
  selectPaymentRequirements,
} from "x402/client";

/**
 * Enables the payment of APIs using the x402 payment protocol.
 *
 * When a request receives a 402 response:
 * 1. Extracts payment requirements from the response
 * 2. Creates a payment header using the provided wallet client
 * 3. Retries the original request with the payment header
 * 4. Exposes the X-PAYMENT-RESPONSE header in the final response
 *
 * @param axiosClient - The Axios instance to add the interceptor to
 * @param walletClient - A wallet client that can sign transactions and create payment headers
 * @param paymentRequirementsSelector - A function that selects the payment requirements from the response
 * @param config - Optional configuration for X402 operations (e.g., custom RPC URLs)
 * @returns The modified Axios instance with the payment interceptor
 *
 * @example
 * ```typescript
 * const client = withPaymentInterceptor(
 *   axios.create(),
 *   signer
 * );
 *
 * // With custom RPC configuration
 * const client = withPaymentInterceptor(
 *   axios.create(),
 *   signer,
 *   undefined,
 *   { svmConfig: { rpcUrl: "http://localhost:8899" } }
 * );
 *
 * // The client will automatically handle 402 responses
 * const response = await client.get('https://api.example.com/premium-content');
 * ```
 */
export function withPaymentInterceptor(
  axiosClient: AxiosInstance,
  walletClient: Signer | MultiNetworkSigner,
  paymentRequirementsSelector: PaymentRequirementsSelector = selectPaymentRequirements,
  config?: X402Config,
) {
  axiosClient.interceptors.response.use(
    response => response,
    async (error: AxiosError) => {
      if (!error.response || error.response.status !== 402) {
        return Promise.reject(error);
      }

      try {
        const originalConfig = error.config;
        if (!originalConfig || !originalConfig.headers) {
          return Promise.reject(new Error("Missing axios request configuration"));
        }

        if ((originalConfig as { __is402Retry?: boolean }).__is402Retry) {
          return Promise.reject(error);
        }

        // Ensure response data is in object format
        let responseData: any;
        if (typeof error.response.data === "string") {
          try {
            responseData = JSON.parse(error.response.data);
          } catch (parseError) {
            console.error("[x402-axios] Failed to parse 402 response data:", error.response.data);
            return Promise.reject(new Error("Invalid 402 response format: expected JSON"));
          }
        } else {
          responseData = error.response.data;
        }

        // Validate response data format
        if (!responseData || typeof responseData !== "object") {
          console.error("[x402-axios] Invalid 402 response data:", responseData);
          return Promise.reject(new Error("Invalid 402 response: data is not an object"));
        }

        if (typeof responseData.x402Version !== "number") {
          console.error("[x402-axios] Missing or invalid x402Version:", responseData);
          return Promise.reject(new Error("Invalid 402 response: missing or invalid x402Version"));
        }

        if (!Array.isArray(responseData.accepts)) {
          console.error("[x402-axios] Missing or invalid accepts array:", responseData);
          return Promise.reject(
            new Error("Invalid 402 response: missing or invalid accepts array"),
          );
        }

        const { x402Version, accepts } = responseData;

        console.log("[x402-axios] Processing 402 payment required:", {
          x402Version,
          acceptsCount: accepts.length,
          url: originalConfig.url,
        });

        // Parse payment requirements
        let parsed: PaymentRequirements[];
        try {
          parsed = accepts.map((x: unknown) => PaymentRequirementsSchema.parse(x));
          console.log("[x402-axios] Successfully parsed payment requirements");
        } catch (parseError: any) {
          console.error("[x402-axios] Failed to parse payment requirements:", parseError);
          console.error("[x402-axios] Payment requirements data:", accepts);
          return Promise.reject(
            new Error(`Failed to parse payment requirements: ${parseError.message || parseError}`),
          );
        }

        // Determine network
        const network = isMultiNetworkSigner(walletClient)
          ? undefined
          : evm.isSignerWallet(walletClient as typeof evm.EvmSigner)
            ? ChainIdToNetwork[(walletClient as typeof evm.EvmSigner).chain?.id]
            : isSvmSignerWallet(walletClient as Signer)
              ? (["solana", "solana-devnet"] as Network[])
              : undefined;

        console.log("[x402-axios] Selected network:", network);

        // Select payment requirements
        let selectedPaymentRequirements: PaymentRequirements;
        try {
          selectedPaymentRequirements = paymentRequirementsSelector(parsed, network, "exact");
          console.log("[x402-axios] Selected payment requirements:", {
            scheme: selectedPaymentRequirements.scheme,
            network: selectedPaymentRequirements.network,
            maxAmountRequired: selectedPaymentRequirements.maxAmountRequired,
            resource: selectedPaymentRequirements.resource,
          });
        } catch (selectError: any) {
          console.error("[x402-axios] Failed to select payment requirements:", selectError);
          return Promise.reject(
            new Error(
              `Failed to select payment requirements: ${selectError.message || selectError}`,
            ),
          );
        }

        // Create payment signature
        let paymentHeader: string;
        try {
          console.log("[x402-axios] Creating payment header...");
          paymentHeader = await createPaymentHeader(
            walletClient,
            x402Version,
            selectedPaymentRequirements,
            config,
          );
          console.log("[x402-axios] Payment header created successfully");
        } catch (signError: any) {
          console.error("[x402-axios] Failed to create payment header:", signError);
          console.error("[x402-axios] Sign error details:", {
            message: signError.message,
            stack: signError.stack,
            paymentRequirements: selectedPaymentRequirements,
          });
          return Promise.reject(
            new Error(`Failed to create payment header: ${signError.message || signError}`),
          );
        }

        // Mark as retry request
        (originalConfig as { __is402Retry?: boolean }).__is402Retry = true;

        // Add payment header
        // Note: Access-Control-Expose-Headers is a response header set by the server, should not be sent in request headers
        originalConfig.headers["X-PAYMENT"] = paymentHeader;

        // Ensure URL is correct (if full URL, ensure baseURL is not used)
        const isFullUrl =
          originalConfig.url?.startsWith("http://") || originalConfig.url?.startsWith("https://");
        if (isFullUrl && originalConfig.baseURL) {
          // If using full URL, clear baseURL to avoid conflicts
          const retryConfig = { ...originalConfig, baseURL: undefined };
          console.log("[x402-axios] Retrying request with payment header (full URL):", {
            url: retryConfig.url,
            method: retryConfig.method,
            hasPaymentHeader: !!retryConfig.headers["X-PAYMENT"],
          });
          const secondResponse = await axiosClient.request(retryConfig);
          console.log("[x402-axios] Payment request successful:", secondResponse.status);
          return secondResponse;
        } else {
          console.log("[x402-axios] Retrying request with payment header:", {
            url: originalConfig.url,
            baseURL: originalConfig.baseURL,
            method: originalConfig.method,
            hasPaymentHeader: !!originalConfig.headers["X-PAYMENT"],
          });
          // Retry request
          const secondResponse = await axiosClient.request(originalConfig);
          console.log("[x402-axios] Payment request successful:", secondResponse.status);
          return secondResponse;
        }
      } catch (paymentError: any) {
        console.error("[x402-axios] Payment interceptor error:", paymentError);
        console.error("[x402-axios] Payment error details:", {
          message: paymentError.message,
          response: paymentError.response
            ? {
                status: paymentError.response.status,
                statusText: paymentError.response.statusText,
                data: paymentError.response.data,
                headers: paymentError.response.headers,
              }
            : undefined,
          config: paymentError.config
            ? {
                url: paymentError.config.url,
                baseURL: paymentError.config.baseURL,
                method: paymentError.config.method,
                headers: paymentError.config.headers,
              }
            : undefined,
          stack: paymentError.stack,
        });
        // If error already has detailed information, return directly
        if (paymentError.message) {
          return Promise.reject(paymentError);
        }
        // Otherwise wrap the error
        return Promise.reject(
          new Error(`Payment processing failed: ${paymentError.message || String(paymentError)}`),
        );
      }
    },
  );

  return axiosClient;
}

export { decodeXPaymentResponse } from "x402/shared";
export {
  createSigner,
  createSignerFromProvider,
  type Signer,
  type MultiNetworkSigner,
  type X402Config,
} from "x402/types";
export { type PaymentRequirementsSelector } from "x402/client";
export type { Hex, EIP1193Provider } from "viem";
