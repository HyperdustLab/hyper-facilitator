# Future Contribution Ideas

## Harden Paywall HTML Escaping
- **Context:** `getPaywallHtml` still escapes only quotes, backslashes, and whitespace before injecting dynamic values into the paywall `<script>` tag. Inputs containing `<`, `>` or `</script>` can therefore break out of the string literal and inject markup when paywall settings come from untrusted sources.
- **Why it matters:** Facilitators may run in multi-tenant environments; robust escaping lowers the chance of paywall-driven cross-site scripting.
- **Suggested scope:**
  1. Expand `escapeString` (or replace it with a safer encoder) so characters like `<`, `>`, `/`, and backticks are consistently escaped.
  2. Add targeted unit tests that feed malicious payloads (closing script tags, Unicode separators, etc.) and assert the generated HTML keeps them within the JavaScript string literal.
  3. Update the paywall README to describe the escaping guarantees and any remaining constraints for teams supplying custom paywall inputs.
