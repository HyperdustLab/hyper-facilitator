/**
 * Browser wallet signing example
 *
 * This example demonstrates how to use createSignerFromProvider to support browser wallet signing
 * Note: This example needs to run in a browser environment
 */

import axios from "axios";
import {
  withPaymentInterceptor,
  decodeXPaymentResponse,
  createSignerFromProvider,
  type EIP1193Provider,
} from "x402-axios";

/**
 * Create a signer using a browser wallet (e.g., MetaMask)
 */
async function main(): Promise<void> {
  // Check if running in browser environment
  if (typeof window === "undefined" || !window.ethereum) {
    console.error("Please install MetaMask or another Ethereum wallet");
    return;
  }

  const baseURL = process.env.RESOURCE_SERVER_URL as string; // e.g. https://example.com
  const endpointPath = process.env.ENDPOINT_PATH as string; // e.g. /weather

  if (!baseURL || !endpointPath) {
    console.error("Missing required environment variables");
    return;
  }

  try {
    // Create signer using browser wallet
    // window.ethereum is the EIP-1193 provider provided by MetaMask and other wallets
    const provider = window.ethereum as unknown as EIP1193Provider;

    // Request user to connect wallet
    await provider.request({ method: "eth_requestAccounts" });

    // Create signer - using createSignerFromProvider
    // The second parameter is the network name (must be a supported EVM network)
    const signer = await createSignerFromProvider("base-sepolia", provider);

    // Create axios instance with payment interceptor
    const api = withPaymentInterceptor(
      axios.create({
        baseURL,
      }),
      signer,
    );

    // Make request (will automatically handle 402 payment response)
    const response = await api.get(endpointPath);
    console.log(response.data);

    // Parse payment response
    const paymentResponse = decodeXPaymentResponse(response.headers["x-payment-response"]);
    console.log("Payment response:", paymentResponse);
  } catch (error) {
    console.error("Error:", error);
  }
}

// Run in browser
if (typeof window !== "undefined") {
  // Can be bound to button click event
  // document.getElementById('connect-wallet')?.addEventListener('click', main);
}
