import { config } from "dotenv";
import express from "express";
import cors from "cors";
import { exact } from "x402/schemes";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  Price,
  Resource,
  settleResponseHeader,
} from "x402/types";
import { useFacilitator } from "x402/verify";
import { processPriceToAtomicAmount, findMatchingPaymentRequirements } from "x402/shared";
import https from "https";
import http from "http";
import { URL } from "url";

config();

const facilitatorUrl = process.env.FACILITATOR_URL as Resource;
const payTo = process.env.ADDRESS as `0x${string}`;
const proxyTargetUrl = process.env.PROXY_TARGET_URL || "http://127.0.0.1:9999";

if (!facilitatorUrl || !payTo) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const app = express();

// Add CORS support, must be configured before all other middleware
// This is critical for handling cross-origin requests
app.use(
  cors({
    origin: "*", // Allow all origins
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "X-PAYMENT",
      "Authorization",
      "Cache-Control",
    ],
    exposedHeaders: ["X-PAYMENT-RESPONSE"],
    credentials: false, // If origin is "*", credentials must be false
    maxAge: 86400, // Cache preflight request results for 24 hours
    preflightContinue: false, // Handle preflight requests immediately, don't continue to next middleware
    optionsSuccessStatus: 200, // Compatible with older browsers
  }),
);

// Explicitly handle OPTIONS preflight requests
app.options("*", cors());

// Add JSON, URL-encoded, and text parsing middleware
// Note: Order matters - specific parsers should come before catch-all raw parser
app.use(express.json()); // Parse application/json first
app.use(express.urlencoded({ extended: true })); // Parse application/x-www-form-urlencoded
app.use(express.text({ type: "text/plain" })); // Parse text/plain as string for SSE proxy
app.use(express.raw({ type: "*/*", limit: "10mb" })); // Capture raw body for all other types (fallback)

const { verify, settle } = useFacilitator({ url: facilitatorUrl });
const x402Version = 1;

// Simple CORS test endpoint (for debugging)
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * Creates payment requirements for a given price and network
 *
 * @param price - The price to be paid for the resource
 * @param network - The blockchain network to use for payment
 * @param resource - The resource being accessed
 * @param description - Optional description of the payment
 * @returns An array of payment requirements
 */
function createExactPaymentRequirements(
  price: Price,
  network: Network,
  resource: Resource,
  description = "",
): PaymentRequirements {
  const atomicAmountForAsset = processPriceToAtomicAmount(price, network);
  if ("error" in atomicAmountForAsset) {
    throw new Error(atomicAmountForAsset.error);
  }
  const { maxAmountRequired, asset } = atomicAmountForAsset;

  return {
    scheme: "exact",
    network,
    maxAmountRequired,
    resource,
    description,
    mimeType: "",
    payTo: payTo,
    maxTimeoutSeconds: 60,
    asset: asset.address,
    outputSchema: undefined,
    extra: {
      name: asset.eip712.name,
      version: asset.eip712.version,
    },
  };
}

/**
 * Verifies a payment and handles the response
 *
 * @param req - The Express request object
 * @param res - The Express response object
 * @param paymentRequirements - The payment requirements to verify against
 * @returns A promise that resolves to true if payment is valid, false otherwise
 */
async function verifyPayment(
  req: express.Request,
  res: express.Response,
  paymentRequirements: PaymentRequirements[],
): Promise<boolean> {
  // Ensure all responses include CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, X-PAYMENT, Authorization, Cache-Control",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");

  const payment = req.header("X-PAYMENT");
  if (!payment) {
    console.log("[Verify] X-PAYMENT header not found, returning 402");
    res.status(402).json({
      x402Version,
      error: "X-PAYMENT header is required",
      accepts: paymentRequirements,
    });
    return false;
  }

  console.log("[Verify] Starting payment signature verification");
  let decodedPayment: PaymentPayload;
  try {
    decodedPayment = exact.evm.decodePayment(payment);
    decodedPayment.x402Version = x402Version;
    console.log("[Verify] Payment signature decoded successfully");
  } catch (error) {
    console.error("[Verify] Payment signature decode failed:", error);
    res.status(402).json({
      x402Version,
      error: error || "Invalid or malformed payment header",
      accepts: paymentRequirements,
    });
    return false;
  }

  try {
    const selectedPaymentRequirement =
      findMatchingPaymentRequirements(paymentRequirements, decodedPayment) ||
      paymentRequirements[0];
    const response = await verify(decodedPayment, selectedPaymentRequirement);
    if (!response.isValid) {
      console.error("[Verify] Payment verification failed:", response.invalidReason);
      res.status(402).json({
        x402Version,
        error: response.invalidReason,
        accepts: paymentRequirements,
        payer: response.payer,
      });
      return false;
    }
    console.log("[Verify] Payment verification successful");
  } catch (error) {
    console.error("[Verify] Payment verification exception:", error);
    res.status(402).json({
      x402Version,
      error,
      accepts: paymentRequirements,
    });
    return false;
  }

  return true;
}

// Delayed settlement example endpoint
app.get("/delayed-settlement", async (req, res) => {
  const resource = `${req.protocol}://${req.headers.host}${req.originalUrl}` as Resource;
  const paymentRequirements = [
    createExactPaymentRequirements(
      "$0.001",
      // network: "base" // uncomment for Base mainnet
      "base-sepolia",
      resource,
      "Access to weather data (async)",
    ),
  ];

  const isValid = await verifyPayment(req, res, paymentRequirements);
  if (!isValid) return;

  // Return weather data immediately
  res.json({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });

  // Process payment asynchronously
  try {
    const settleResponse = await settle(
      exact.evm.decodePayment(req.header("X-PAYMENT")!),
      paymentRequirements[0],
    );
    const responseHeader = settleResponseHeader(settleResponse);
    // In a real application, you would store this response header
    // and associate it with the payment for later verification
    console.log("Payment settled:", responseHeader);
  } catch (error) {
    console.error("Payment settlement failed:", error);
    // In a real application, you would handle the failed payment
    // by marking it for retry or notifying the user
  }
});

// Dynamic price example endpoint
app.get("/dynamic-price", async (req, res) => {
  console.log("[Server] Received request:", req.method, req.url);
  console.log("[Server] Request headers:", req.headers);
  console.log("[Server] X-PAYMENT header:", req.header("X-PAYMENT") ? "present" : "not present");

  // Explicitly set CORS headers to ensure cross-origin requests work correctly
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, X-PAYMENT, Authorization, Cache-Control",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");

  // Use query params, body, or external factors to determine if price is impacted
  const multiplier = parseInt((req.query.multiplier as string) ?? "1");
  // Adjust pricing based on impact from inputs
  const price = 0.001 * multiplier;

  const resource = `${req.protocol}://${req.headers.host}${req.originalUrl}` as Resource;
  const paymentRequirements = [
    createExactPaymentRequirements(
      price, // Expect dynamic pricing
      // network: "base" // uncomment for Base mainnet
      "base-sepolia",
      resource,
      "Access to weather data",
    ),
  ];

  console.log("[Server] Payment requirements:", {
    resource,
    price,
    maxAmountRequired: paymentRequirements[0].maxAmountRequired,
    network: paymentRequirements[0].network,
  });

  const isValid = await verifyPayment(req, res, paymentRequirements);
  if (!isValid) {
    console.log("[Server] Payment verification failed, returning 402");
    return;
  }

  console.log("[Server] Payment verification successful");

  try {
    // Process payment synchronously
    const paymentHeader = req.header("X-PAYMENT");
    if (!paymentHeader) {
      console.error("[Server] Error: X-PAYMENT header not found");
      res.status(402).json({
        x402Version,
        error: "X-PAYMENT header is required",
        accepts: paymentRequirements,
      });
      return;
    }

    console.log("[Server] Starting payment settlement");
    const decodedPayment = exact.evm.decodePayment(paymentHeader);
    const settleResponse = await settle(decodedPayment, paymentRequirements[0]);
    const responseHeader = settleResponseHeader(settleResponse);
    res.setHeader("X-PAYMENT-RESPONSE", responseHeader);

    console.log("[Server] Payment settlement successful, returning data");
    // Return the weather data with explicit status code
    res.status(200).json({
      report: {
        success: "sunny",
        temperature: 70,
      },
    });
  } catch (error) {
    console.error("[Server] Payment settlement failed:", error);
    res.status(402).json({
      x402Version,
      error: error instanceof Error ? error.message : String(error),
      accepts: paymentRequirements,
    });
  }
});

// Multiple payment requirements example endpoint
app.get("/multiple-payment-requirements", async (req, res) => {
  const resource = `${req.protocol}://${req.headers.host}${req.originalUrl}` as Resource;

  // Payment requirements is an array. You can mix and match tokens, prices, and networks.
  const paymentRequirements = [
    createExactPaymentRequirements("$0.001", "base", resource),
    createExactPaymentRequirements(
      {
        amount: "1000",
        asset: {
          address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          decimals: 6,
          eip712: {
            name: "USDC",
            version: "2",
          },
        },
      },
      // network: "base" // uncomment for Base mainnet
      "base-sepolia",
      resource,
    ),
  ];

  const isValid = await verifyPayment(req, res, paymentRequirements);
  if (!isValid) return;

  try {
    // Process payment synchronously
    const decodedPayment = exact.evm.decodePayment(req.header("X-PAYMENT")!);

    // Find the matching payment requirement
    const selectedPaymentRequirement =
      findMatchingPaymentRequirements(paymentRequirements, decodedPayment) ||
      paymentRequirements[0];

    const settleResponse = await settle(decodedPayment, selectedPaymentRequirement);
    const responseHeader = settleResponseHeader(settleResponse);
    res.setHeader("X-PAYMENT-RESPONSE", responseHeader);

    // Return the weather data
    res.json({
      report: {
        success: "sunny",
        temperature: 70,
      },
    });
  } catch (error) {
    res.status(402).json({
      x402Version,
      error,
      accepts: paymentRequirements,
    });
  }
});

/**
 * Proxies SSE (Server-Sent Events) requests to a target URL
 *
 * @param req - The Express request object
 * @param res - The Express response object
 * @param targetPath - The target path to proxy to
 */
async function proxySSE(
  req: express.Request,
  res: express.Response,
  targetPath: string,
): Promise<void> {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, X-PAYMENT, Authorization, Cache-Control",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");

  try {
    const targetUrl = new URL(targetPath, proxyTargetUrl);
    const isHttps = targetUrl.protocol === "https:";
    const httpModule = isHttps ? https : http;

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable buffering in Nginx

    // Prepare request options - Always use POST method for proxy requests
    const requestMethod = "POST";
    console.log(`[SSE Proxy] Proxying ${requestMethod} request to: ${targetUrl.toString()}`);

    // Build headers for proxy request
    // Remove hop-by-hop headers and headers that shouldn't be forwarded
    const hopByHopHeaders = [
      "connection",
      "upgrade",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailers",
      "transfer-encoding",
      "host",
      "x-payment", // Remove payment header
    ];

    const proxyHeaders: Record<string, string> = {};
    Object.keys(req.headers).forEach(key => {
      const lowerKey = key.toLowerCase();
      if (!hopByHopHeaders.includes(lowerKey) && req.headers[key]) {
        proxyHeaders[key] = req.headers[key] as string;
      }
    });

    // Set required headers
    proxyHeaders.host = targetUrl.host;
    proxyHeaders["x-forwarded-for"] = req.ip || req.socket.remoteAddress || "";
    proxyHeaders["x-forwarded-proto"] = req.protocol;
    proxyHeaders["x-forwarded-host"] = req.get("host") || "";
    proxyHeaders["accept"] = "text/event-stream";

    // Handle request body and set appropriate headers
    // Server expects String type, so we need to preserve the original body string
    let requestBody: Buffer | string | null = null;
    const originalContentType = req.headers["content-type"] || "";
    const originalContentLength = req.headers["content-length"];

    console.log(
      `[SSE Proxy] Original request - Content-Type: ${originalContentType}, Content-Length: ${originalContentLength}, req.body type: ${typeof req.body}`,
    );
    console.log("[SSE Proxy] req.body details:", {
      body: req.body,
      bodyType: typeof req.body,
      isBuffer: Buffer.isBuffer(req.body),
      isObject: typeof req.body === "object",
      isArray: Array.isArray(req.body),
      keys:
        req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)
          ? Object.keys(req.body)
          : null,
      bodyStringified: req.body && !Buffer.isBuffer(req.body) ? JSON.stringify(req.body) : null,
      bodyBufferLength: Buffer.isBuffer(req.body) ? req.body.length : null,
      bodyBufferPreview: Buffer.isBuffer(req.body)
        ? req.body.toString("utf8").substring(0, 100)
        : null,
    });

    if (req.body !== undefined && req.body !== null) {
      // Check if body was parsed by express.raw() as Buffer
      if (Buffer.isBuffer(req.body)) {
        // Body was parsed as Buffer by express.raw(), convert to string for server
        requestBody = req.body.toString("utf8");
        proxyHeaders["Content-Type"] = originalContentType || "text/plain";
        proxyHeaders["Content-Length"] = req.body.length.toString();
        console.log(
          `[SSE Proxy] Request has Buffer body: ${req.body.length} bytes, converted to string: ${requestBody.length} bytes, body: ${requestBody.substring(0, 100)}`,
        );
      } else if (typeof req.body === "string") {
        // Body is already a string (from text/plain or raw body)
        requestBody = req.body;
        proxyHeaders["Content-Type"] = originalContentType || "text/plain";
        proxyHeaders["Content-Length"] = Buffer.byteLength(requestBody).toString();
        console.log(
          `[SSE Proxy] Request has string body: ${requestBody.length} bytes, body: ${requestBody.substring(0, 100)}`,
        );
      } else if (typeof req.body === "object" && Object.keys(req.body).length > 0) {
        // Body was parsed as JSON object by express.json(), convert back to JSON string for server
        // Server expects String type, so we need to stringify the object
        requestBody = JSON.stringify(req.body);
        // Keep original content-type if it was application/json, otherwise use text/plain
        proxyHeaders["Content-Type"] = originalContentType.includes("application/json")
          ? "application/json"
          : "text/plain";
        proxyHeaders["Content-Length"] = Buffer.byteLength(requestBody).toString();
        console.log(
          `[SSE Proxy] Request has JSON body, converted to string: ${requestBody.length} bytes, Content-Type: ${proxyHeaders["Content-Type"]}, body: ${requestBody.substring(0, 100)}`,
        );
      } else {
        // Empty object or null
        requestBody = null;
        proxyHeaders["Content-Length"] = "0";
        console.log("[SSE Proxy] Request has empty body (empty object)");
      }
    } else {
      // req.body is undefined or null - check if there's a Content-Length header
      if (originalContentLength && parseInt(originalContentLength) > 0) {
        // There's a Content-Length header but body wasn't parsed - this shouldn't happen
        // but we'll handle it by setting Content-Length to 0
        console.warn(
          `[SSE Proxy] Warning: Content-Length header exists (${originalContentLength}) but req.body is undefined`,
        );
        requestBody = null;
        proxyHeaders["Content-Length"] = "0";
      } else {
        // No body, set Content-Length: 0 for POST request
        requestBody = null;
        proxyHeaders["Content-Length"] = "0";
        console.log("[SSE Proxy] Request has no body, sending empty POST");
      }
    }

    const requestOptions: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: requestMethod,
      headers: proxyHeaders,
    };

    // Create the proxy request
    const proxyReq = httpModule.request(requestOptions, proxyRes => {
      // Set status code
      res.status(proxyRes.statusCode || 200);

      // Forward response headers (except those we've already set)
      Object.keys(proxyRes.headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey !== "content-encoding" &&
          lowerKey !== "content-length" &&
          lowerKey !== "transfer-encoding"
        ) {
          res.setHeader(key, proxyRes.headers[key]!);
        }
      });

      // Ensure SSE headers are set correctly
      if (!res.getHeader("Content-Type") || res.getHeader("Content-Type") !== "text/event-stream") {
        res.setHeader("Content-Type", "text/event-stream");
      }

      // Pipe the response stream to the client
      proxyRes.on("data", chunk => {
        if (!res.destroyed) {
          res.write(chunk);
        }
      });

      proxyRes.on("end", () => {
        if (!res.destroyed) {
          res.end();
        }
      });

      proxyRes.on("error", error => {
        console.error("[SSE Proxy] Response error:", error);
        if (!res.destroyed) {
          res.status(500).end();
        }
      });
    });

    // Handle proxy request errors
    proxyReq.on("error", error => {
      console.error(`[SSE Proxy] Request error (${requestMethod} ${targetUrl.toString()}):`, error);
      if (!res.destroyed && !res.headersSent) {
        res.status(502).json({ error: "Proxy request failed", message: error.message });
      }
    });

    // Send request body for POST requests
    if (requestBody) {
      // Send body if present
      console.log(
        `[SSE Proxy] Sending request body: ${Buffer.byteLength(requestBody)} bytes, Content-Type: ${proxyHeaders["Content-Type"]}`,
      );
      proxyReq.write(requestBody);
      proxyReq.end();
    } else {
      // Send empty body for POST request
      console.log(
        `[SSE Proxy] Sending empty POST request, Content-Length: ${proxyHeaders["Content-Length"]}`,
      );
      proxyReq.end();
    }

    // Handle client disconnect
    req.on("close", () => {
      proxyReq.destroy();
      if (!res.destroyed) {
        res.end();
      }
    });

    res.on("close", () => {
      proxyReq.destroy();
    });
  } catch (error) {
    console.error("[SSE Proxy] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Proxy error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// SSE proxy endpoint for /generate
// Supports both GET and POST methods
// POST: receives parameters from request body
// GET: receives parameters from query string and converts to body for proxy
app.all("/generate", async (req, res) => {
  console.log(`[SSE Proxy] Received ${req.method} request for /generate (will proxy as POST)`);

  // For GET requests, convert query parameters to body
  // For POST requests, use the existing body
  if (req.method === "GET" && Object.keys(req.query).length > 0) {
    // Convert query parameters to body for GET requests
    req.body = req.query;
    console.log("[SSE Proxy] GET request - converted query params to body:", req.body);
  }

  // Print detailed request parameters
  console.log("=== SSE Request Parameters ===");
  console.log("Request Method:", req.method);
  console.log("Request Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Content-Type:", req.headers["content-type"] || "not set");
  console.log("Content-Length:", req.headers["content-length"] || "not set");
  console.log("Request URL:", req.url);
  console.log("Query Parameters:", req.query);
  console.log("Request Body Type:", typeof req.body);
  console.log("Request Body:", req.body);
  console.log("Request Body (stringified):", JSON.stringify(req.body, null, 2));
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    console.log("Request Body Keys:", Object.keys(req.body));
    console.log("Request Body Values:", Object.values(req.body));
  }
  console.log("=== End SSE Request Parameters ===");

  const resource = `${req.protocol}://${req.headers.host}${req.originalUrl}` as Resource;
  const paymentRequirements = [
    createExactPaymentRequirements(
      "$0.001",
      "base-sepolia",
      resource,
      "Access to async chat API (SSE)",
    ),
  ];

  const isValid = await verifyPayment(req, res, paymentRequirements);
  if (!isValid) return;

  // Process payment settlement
  try {
    const paymentHeader = req.header("X-PAYMENT");
    if (paymentHeader) {
      const decodedPayment = exact.evm.decodePayment(paymentHeader);
      const settleResponse = await settle(decodedPayment, paymentRequirements[0]);
      const responseHeader = settleResponseHeader(settleResponse);
      res.setHeader("X-PAYMENT-RESPONSE", responseHeader);
      console.log("[SSE Proxy] Payment settled successfully");
    }
  } catch (error) {
    console.error("[SSE Proxy] Payment settlement failed:", error);
    // Continue with proxy even if settlement fails
  }

  // Proxy the SSE request
  await proxySSE(req, res, "/mgn/agent/asyncChat");
});

// Global error handling middleware, ensure error responses also include CORS headers
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({
    error: err.message || "Internal server error",
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:4021`);
  console.log(`CORS enabled for all origins`);
  console.log(`Proxy target URL: ${proxyTargetUrl}`);
  console.log(`Available endpoints:`);
  console.log(`  GET /dynamic-price`);
  console.log(`  GET /delayed-settlement`);
  console.log(`  GET /multiple-payment-requirements`);
  console.log(`  GET/POST /generate (SSE proxy)`);
});
