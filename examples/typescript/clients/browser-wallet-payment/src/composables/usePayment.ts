import { ref } from "vue";
import { getApiClient } from "./useWallet";
import { decodeXPaymentResponse } from "x402-axios";

const paymentResult = ref<any>(null);
const isRequesting = ref<boolean>(false);

export function usePayment() {
  const makePaymentRequest = async (endpoint: string) => {
    if (!endpoint.trim()) {
      throw new Error("Please enter API endpoint");
    }

    isRequesting.value = true;
    paymentResult.value = null;

    try {
      const api = getApiClient();

      // Check if it's a full URL (starts with http:// or https://)
      const isFullUrl =
        endpoint.startsWith("http://") || endpoint.startsWith("https://");

      // Make request (will automatically handle 402 payment response)
      // If full URL, use directly; otherwise treat as relative path
      // axios automatically ignores baseURL when encountering a full URL
      const requestUrl = isFullUrl
        ? endpoint
        : endpoint.startsWith("/")
        ? endpoint
        : `/${endpoint}`;

      // Add debug logs
      console.log("[Payment Request] Making request:", requestUrl);

      const response = await api.get(requestUrl);

      console.log("[Payment Request] Request successful:", response.status);

      // Parse payment response
      const paymentResponseHeader = response.headers["x-payment-response"];
      const paymentResponse = paymentResponseHeader
        ? decodeXPaymentResponse(paymentResponseHeader)
        : null;

      paymentResult.value = {
        success: true,
        data: response.data,
        paymentResponse,
        status: response.status,
        headers: {
          "x-payment-response": paymentResponseHeader,
        },
      };

      return paymentResult.value;
    } catch (error: any) {
      // Add debug logs
      console.error("[Payment Request] Request failed:", error);
      console.error("[Payment Request] Error details:", {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
        stack: error.stack,
      });

      // More detailed error information
      const errorMessage = error.message || "Unknown error";
      const errorDetails = error.response?.data || {};
      const statusCode = error.response?.status;

      // If it's a 402 error, provide clearer guidance
      let userFriendlyMessage = errorMessage;
      if (statusCode === 402) {
        if (errorDetails.x402Version && errorDetails.accepts) {
          // Check if it's a payment processing failure (possibly signature generation failure)
          if (errorMessage.includes("Failed to create payment header") || 
              errorMessage.includes("Failed to parse payment requirements") ||
              errorMessage.includes("Failed to select payment requirements")) {
            userFriendlyMessage = `Payment processing failed: ${errorMessage}. Please check wallet connection and network settings, ensure wallet is connected to the correct network (Base Sepolia).`;
          } else {
            userFriendlyMessage = "Payment processing failed. Please check wallet connection and network settings.";
          }
          console.error("[Payment Request] 402 error - Payment info:", {
            x402Version: errorDetails.x402Version,
            accepts: errorDetails.accepts,
            error: errorMessage,
          });
        } else {
          userFriendlyMessage = "Received 402 payment required, but unable to parse payment information.";
          console.error("[Payment Request] 402 error - Unable to parse payment info:", errorDetails);
        }
      }

      paymentResult.value = {
        success: false,
        error: userFriendlyMessage,
        errorDetails: errorMessage,
        response: errorDetails,
        status: statusCode,
        fullError: error,
      };

      // Re-throw error to let caller know what happened
      const enhancedError = new Error(userFriendlyMessage);
      (enhancedError as any).originalError = error;
      (enhancedError as any).response = error.response;
      throw enhancedError;
    } finally {
      isRequesting.value = false;
    }
  };

  return {
    paymentResult,
    isRequesting,
    makePaymentRequest,
  };
}
