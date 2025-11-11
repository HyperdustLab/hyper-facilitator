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
const apiBaseUrl = process.env.PROXY_TARGET_URL || "";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

if (!facilitatorUrl || !payTo) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Initialize Redis client
const redis = new Redis(redisUrl, {
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 5, // Increase retry count from 3 to 5
  enableReadyCheck: true, // Enable ready check
  connectTimeout: 10000, // Connection timeout in milliseconds
  lazyConnect: false, // Connect immediately
});

redis.on("error", (err: Error) => {
  console.error("[Redis] Connection error:", err);
});

redis.on("connect", () => {
  console.log("[Redis] Connected successfully");
});

redis.on("ready", () => {
  console.log("[Redis] Ready to accept commands");
});

redis.on("close", () => {
  console.warn("[Redis] Connection closed");
});

redis.on("reconnecting", () => {
  console.log("[Redis] Reconnecting...");
});

const FREE_USAGE_LIMIT = 5;
const USER_USAGE_KEY_PREFIX = "user:usage:";
const USER_PAID_CREDITS_KEY_PREFIX = "user:paid_credits:";
const USER_TOTAL_FREE_COUNT_KEY_PREFIX = "user:total_free_count:";
const USER_REMAINING_COUNT_KEY_PREFIX = "user:remaining_count:";

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
  console.log(
    `[Generate Middleware] x-access-token header:`,
    req.header("x-access-token") || req.headers["x-access-token"] || "NOT FOUND",
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

// Get user free inference usage information endpoint
app.get("/usage", async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, X-PAYMENT, Authorization, Cache-Control, x-access-token, X-Access-Token",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");

  // Handle OPTIONS preflight request
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    // 1. Get x-access-token from request headers
    const accessTokenRaw = req.header("x-access-token") || req.headers["x-access-token"];
    const finalAccessToken = Array.isArray(accessTokenRaw) ? accessTokenRaw[0] : accessTokenRaw;

    if (
      !finalAccessToken ||
      (typeof finalAccessToken === "string" && finalAccessToken.trim() === "")
    ) {
      res.status(401).json({
        error: "Missing x-access-token header",
        message: "Please include 'x-access-token' header in your request",
      });
      return;
    }

    // 2. Get user information
    const userInfo = await getCurrentUser(finalAccessToken);
    if (!userInfo) {
      console.error("[Usage] Failed to get user info");
      res.status(401).json({ error: "Failed to authenticate user" });
      return;
    }

    const { userId } = userInfo;
    console.log(`[Usage] User authenticated: ${userId}`);

    // 3. Get all usage values from Redis
    // If user doesn't exist, initialize as new user
    let usedCount = 0;
    let totalFreeCount = FREE_USAGE_LIMIT;
    let remainingCount = FREE_USAGE_LIMIT;

    try {
      if (redis.status === "ready") {
        const usedCountKey = `${USER_USAGE_KEY_PREFIX}${userId}`;
        const totalFreeCountKey = `${USER_TOTAL_FREE_COUNT_KEY_PREFIX}${userId}`;
        const remainingCountKey = `${USER_REMAINING_COUNT_KEY_PREFIX}${userId}`;

        // Get values from Redis
        const usedCountStr = await redis.get(usedCountKey);
        const totalFreeCountStr = await redis.get(totalFreeCountKey);
        const remainingCountStr = await redis.get(remainingCountKey);

        // Only initialize new user if user doesn't exist at all (all keys are null)
        // This prevents re-initializing users who have used up their free quota (remainingCount = 0)
        const exists = await userExistsInRedis(userId);
        if (!exists) {
          console.log(`[Usage] User ${userId} not found in Redis, initializing as new user`);
          await initializeNewUser(userId);
          // After initialization, values are set to defaults
          usedCount = 0;
          totalFreeCount = FREE_USAGE_LIMIT;
          remainingCount = FREE_USAGE_LIMIT;
        } else {
          // User exists, get values directly from Redis
          // If value is null, use 0 (data may be incomplete, but don't use default values)
          usedCount = usedCountStr ? parseInt(usedCountStr, 10) : 0;
          totalFreeCount = totalFreeCountStr ? parseInt(totalFreeCountStr, 10) : FREE_USAGE_LIMIT;
          // remainingCount should always be read from Redis, never calculated
          // If null, return 0 (user may have used up all credits)
          remainingCount = remainingCountStr ? parseInt(remainingCountStr, 10) : 0;
        }

        console.log(
          `[Usage] Retrieved from Redis - usedCount: ${usedCount}, totalFreeCount: ${totalFreeCount}, remainingCount: ${remainingCount}`,
        );
      } else {
        console.warn(`[Usage] Redis not ready (status: ${redis.status}), using default values`);
      }
    } catch (error) {
      console.error(`[Usage] Error getting usage values for user ${userId}:`, error);
      // Use default values on error
    }

    // 7. Return result (keep original fields only, unified calculation)
    res.json({
      success: true,
      data: {
        totalFreeCount: totalFreeCount, // Includes both free and paid credits
        usedCount: Math.max(0, usedCount), // Show 0 if negative (has paid credits)
        remainingCount: remainingCount, // Includes both free and paid credits
      },
    });
  } catch (error) {
    console.error("[Usage] Error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
            decimals: asset.decimals,
          }
        : {
            decimals: asset.decimals,
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
 * Get current user information by token
 *
 * @param token - Access token
 * @returns Promise<{ userId: string } | null> - User information or null
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

    // Assume the response data structure contains userId field
    // Adjust according to actual API response structure
    const userId = userData.result.id;
    if (!userId) {
      console.error("[User] User ID not found in response");
      return null;
    }

    console.log("[User] User ID:", userId);

    return { userId: String(userId) };
  } catch (error) {
    console.error("[User] Error fetching user info:", error);
    return null;
  }
}

/**
 * Initialize new user with free usage limit
 * Sets usedCount=0, totalFreeCount=5, remainingCount=5, paidCredits=0
 *
 * @param userId - User ID
 * @returns Promise<void>
 */
async function initializeNewUser(userId: string): Promise<void> {
  try {
    if (redis.status !== "ready") {
      console.warn(`[Usage] Redis not ready (status: ${redis.status}), cannot initialize user`);
      return;
    }

    const usedCountKey = `${USER_USAGE_KEY_PREFIX}${userId}`;
    const totalFreeCountKey = `${USER_TOTAL_FREE_COUNT_KEY_PREFIX}${userId}`;
    const remainingCountKey = `${USER_REMAINING_COUNT_KEY_PREFIX}${userId}`;
    const paidCreditsKey = `${USER_PAID_CREDITS_KEY_PREFIX}${userId}`;

    // Initialize all values for new user
    await redis.set(usedCountKey, "0");
    await redis.set(totalFreeCountKey, FREE_USAGE_LIMIT.toString());
    await redis.set(remainingCountKey, FREE_USAGE_LIMIT.toString());
    await redis.set(paidCreditsKey, "0");

    console.log(`[Usage] Initialized new user ${userId} with ${FREE_USAGE_LIMIT} free usage count`);
  } catch (error) {
    console.error(`[Usage] Error initializing new user ${userId}:`, error);
  }
}

/**
 * Check if user exists in Redis
 * User exists if at least one of the usage-related keys exists
 *
 * @param userId - User ID
 * @returns Promise<boolean> - True if user exists, false otherwise
 */
async function userExistsInRedis(userId: string): Promise<boolean> {
  try {
    if (redis.status !== "ready") {
      return false;
    }
    const usedCountKey = `${USER_USAGE_KEY_PREFIX}${userId}`;
    const totalFreeCountKey = `${USER_TOTAL_FREE_COUNT_KEY_PREFIX}${userId}`;
    const remainingCountKey = `${USER_REMAINING_COUNT_KEY_PREFIX}${userId}`;
    const paidCreditsKey = `${USER_PAID_CREDITS_KEY_PREFIX}${userId}`;

    // Check if at least one key exists (user has been initialized before)
    const [usedCount, totalFreeCount, remainingCount, paidCredits] = await Promise.all([
      redis.get(usedCountKey),
      redis.get(totalFreeCountKey),
      redis.get(remainingCountKey),
      redis.get(paidCreditsKey),
    ]);

    // User exists if at least one key has a value (not null)
    // This prevents re-initializing users who have used up their free quota (remainingCount = 0)
    return (
      usedCount !== null ||
      totalFreeCount !== null ||
      remainingCount !== null ||
      paidCredits !== null
    );
  } catch (error) {
    console.error(`[Usage] Error checking if user exists: ${userId}:`, error);
    return false;
  }
}

/**
 * Get user usage count
 * If user doesn't exist in Redis (all keys are null), initialize as new user with free usage limit
 * If user exists but usedCount is null, return 0 (user may have partial data)
 *
 * @param userId - User ID
 * @returns Promise<number> - Current usage count
 */
async function getUserUsageCount(userId: string): Promise<number> {
  try {
    // Check Redis connection status
    if (redis.status !== "ready") {
      console.warn(`[Usage] Redis not ready (status: ${redis.status}), returning 0`);
      return 0;
    }
    const key = `${USER_USAGE_KEY_PREFIX}${userId}`;
    const count = await redis.get(key);

    // Only initialize new user if user doesn't exist at all (all keys are null)
    // This prevents re-initializing users who have used up their free quota (remainingCount = 0)
    if (count === null) {
      const exists = await userExistsInRedis(userId);
      if (!exists) {
        console.log(`[Usage] User ${userId} not found in Redis, initializing as new user`);
        await initializeNewUser(userId);
        return 0; // New user starts with 0 used count
      } else {
        // User exists but usedCount is null (partial data), return 0
        // This can happen if data is partially lost, but we don't want to re-initialize
        console.warn(`[Usage] User ${userId} exists but usedCount is null, returning 0`);
        return 0;
      }
    }

    return parseInt(count, 10);
  } catch (error) {
    console.error(`[Usage] Error getting usage count for user ${userId}:`, error);
    // If Redis operation fails, return 0 to allow request to continue
    return 0;
  }
}

/**
 * Get user remaining count
 * Always read directly from Redis, never calculate
 * If user doesn't exist in Redis (all keys are null), initialize as new user with free usage limit
 * If user exists but remainingCount is null, return 0 (data may be incomplete, but don't calculate)
 *
 * @param userId - User ID
 * @returns Promise<number> - Current remaining count from Redis
 */
async function getUserRemainingCount(userId: string): Promise<number> {
  try {
    // Check Redis connection status
    if (redis.status !== "ready") {
      console.warn(
        `[Usage] Redis not ready (status: ${redis.status}), returning ${FREE_USAGE_LIMIT}`,
      );
      return FREE_USAGE_LIMIT;
    }
    const remainingCountKey = `${USER_REMAINING_COUNT_KEY_PREFIX}${userId}`;
    const remainingCountStr = await redis.get(remainingCountKey);

    // Only initialize new user if user doesn't exist at all (all keys are null)
    // This prevents re-initializing users who have used up their free quota (remainingCount = 0)
    if (remainingCountStr === null) {
      const exists = await userExistsInRedis(userId);
      if (!exists) {
        console.log(`[Usage] User ${userId} not found in Redis, initializing as new user`);
        await initializeNewUser(userId);
        // After initialization, re-read from Redis
        const newRemainingCountStr = await redis.get(remainingCountKey);
        return newRemainingCountStr ? parseInt(newRemainingCountStr, 10) : FREE_USAGE_LIMIT;
      } else {
        // User exists but remainingCount is null (data may be incomplete)
        // Return 0 instead of calculating, as remainingCount should always be stored in Redis
        console.warn(
          `[Usage] User ${userId} exists but remainingCount is null in Redis, returning 0`,
        );
        return 0;
      }
    }

    // Always read directly from Redis, never calculate
    return parseInt(remainingCountStr, 10);
  } catch (error) {
    console.error(`[Usage] Error getting remaining count for user ${userId}:`, error);
    // If Redis operation fails, return FREE_USAGE_LIMIT to allow request to continue
    return FREE_USAGE_LIMIT;
  }
}

/**
 * Update all usage-related values in Redis
 * Stores usedCount, totalFreeCount, and remainingCount
 *
 * @param userId - User ID
 * @param usedCount - Current used count (can be negative)
 * @param totalPaidCredits - Total paid credits (cumulative)
 * @returns Promise<void>
 */
async function updateUsageValues(
  userId: string,
  usedCount: number,
  totalPaidCredits: number,
): Promise<void> {
  try {
    if (redis.status !== "ready") {
      console.warn(`[Usage] Redis not ready (status: ${redis.status}), skipping update`);
      return;
    }

    const usedCountKey = `${USER_USAGE_KEY_PREFIX}${userId}`;
    const totalFreeCountKey = `${USER_TOTAL_FREE_COUNT_KEY_PREFIX}${userId}`;
    const remainingCountKey = `${USER_REMAINING_COUNT_KEY_PREFIX}${userId}`;

    // Calculate values
    const totalFreeCount = FREE_USAGE_LIMIT + totalPaidCredits;
    // remainingCount should include both free and paid credits
    // If usedCount is negative (user has paid credits), remainingCount will be positive
    // Example: usedCount = -5, totalFreeCount = 15, remainingCount = 15 - (-5) = 20
    // Example: usedCount = 5, totalFreeCount = 5, remainingCount = 5 - 5 = 0
    const remainingCount = Math.max(0, totalFreeCount - usedCount);

    // Store all values in Redis permanently
    await redis.set(usedCountKey, usedCount.toString());
    await redis.set(totalFreeCountKey, totalFreeCount.toString());
    await redis.set(remainingCountKey, remainingCount.toString());

    console.log(
      `[Usage] Updated values for user ${userId}: usedCount=${usedCount}, totalFreeCount=${totalFreeCount}, remainingCount=${remainingCount}`,
    );
  } catch (error) {
    console.error(`[Usage] Error updating usage values for user ${userId}:`, error);
  }
}

/**
 * Increment user usage count (for free usage)
 * If user doesn't exist in Redis, initialize as new user first
 *
 * @param userId - User ID
 * @returns Promise<void>
 */
async function incrementUserUsage(userId: string): Promise<void> {
  try {
    // Check Redis connection status
    if (redis.status !== "ready") {
      console.warn(`[Usage] Redis not ready (status: ${redis.status}), skipping usage increment`);
      return;
    }

    // Get current used count
    const key = `${USER_USAGE_KEY_PREFIX}${userId}`;
    let currentUsedCountStr = await redis.get(key);

    // Only initialize new user if user doesn't exist at all (all keys are null)
    // This prevents re-initializing users who have used up their free quota (remainingCount = 0)
    if (currentUsedCountStr === null) {
      const exists = await userExistsInRedis(userId);
      if (!exists) {
        console.log(
          `[Usage] User ${userId} not found in Redis, initializing as new user before increment`,
        );
        await initializeNewUser(userId);
        // Re-fetch after initialization
        currentUsedCountStr = await redis.get(key);
      } else {
        // User exists but usedCount is null (partial data), treat as 0
        // This can happen if data is partially lost, but we don't want to re-initialize
        console.warn(`[Usage] User ${userId} exists but usedCount is null, treating as 0`);
        currentUsedCountStr = "0";
      }
    }

    // Get current used count (after potential initialization)
    const currentUsedCount = currentUsedCountStr ? parseInt(currentUsedCountStr, 10) : 0;

    // Increment usedCount by 1 (consume 1 credit for this request)
    const newUsedCount = currentUsedCount + 1;

    // Get current remainingCount from Redis and decrement by 1
    // Use atomic operation to ensure only one decrement happens
    const remainingCountKey = `${USER_REMAINING_COUNT_KEY_PREFIX}${userId}`;

    // Check if remainingCount exists, if not initialize user first
    const remainingCountExists = await redis.exists(remainingCountKey);
    if (!remainingCountExists) {
      const exists = await userExistsInRedis(userId);
      if (!exists) {
        // New user, initialize with FREE_USAGE_LIMIT
        await initializeNewUser(userId);
      } else {
        // User exists but remainingCount is null, set to 0
        await redis.set(remainingCountKey, "0");
      }
    }

    // Use Redis DECRBY to atomically decrement by 1, then get the result
    // This ensures only one decrement happens even if function is called multiple times
    const newRemainingCount = await redis.decrby(remainingCountKey, 1);

    // If result is negative, set it back to 0
    const finalRemainingCount = Math.max(0, newRemainingCount);
    if (newRemainingCount < 0) {
      await redis.set(remainingCountKey, "0");
    }

    // Get the original remainingCount before decrement for logging
    const currentRemainingCount = finalRemainingCount + 1;

    console.log(
      `[Usage] Incrementing usage - usedCount: ${currentUsedCount} -> ${newUsedCount}, remainingCount: ${currentRemainingCount} -> ${finalRemainingCount} (atomic decrement)`,
    );

    // Update usedCount in Redis
    await redis.set(key, newUsedCount.toString());

    console.log(`[Usage] User ${userId} usage count: ${currentUsedCount} -> ${newUsedCount}`);
  } catch (error) {
    console.error(`[Usage] Error incrementing usage for user ${userId}:`, error);
    // Don't throw error, allow request to continue processing even if Redis operation fails
    // In production environment, you may need to decide whether to throw error based on business requirements
  }
}

/**
 * Add usage credits based on payment amount
 * Payment: 0.01 USDC = 10 usage credits
 * USDC uses 6 decimals, so 0.01 USDC = 10000 atomic units = 10 credits
 *
 * Note: Unified calculation - no distinction between free and paid credits
 * Negative usedCount values indicate remaining paid credits beyond the free limit
 *
 * @param userId - User ID
 * @param paymentAmountAtomic - Payment amount in atomic units (USDC has 6 decimals)
 * @returns Promise<void>
 */
async function addUsageCreditsFromPayment(
  userId: string,
  paymentAmountAtomic: string,
): Promise<void> {
  try {
    // Check Redis connection status
    if (redis.status !== "ready") {
      console.warn(
        `[Usage] Redis not ready (status: ${redis.status}), skipping usage credit addition`,
      );
      return;
    }

    // Calculate usage credits: 0.01 USDC = 10 credits
    // USDC has 6 decimals, so:
    // - 0.01 USDC = 10000 atomic units = 10 credits
    // - 1 credit = 1000 atomic units = 0.001 USDC
    // So credits = paymentAmountAtomic / 1000
    console.log(`[Usage] Processing payment: ${paymentAmountAtomic} atomic units`);
    const paymentAmountAtomicBigInt = BigInt(paymentAmountAtomic);
    const creditsToAdd = Number(paymentAmountAtomicBigInt) / 1000;
    console.log(`[Usage] Calculated credits to add: ${creditsToAdd}`);

    if (creditsToAdd <= 0) {
      console.warn(
        `[Usage] Invalid payment amount: ${paymentAmountAtomic}, credits: ${creditsToAdd}`,
      );
      return;
    }

    // Round down to integer credits
    const creditsToAddInt = Math.floor(creditsToAdd);
    console.log(`[Usage] Rounded credits to add: ${creditsToAddInt}`);

    if (creditsToAddInt > 0) {
      const remainingCountKey = `${USER_REMAINING_COUNT_KEY_PREFIX}${userId}`;
      const totalFreeCountKey = `${USER_TOTAL_FREE_COUNT_KEY_PREFIX}${userId}`;
      const paidCreditsKey = `${USER_PAID_CREDITS_KEY_PREFIX}${userId}`;

      // Read current values from Redis
      const currentRemainingCountStr = await redis.get(remainingCountKey);
      const currentTotalFreeCountStr = await redis.get(totalFreeCountKey);
      const currentPaidCreditsStr = await redis.get(paidCreditsKey);

      // Get current values (default to 0 if null)
      const currentRemainingCount = currentRemainingCountStr
        ? parseInt(currentRemainingCountStr, 10)
        : 0;
      const currentTotalFreeCount = currentTotalFreeCountStr
        ? parseInt(currentTotalFreeCountStr, 10)
        : FREE_USAGE_LIMIT;
      const currentPaidCredits = currentPaidCreditsStr ? parseInt(currentPaidCreditsStr, 10) : 0;

      // Update values directly (no calculation)
      // remainingCount: directly add credits
      const newRemainingCount = currentRemainingCount + creditsToAddInt;
      // totalFreeCount: add credits
      const newTotalFreeCount = currentTotalFreeCount + creditsToAddInt;
      // paidCredits: add credits
      const newPaidCredits = currentPaidCredits + creditsToAddInt;

      console.log(
        `[Usage] Payment credits: ${creditsToAddInt}, remainingCount: ${currentRemainingCount} -> ${newRemainingCount}, totalFreeCount: ${currentTotalFreeCount} -> ${newTotalFreeCount}, paidCredits: ${currentPaidCredits} -> ${newPaidCredits}`,
      );

      // Store all values in Redis
      await redis.set(remainingCountKey, newRemainingCount.toString());
      await redis.set(totalFreeCountKey, newTotalFreeCount.toString());
      await redis.set(paidCreditsKey, newPaidCredits.toString());

      // Calculate USDC amount for logging (atomic units / 1,000,000)
      const paymentAmountUSDC = Number(paymentAmountAtomicBigInt) / 1_000_000;
      console.log(
        `[Usage] User ${userId} added ${creditsToAddInt} credits from payment ${paymentAmountAtomic} atomic units (${paymentAmountUSDC} USDC). New remainingCount: ${newRemainingCount}`,
      );
    }
  } catch (error) {
    console.error(`[Usage] Error adding usage credits for user ${userId}:`, error);
    // Don't throw error, allow request to continue processing even if Redis operation fails
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

    // Create a Promise that resolves when the response is successfully sent
    return new Promise<void>((resolve, reject) => {
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
            // Wait for response to finish sending before resolving
            res.once("finish", () => {
              console.log("[Proxy] Response sent successfully");
              resolve();
            });
          } else {
            // Response headers already sent, resolve immediately
            console.log("[Proxy] Response already sent, resolving");
            resolve();
          }
        });

        proxyRes.on("error", error => {
          console.error("[Proxy] Response error:", error);
          if (!res.headersSent) {
            res.status(500).json({ error: "Proxy response error", message: error.message });
            res.once("finish", () => {
              reject(error);
            });
          } else {
            reject(error);
          }
        });
      });

      // Handle proxy request errors
      proxyReq.on("error", error => {
        console.error(`[Proxy] Request error (${requestMethod} ${targetUrl.toString()}):`, error);
        if (!res.headersSent) {
          res.status(502).json({ error: "Proxy request failed", message: error.message });
          res.once("finish", () => {
            reject(error);
          });
        } else {
          reject(error);
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
    });
  } catch (error) {
    console.error("[Proxy] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Proxy error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error; // Re-throw to be caught by caller
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

  // OPTIONS preflight request doesn't need token, return success directly
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // 1. Get x-access-token from request headers
  // Express converts headers to lowercase, so use lowercase key name
  const accessTokenRaw = req.header("x-access-token") || req.headers["x-access-token"];
  const finalAccessToken = Array.isArray(accessTokenRaw) ? accessTokenRaw[0] : accessTokenRaw;

  // Add debug logs (only output when token is missing)
  if (
    !finalAccessToken ||
    (typeof finalAccessToken === "string" && finalAccessToken.trim() === "")
  ) {
    const availableHeaders = Object.keys(req.headers);
    console.error("[Generate] Missing x-access-token header");
    console.error("[Generate] Request method:", req.method);
    console.error("[Generate] Available headers:", availableHeaders.join(", "));
    console.error("[Generate] Header 'x-access-token':", req.headers["x-access-token"]);
    console.error("[Generate] Full headers object:", JSON.stringify(req.headers, null, 2));

    res.status(401).json({
      error: "Missing x-access-token header",
      message: "Please include 'x-access-token' header in your request",
      receivedHeaders: availableHeaders,
      method: req.method,
    });
    return;
  }

  // 2. Call /sys/getCurrUser to get user information
  const userInfo = await getCurrentUser(finalAccessToken);
  if (!userInfo) {
    console.error("[Generate] Failed to get user info");
    res.status(401).json({ error: "Failed to authenticate user" });
    return;
  }

  const { userId } = userInfo;
  console.log(`[Generate] User authenticated: ${userId}`);

  // 3. Check user remaining count from Redis
  // Always read remainingCount directly from Redis, never calculate
  // If remainingCount <= 0, user has used up all free usage and needs to pay
  const remainingCount = await getUserRemainingCount(userId); // Reads directly from Redis
  const requiresPayment = remainingCount <= 0;

  // Also get usageCount for logging (not used for payment decision)
  const usageCount = await getUserUsageCount(userId);

  console.log(
    `[Generate] User ${userId} remainingCount (from Redis): ${remainingCount}, usageCount: ${usageCount}/${FREE_USAGE_LIMIT}, requiresPayment: ${requiresPayment}`,
  );

  // 4. Prepare payment requirements (used for both GET and POST)
  const resource = `${req.protocol}://${req.headers.host}${req.originalUrl}` as Resource;
  const paymentRequirements = [
    createExactPaymentRequirements("$0.01", "base-sepolia", resource, "Access to chat API"),
  ];

  // 5. Handle GET requests - only verify payment requirements, don't execute inference
  if (req.method === "GET") {
    console.log(`[Generate] GET request - verifying payment requirements only`);

    if (requiresPayment) {
      // Check if payment header is provided
      const paymentHeader = req.header("X-PAYMENT") || req.header("x-payment");

      if (!paymentHeader) {
        // No payment header, return payment requirements
        console.log(`[Generate] GET request - payment required but no X-PAYMENT header`);
        res.status(402).json({
          x402Version,
          error: "Payment required",
          accepts: paymentRequirements,
          requiresPayment: true,
          remainingCount: remainingCount,
        });
        return;
      }

      // Payment header provided, verify it
      const isValid = await verifyPayment(req, res, paymentRequirements);
      if (!isValid) {
        console.log(`[Generate] GET request - payment verification failed`);
        return;
      }

      // Payment verified successfully
      console.log(`[Generate] GET request - payment verified successfully`);
      res.status(200).json({
        success: true,
        message: "Payment verified",
        requiresPayment: true,
        remainingCount: remainingCount,
      });
      return;
    } else {
      // No payment required
      console.log(`[Generate] GET request - no payment required`);
      res.status(200).json({
        success: true,
        message: "No payment required",
        requiresPayment: false,
        remainingCount: remainingCount,
      });
      return;
    }
  }

  // 6. Handle POST requests - verify payment (if needed) and execute inference
  if (req.method === "POST") {
    console.log(`[Generate] POST request - will execute inference after payment verification`);

    // If free usage limit exceeded, require x402 payment
    let paymentProcessed = false;
    let paymentAmountAtomic: string | null = null;

    if (requiresPayment) {
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

          // Extract payment amount from decoded payment
          // The payment amount is in the authorization.value field (atomic units)
          // Check if it's an EVM payload (has authorization field)
          if (
            decodedPayment.payload &&
            "authorization" in decodedPayment.payload &&
            decodedPayment.payload.authorization?.value
          ) {
            paymentAmountAtomic = decodedPayment.payload.authorization.value;
            console.log(
              `[Generate] Payment amount from authorization: ${paymentAmountAtomic} atomic units`,
            );
          } else {
            // Fallback: use maxAmountRequired from payment requirements
            // For exact scheme, user pays exactly maxAmountRequired
            paymentAmountAtomic = paymentRequirements[0].maxAmountRequired;
            console.log(
              `[Generate] Payment amount from requirements: ${paymentAmountAtomic} atomic units`,
            );
          }

          const settleResponse = await settle(decodedPayment, paymentRequirements[0]);
          const responseHeader = settleResponseHeader(settleResponse);
          res.setHeader("X-PAYMENT-RESPONSE", responseHeader);
          console.log("[Proxy] Payment settled successfully");
          paymentProcessed = true;

          // Add usage credits based on payment amount
          // Use paymentAmountAtomic or fallback to maxAmountRequired
          const amountToUse = paymentAmountAtomic || paymentRequirements[0].maxAmountRequired;
          if (amountToUse) {
            console.log(
              `[Generate] Adding credits for payment amount: ${amountToUse} atomic units`,
            );
            await addUsageCreditsFromPayment(userId, amountToUse);
          } else {
            console.warn(`[Generate] No payment amount found, cannot add credits`);
          }
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

    // Ensure body is properly handled for POST requests
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

    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    }
    if (Buffer.isBuffer(req.body)) {
      console.log("Request Body (Buffer):", req.body.length, "bytes");
    }
    console.log("=== End Request Parameters ===");

    // 7. Proxy the POST request (execute inference)
    // Only deduct usage count after inference is successfully completed
    // Use a flag to prevent double deduction
    let usageDeducted = false;
    try {
      // proxyPost now returns a Promise that resolves when response is successfully sent
      await proxyPost(req, res, "/mgn/agent/syncChat");

      // 8. Increment user usage count (consume 1 credit for this request)
      // Only deduct after inference is successfully completed and response is sent
      // This happens regardless of whether payment was made or not
      // If payment was made, credits were already added above, so this just consumes 1 credit
      // Use flag to prevent double deduction
      if (!usageDeducted && res.headersSent) {
        console.log("[Generate] Inference completed successfully, deducting usage count");
        usageDeducted = true;
        await incrementUserUsage(userId);
      } else {
        console.warn(
          `[Generate] Skipping usage deduction - usageDeducted: ${usageDeducted}, headersSent: ${res.headersSent}`,
        );
      }
    } catch (error) {
      console.error("[Generate] Inference failed:", error);
      // Don't deduct usage count if inference failed
      if (!res.headersSent) {
        res.status(500).json({
          error: "Inference failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
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

app.listen(4021, async () => {
  console.log(`Server listening at http://localhost:4021`);
  console.log(`CORS enabled for all origins`);
  console.log(`Proxy target URL: ${proxyTargetUrl}`);
  console.log(`Redis URL: ${redisUrl}`);
  console.log(`Redis status: ${redis.status}`);

  // Check Redis connection status
  try {
    if (redis.status === "ready") {
      console.log(`[Redis] Connection is ready`);
      // Test Redis connection with a ping
      const pong = await redis.ping();
      console.log(`[Redis] Ping response: ${pong}`);
    } else {
      console.warn(`[Redis] Connection is not ready, status: ${redis.status}`);
      console.warn(`[Redis] Data may not persist until connection is established`);
    }
  } catch (error) {
    console.error(`[Redis] Error checking connection:`, error);
  }

  console.log(`Available endpoints:`);
  console.log(`  GET /health`);
  console.log(`  GET /usage (Get user free inference usage)`);
  console.log(`  GET /dynamic-price`);
  console.log(`  GET /delayed-settlement`);
  console.log(`  GET /multiple-payment-requirements`);
  console.log(`  GET /generate (POST proxy with x402)`);
  console.log(`  POST /generate (POST proxy with x402)`);
});
