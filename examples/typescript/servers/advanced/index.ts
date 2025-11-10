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
import Redis from "ioredis";

config();

const facilitatorUrl = process.env.FACILITATOR_URL as Resource;
const payTo = process.env.ADDRESS as `0x${string}`;
const proxyTargetUrl = process.env.PROXY_TARGET_URL || "http://127.0.0.1:9999";
const apiBaseUrl = process.env.API || "";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

if (!facilitatorUrl || !payTo) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Redis 客户端初始化
const redis = new Redis(redisUrl, {
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on("error", (err: Error) => {
  console.error("[Redis] Connection error:", err);
});

redis.on("connect", () => {
  console.log("[Redis] Connected successfully");
});

const FREE_USAGE_LIMIT = 6;
const USER_USAGE_KEY_PREFIX = "user:usage:";

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
      "x-access-token",
      "X-Access-Token",
    ],
    exposedHeaders: ["X-PAYMENT-RESPONSE"],
    credentials: false, // If origin is "*", credentials must be false
    maxAge: 86400, // Cache preflight request results for 24 hours
    preflightContinue: false, // Handle preflight requests immediately, don't continue to next middleware
    optionsSuccessStatus: 200, // Compatible with older browsers
  }),
);

// CORS middleware already handles OPTIONS preflight requests
// No need for explicit app.options("*") handler

// Add global request logging middleware for debugging
app.use((req, res, next) => {
  if (req.path === "/generate") {
    console.log(`[Global Middleware] ${req.method} ${req.path} - Request received`);
    console.log(`[Global Middleware] Original URL: ${req.originalUrl}`);
    console.log(`[Global Middleware] Content-Type: ${req.headers["content-type"]}`);
    console.log(`[Global Middleware] Content-Length: ${req.headers["content-length"]}`);
  }
  next();
});

// Add JSON, URL-encoded, and text parsing middleware
// Note: Order matters - specific parsers should come before catch-all raw parser
app.use(express.json()); // Parse application/json first
app.use(express.urlencoded({ extended: true })); // Parse application/x-www-form-urlencoded
app.use(express.text({ type: "text/plain" })); // Parse text/plain as string
app.use(express.raw({ type: "*/*", limit: "10mb" })); // Capture raw body for all other types (fallback)

const { verify, settle } = useFacilitator({ url: facilitatorUrl });
const x402Version = 1;

// Register /generate routes early to ensure they are matched first
// This is important because body parsing middleware might affect routing
console.log("[Server] Registering /generate route early...");

// Add middleware to log all requests to /generate before routing
app.use("/generate", (req, res, next) => {
  console.log(`[Generate Middleware] ===== ${req.method} ${req.path} =====`);
  console.log(`[Generate Middleware] Original URL: ${req.originalUrl}`);
  console.log(`[Generate Middleware] URL: ${req.url}`);
  console.log(`[Generate Middleware] Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(
    `[Generate Middleware] X-PAYMENT header:`,
    req.header("X-PAYMENT") || req.header("x-payment") || "not present",
  );
  next();
});

// Handle OPTIONS preflight for /generate first - MUST be before other routes
app.options("/generate", (req, res) => {
  console.log(`[Generate] ===== OPTIONS preflight request =====`);
  res.status(200).end();
});

// Register GET method for /generate
app.get("/generate", async (req, res, next) => {
  try {
    console.log(`[Generate] ===== GET route matched =====`);
    await handleGenerate(req, res);
  } catch (error) {
    console.error(`[Generate] Error in GET route handler:`, error);
    if (!res.headersSent) {
      next(error);
    }
  }
});

// Register POST method for /generate - MUST use app.post() directly
app.post("/generate", async (req, res, next) => {
  try {
    console.log(`[Generate] ===== POST route matched =====`);
    console.log(`[Generate] Request method: ${req.method}`);
    console.log(`[Generate] Request path: ${req.path}`);
    console.log(`[Generate] Request URL: ${req.url}`);
    console.log(`[Generate] Original URL: ${req.originalUrl}`);
    console.log(`[Generate] Calling handleGenerate...`);
    await handleGenerate(req, res);
  } catch (error) {
    console.error(`[Generate] Error in POST route handler:`, error);
    if (!res.headersSent) {
      next(error);
    }
  }
});

console.log("[Server] /generate route registered early (supports GET, POST, and OPTIONS)");

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
    extra:
      "eip712" in asset
        ? {
            name: asset.eip712.name,
            version: asset.eip712.version,
          }
        : undefined,
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
    "Origin, X-Requested-With, Content-Type, Accept, X-PAYMENT, Authorization, Cache-Control, x-access-token, X-Access-Token",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");

  // Check header using multiple methods to debug
  const paymentHeader = req.header("X-PAYMENT") || req.header("x-payment");
  const paymentHeaders = req.headers["x-payment"] || req.headers["X-PAYMENT"];
  const payment =
    paymentHeader || (Array.isArray(paymentHeaders) ? paymentHeaders[0] : paymentHeaders);

  console.log("[Verify] Checking X-PAYMENT header:");
  console.log("[Verify] req.header('X-PAYMENT'):", req.header("X-PAYMENT"));
  console.log("[Verify] req.header('x-payment'):", req.header("x-payment"));
  console.log("[Verify] req.headers['x-payment']:", req.headers["x-payment"]);
  console.log("[Verify] req.headers['X-PAYMENT']:", req.headers["X-PAYMENT"]);
  console.log("[Verify] All headers keys:", Object.keys(req.headers));
  console.log("[Verify] Final payment value:", payment);

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

/**
 * 通过 token 获取当前用户信息
 *
 * @param token - 访问令牌
 * @returns Promise<{ userId: string } | null> - 用户信息或 null
 */
async function getCurrentUser(token: string): Promise<{ userId: string } | null> {
  if (!apiBaseUrl) {
    console.error("[User] API base URL not configured");
    return null;
  }

  try {
    const url = new URL("/sys/getCurrUser", apiBaseUrl);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-access-token": token,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(`[User] Failed to get user info: ${response.status} ${response.statusText}`);
      return null;
    }

    const userData = await response.json();
    console.log("[User] User data received:", userData);

    // 假设返回的数据结构包含 userId 字段
    // 根据实际 API 响应结构调整
    const userId = userData.userId || userData.id || userData.user?.id;
    if (!userId) {
      console.error("[User] User ID not found in response");
      return null;
    }

    return { userId: String(userId) };
  } catch (error) {
    console.error("[User] Error fetching user info:", error);
    return null;
  }
}

/**
 * 获取用户使用次数
 *
 * @param userId - 用户 ID
 * @returns Promise<number> - 当前使用次数
 */
async function getUserUsageCount(userId: string): Promise<number> {
  try {
    const key = `${USER_USAGE_KEY_PREFIX}${userId}`;
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  } catch (error) {
    console.error(`[Usage] Error getting usage count for user ${userId}:`, error);
    return 0;
  }
}

/**
 * 增加用户使用次数
 *
 * @param userId - 用户 ID
 * @returns Promise<void>
 */
async function incrementUserUsage(userId: string): Promise<void> {
  try {
    const key = `${USER_USAGE_KEY_PREFIX}${userId}`;
    const count = await redis.incr(key);

    // 设置过期时间为30天（可选，根据业务需求调整）
    if (count === 1) {
      await redis.expire(key, 30 * 24 * 60 * 60);
    }

    console.log(`[Usage] User ${userId} usage count: ${count}`);
  } catch (error) {
    console.error(`[Usage] Error incrementing usage for user ${userId}:`, error);
    throw error;
  }
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
    "Origin, X-Requested-With, Content-Type, Accept, X-PAYMENT, Authorization, Cache-Control, x-access-token, X-Access-Token",
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
 * Proxies POST requests to a target URL
 *
 * @param req - The Express request object
 * @param res - The Express response object
 * @param targetPath - The target path to proxy to
 */
async function proxyPost(
  req: express.Request,
  res: express.Response,
  targetPath: string,
): Promise<void> {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, X-PAYMENT, Authorization, Cache-Control, x-access-token, X-Access-Token",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");

  try {
    const targetUrl = new URL(targetPath, proxyTargetUrl);
    const isHttps = targetUrl.protocol === "https:";
    const httpModule = isHttps ? https : http;

    // Prepare request options - Always use POST method for proxy requests
    const requestMethod = "POST";
    console.log(`[Proxy] Proxying ${requestMethod} request to: ${targetUrl.toString()}`);

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

    // Handle request body and set appropriate headers
    let requestBody: Buffer | string | null = null;
    const originalContentType = req.headers["content-type"] || "";
    const originalContentLength = req.headers["content-length"];

    console.log(
      `[Proxy] Original request - Content-Type: ${originalContentType}, Content-Length: ${originalContentLength}, req.body type: ${typeof req.body}`,
    );

    if (req.body !== undefined && req.body !== null) {
      // Check if body was parsed by express.raw() as Buffer
      if (Buffer.isBuffer(req.body)) {
        // Body was parsed as Buffer by express.raw(), convert to string for server
        requestBody = req.body.toString("utf8");
        proxyHeaders["Content-Type"] = originalContentType || "text/plain";
        proxyHeaders["Content-Length"] = req.body.length.toString();
        console.log(
          `[Proxy] Request has Buffer body: ${req.body.length} bytes, converted to string: ${requestBody.length} bytes`,
        );
      } else if (typeof req.body === "string") {
        // Body is already a string (from text/plain or raw body)
        requestBody = req.body;
        proxyHeaders["Content-Type"] = originalContentType || "text/plain";
        proxyHeaders["Content-Length"] = Buffer.byteLength(requestBody).toString();
        console.log(`[Proxy] Request has string body: ${requestBody.length} bytes`);
      } else if (typeof req.body === "object") {
        // Body was parsed as JSON object by express.json(), convert back to JSON string for server
        const hasContentLength = originalContentLength && parseInt(originalContentLength) > 0;
        const isPostRequest = req.method === "POST";
        const isEmptyObject = Object.keys(req.body).length === 0;

        // If it's a POST request with Content-Length > 0, or object has keys, stringify it
        if (!isEmptyObject || (isPostRequest && hasContentLength)) {
          requestBody = JSON.stringify(req.body);
          // Keep original content-type if it was application/json, otherwise use text/plain
          proxyHeaders["Content-Type"] = originalContentType.includes("application/json")
            ? "application/json"
            : "text/plain";
          proxyHeaders["Content-Length"] = Buffer.byteLength(requestBody).toString();
          console.log(
            `[Proxy] Request has JSON body, converted to string: ${requestBody.length} bytes, Content-Type: ${proxyHeaders["Content-Type"]}`,
          );
        } else {
          // Empty object without Content-Length - treat as no body
          requestBody = null;
          proxyHeaders["Content-Length"] = "0";
          console.log("[Proxy] Request has empty body (empty object without Content-Length)");
        }
      } else {
        // Other types (shouldn't happen, but handle gracefully)
        requestBody = String(req.body);
        proxyHeaders["Content-Type"] = originalContentType || "text/plain";
        proxyHeaders["Content-Length"] = Buffer.byteLength(requestBody).toString();
        console.log(
          `[Proxy] Request has unexpected body type: ${typeof req.body}, converted to string: ${requestBody.length} bytes`,
        );
      }
    } else {
      // req.body is undefined or null - check if there's a Content-Length header
      if (originalContentLength && parseInt(originalContentLength) > 0) {
        console.warn(
          `[Proxy] Warning: Content-Length header exists (${originalContentLength}) but req.body is undefined`,
        );
        requestBody = null;
        proxyHeaders["Content-Length"] = "0";
      } else {
        // No body, set Content-Length: 0 for POST request
        requestBody = null;
        proxyHeaders["Content-Length"] = "0";
        console.log("[Proxy] Request has no body, sending empty POST");
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
      // Collect response data
      let responseData = Buffer.alloc(0);

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

      // Collect response chunks
      proxyRes.on("data", chunk => {
        responseData = Buffer.concat([responseData, chunk]);
      });

      proxyRes.on("end", () => {
        if (!res.headersSent) {
          // Set Content-Type if not already set
          if (!res.getHeader("Content-Type")) {
            res.setHeader("Content-Type", "application/json");
          }
          // Send the complete response
          res.send(responseData);
        }
      });

      proxyRes.on("error", error => {
        console.error("[Proxy] Response error:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Proxy response error", message: error.message });
        }
      });
    });

    // Handle proxy request errors
    proxyReq.on("error", error => {
      console.error(`[Proxy] Request error (${requestMethod} ${targetUrl.toString()}):`, error);
      if (!res.headersSent) {
        res.status(502).json({ error: "Proxy request failed", message: error.message });
      }
    });

    // Send request body for POST requests
    if (requestBody) {
      console.log(
        `[Proxy] Sending request body: ${Buffer.byteLength(requestBody)} bytes, Content-Type: ${proxyHeaders["Content-Type"]}`,
      );
      proxyReq.write(requestBody);
      proxyReq.end();
    } else {
      console.log(
        `[Proxy] Sending empty POST request, Content-Length: ${proxyHeaders["Content-Length"]}`,
      );
      proxyReq.end();
    }

    // Handle client disconnect
    req.on("close", () => {
      proxyReq.destroy();
    });

    res.on("close", () => {
      proxyReq.destroy();
    });
  } catch (error) {
    console.error("[Proxy] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Proxy error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// POST proxy endpoint for /generate
// Supports both GET and POST methods
// POST: receives parameters from request body
// GET: receives parameters from query string and converts to body for proxy
// x402 protocol verification is performed before proxying (only if usage exceeds free limit)
async function handleGenerate(req: express.Request, res: express.Response) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, X-PAYMENT, Authorization, Cache-Control, x-access-token, X-Access-Token",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");

  // 1. 从请求头获取 x-access-token
  const accessTokenHeader = req.header("x-access-token") || req.header("X-Access-Token");
  const accessTokenArray = req.headers["x-access-token"];
  const accessToken =
    accessTokenHeader ||
    (Array.isArray(accessTokenArray) ? accessTokenArray[0] : accessTokenArray) ||
    "";

  if (!accessToken) {
    console.error("[Generate] Missing x-access-token header");
    res.status(401).json({ error: "Missing x-access-token header" });
    return;
  }

  // 2. 调用 /sys/getCurrUser 获取用户信息
  const userInfo = await getCurrentUser(accessToken);
  if (!userInfo) {
    console.error("[Generate] Failed to get user info");
    res.status(401).json({ error: "Failed to authenticate user" });
    return;
  }

  const { userId } = userInfo;
  console.log(`[Generate] User authenticated: ${userId}`);

  // 3. 检查用户使用次数
  const usageCount = await getUserUsageCount(userId);
  const requiresPayment = usageCount >= FREE_USAGE_LIMIT;

  console.log(
    `[Generate] User ${userId} usage: ${usageCount}/${FREE_USAGE_LIMIT}, requiresPayment: ${requiresPayment}`,
  );

  // 4. 如果超过免费次数，需要 x402 支付
  if (requiresPayment) {
    const resource = `${req.protocol}://${req.headers.host}${req.originalUrl}` as Resource;
    const paymentRequirements = [
      createExactPaymentRequirements("$0.001", "base-sepolia", resource, "Access to chat API"),
    ];

    const isValid = await verifyPayment(req, res, paymentRequirements);
    if (!isValid) {
      console.log(`[Generate] Payment verification failed for user ${userId}`);
      return;
    }

    // Process payment settlement
    try {
      const paymentHeader = req.header("X-PAYMENT");
      if (paymentHeader) {
        const decodedPayment = exact.evm.decodePayment(paymentHeader);
        const settleResponse = await settle(decodedPayment, paymentRequirements[0]);
        const responseHeader = settleResponseHeader(settleResponse);
        res.setHeader("X-PAYMENT-RESPONSE", responseHeader);
        console.log("[Proxy] Payment settled successfully");
      }
    } catch (error) {
      console.error("[Proxy] Payment settlement failed:", error);
      res.status(402).json({
        x402Version,
        error: "Payment settlement failed",
        accepts: paymentRequirements,
      });
      return;
    }
  }

  // 5. 增加用户使用次数
  await incrementUserUsage(userId);

  // 6. For GET requests, convert query parameters to body
  // For POST requests, ensure body is properly handled
  if (req.method === "GET" && Object.keys(req.query).length > 0) {
    // Convert query parameters to body for GET requests
    req.body = req.query;
    console.log("[Generate] GET request - converted query params to body:", req.body);
  } else if (req.method === "POST") {
    // For POST requests, ensure body is available
    // If body is undefined or null, it means it wasn't parsed by middleware
    // In that case, we need to check if there's a raw body available
    if (req.body === undefined || req.body === null) {
      console.warn("[Generate] POST request body is undefined or null, checking for raw body");
      // Check if body was captured by express.raw() middleware
      // If Content-Length > 0, there should be a body
      const contentLength = req.headers["content-length"];
      if (contentLength && parseInt(contentLength) > 0) {
        console.warn("[Generate] Content-Length indicates body exists but wasn't parsed");
        // Body should have been parsed by one of the middleware, but if not,
        // it might be in req.body as Buffer from express.raw()
        // This should not happen if middleware is configured correctly
      }
    } else {
      console.log("[Generate] POST request body is available:", typeof req.body, req.body);
    }
  }

  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
  }
  if (Buffer.isBuffer(req.body)) {
    console.log("Request Body (Buffer):", req.body.length, "bytes");
  }
  console.log("=== End Request Parameters ===");

  // 7. Proxy the POST request
  await proxyPost(req, res, "/mgn/agent/syncChat");
}

// Add a catch-all 404 handler for debugging (after all routes)
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.log(`[404] ${req.method} ${req.path} - Route not found`);
  res.status(404).json({ error: "Route not found", method: req.method, path: req.path });
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
  console.log(`  GET /generate (POST proxy with x402)`);
  console.log(`  POST /generate (POST proxy with x402)`);
});
