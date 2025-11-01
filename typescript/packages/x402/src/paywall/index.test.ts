import { describe, expect, it } from "vitest";
import { getPaywallHtml } from "./index";

const baseOptions = {
  amount: 1,
  testnet: false,
  paymentRequirements: [],
  currentUrl: "https://example.com/resource",
} as const;

describe("getPaywallHtml", () => {
  it("escapes script-closing sequences in dynamic inputs", () => {
    const maliciousUrl = 'https://evil.test/"></script><img src=x onerror=alert(1)>';
    const html = getPaywallHtml({
      ...baseOptions,
      currentUrl: maliciousUrl,
      appName: 'App </script><script>alert(1)</script>',
      appLogo: 'logo</script>',
      sessionTokenEndpoint: '/session</script>',
    });

    expect(html).not.toContain(maliciousUrl);
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003C\\u002Fscript");
  });

  it("escapes unicode line separators and control characters", () => {
    const trickyName = "Line\u2028Separator\u2029Test\tEnd";
    const html = getPaywallHtml({
      ...baseOptions,
      appName: trickyName,
    });

    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
    expect(html).toContain("\\t");
    expect(html).not.toContain("\u2028");
    expect(html).not.toContain("\u2029");
  });
});
