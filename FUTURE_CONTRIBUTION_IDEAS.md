# Future Contribution Ideas

## Honor Proxy Headers in TypeScript Middleware
- **Context:** The Python Flask middleware already respects `X-Original-URI` when reconstructing the protected resource URL, but the TypeScript middlewares for Express, Hono, and Next fall back to the raw request path. Reverse proxies that rewrite URLs (e.g., Nginx, Cloudflare, API gateways) therefore produce paywall links that point at the proxy rather than the original route.
- **Why it matters:** Incorrect resource URLs cascade into malformed payment requirements and broken paywall redirects for downstream integrators hosting behind a proxy.
- **Suggested scope:**
  1. Extend the Express, Hono, and Next middleware implementations to read `X-Original-URI` (and `X-Forwarded-Proto` / `X-Forwarded-Host` where available) before falling back to the local request path.
  2. Normalize and validate the reconstructed URL to avoid header spoofing.
  3. Add focused unit tests in each package to cover the new header-aware branch.
  4. Update README snippets or inline docs to mention proxy compatibility.

## Harden Paywall HTML Escaping
- **Context:** `getPaywallHtml` only escapes quotes, backslashes, and whitespace before embedding dynamic values inside `<script>` tags. Strings containing `<`, `>` or `</script>` can therefore smuggle executable markup, enabling content injection when paywall settings come from user-controlled sources.
- **Why it matters:** The facilitator may operate in multi-tenant environments; robust escaping reduces the risk of in-browser script injection.
- **Suggested scope:**
  1. Expand `escapeString` to escape `<`, `>`, and `/`, or switch to a whitelist encoder that converts every non-alphanumeric character to `\uXXXX`.
  2. Back the change with unit tests that feed representative payloads (`</script><img ...>`, Unicode separators, etc.) and assert the output remains a single JavaScript string literal.
  3. Consider documenting the escaping guarantees in the paywall README for developers embedding custom content.
