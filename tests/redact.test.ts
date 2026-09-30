import { describe, expect, it } from "vitest";
import { redactArtifactContent, redactObject, redactSecrets } from "../src/core/redact.js";

// Found by the Phase 6 live pilot: live workflow excerpts contain escaped quotes, and
// regex redaction over serialized JSON text broke the JSON (redactObject threw).
describe("structural redaction", () => {
  it("redacts a quoted env assignment inside an excerpt without corrupting JSON", () => {
    const run = { observations: [{ excerpt: 'run: GH_TOKEN="abc123" ./scripts/check.sh' }] };
    const redacted = redactObject(run);
    expect(redacted.observations[0]!.excerpt).toBe("run: GH_TOKEN=[REDACTED] ./scripts/check.sh");
    expect(run.observations[0]!.excerpt).toContain("abc123");
  });

  it("keeps secret references verbatim so workflow evidence survives", () => {
    const excerpt = "env:\n  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n  NPM_TOKEN: $NPM_TOKEN\nrun: API_KEY=${API_KEY} make test";
    expect(redactSecrets(excerpt)).toBe(excerpt);
  });

  it("still redacts literal secrets on YAML lines inside multi-line strings", () => {
    const redacted = redactObject({ excerpt: "env:\n  GITHUB_TOKEN: abc123literal\n" });
    expect(redacted.excerpt).toBe("env:\n  GITHUB_TOKEN: [REDACTED]\n");
  });

  it("writes JSON artifacts that stay parseable after redaction", () => {
    const content = `${JSON.stringify({ snippet: 'GH_TOKEN="ghp_abcdefghijklmnopqrstuvwx" deploy' }, null, 2)}\n`;
    const out = redactArtifactContent("evidence.json", content);
    expect(JSON.parse(out)).toEqual({ snippet: "GH_TOKEN=[REDACTED] deploy" });
    expect(out.endsWith("\n")).toBe(true);
  });

  it("drops undefined fields like JSON serialization did", () => {
    expect(redactObject({ a: undefined, b: [1, null, "x"] })).toEqual({ b: [1, null, "x"] });
  });
});
