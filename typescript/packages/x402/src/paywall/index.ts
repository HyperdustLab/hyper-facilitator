import { PAYWALL_TEMPLATE } from "./gen/template";
import { config } from "../types/shared/evm/config";
import { PaymentRequirements } from "../types/verify";

interface PaywallOptions {
  amount: number;
  paymentRequirements: PaymentRequirements[];
  currentUrl: string;
  testnet: boolean;
  cdpClientKey?: string;
  appName?: string;
  appLogo?: string;
  sessionTokenEndpoint?: string;
}

/**
 * Escapes a string for safe injection into JavaScript string literals
 *
 * @param str - The string to escape
 * @returns The escaped string
 */
const ESCAPE_LOOKUP: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "'": "\\'",
  "`": "\\u0060",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\u0008": "\\b",
  "\u000c": "\\f",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
  "<": "\\u003C",
  ">": "\\u003E",
  "&": "\\u0026",
  "=": "\\u003D",
  "/": "\\u002F",
};

const ESCAPE_REGEX = /[\\'"`\u0008\u000c\n\r\t\u2028\u2029<>&=\/]/g;

function escapeString(str: string): string {
  return str.replace(ESCAPE_REGEX, char => ESCAPE_LOOKUP[char] ?? char);
}

/**
 * Generates an HTML paywall page that allows users to pay for content access
 *
 * @param options - The options for generating the paywall
 * @param options.amount - The amount to be paid in USD
 * @param options.paymentRequirements - The payment requirements for the content
 * @param options.currentUrl - The URL of the content being accessed
 * @param options.testnet - Whether to use testnet or mainnet
 * @param options.cdpClientKey - CDP client API key for OnchainKit
 * @param options.appName - The name of the application to display in the wallet connection modal
 * @param options.appLogo - The logo of the application to display in the wallet connection modal
 * @param options.sessionTokenEndpoint - The API endpoint for generating session tokens for Onramp authentication
 * @returns An HTML string containing the paywall page
 */
export function getPaywallHtml({
  amount,
  testnet,
  paymentRequirements,
  currentUrl,
  cdpClientKey,
  appName,
  appLogo,
  sessionTokenEndpoint,
}: PaywallOptions): string {
  const logOnTestnet = testnet
    ? "console.log('Payment requirements initialized:', window.x402);"
    : "";

  // Create the configuration script to inject with proper escaping
  const configScript = `
  <script>
    window.x402 = {
      amount: ${amount},
      paymentRequirements: ${JSON.stringify(paymentRequirements)},
      testnet: ${testnet},
      currentUrl: "${escapeString(currentUrl)}",
      config: {
        chainConfig: ${JSON.stringify(config)},
      },
      cdpClientKey: "${escapeString(cdpClientKey || "")}",
      appName: "${escapeString(appName || "")}",
      appLogo: "${escapeString(appLogo || "")}",
      sessionTokenEndpoint: "${escapeString(sessionTokenEndpoint || "")}",
    };
    ${logOnTestnet}
  </script>`;

  // Inject the configuration script into the head
  return PAYWALL_TEMPLATE.replace("</head>", `${configScript}\n</head>`);
}
