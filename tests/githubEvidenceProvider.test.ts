import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubEvidenceProvider } from "../src/adapters/GitHubEvidenceProvider.js";

afterEach(() => vi.unstubAllEnvs());

describe("GitHubEvidenceProvider authentication", () => {
  it("resolves a branch to a bare commit SHA and reads files at that SHA", async () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/tool/commits/main")) return new Response(sha, { status: 200 });
      if (url.includes("/contents/README.md")) return new Response(JSON.stringify({ path: "README.md", content: Buffer.from("hello").toString("base64"), encoding: "base64" }), { status: 200 });
      throw new Error(`unexpected URL ${url}; Accept=${new Headers(init?.headers).get("Accept")}`);
    });
    const provider = new GitHubEvidenceProvider({ token: "token", fetchImpl });
    expect(provider.searchCapabilities().revisionPinning).toBe(true);
    const resolution = await provider.resolveRevision({ repo: "acme/tool", ref: "main" });
    expect(resolution).toEqual({ sha, ref: "main", source: "provider" });
    const file = await provider.getFile({ repo: "acme/tool", path: "README.md", ref: sha });
    expect(file.content).toBe("hello");
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.github.com/repos/acme/tool/commits/main", expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/vnd.github.sha" }) }));
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(`/contents/README.md?ref=${sha}`);
  });

  it("searches issues with is:issue and filters pull requests, then reads issue details", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues")) return new Response(JSON.stringify({ items: [
        { repository_url: "https://api.github.com/repos/acme/tool", number: 7, title: "Proposal", body: "Custom rules", state: "open", html_url: "https://github.com/acme/tool/issues/7", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z" },
        { repository_url: "https://api.github.com/repos/acme/tool", number: 8, title: "PR", body: "", state: "open", html_url: "https://github.com/acme/tool/pull/8", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z", pull_request: { url: "..." } },
      ] }), { status: 200 });
      return new Response(JSON.stringify({ repository_url: "https://api.github.com/repos/acme/tool", number: 7, title: "Proposal", body: "Custom rules", state: "closed", html_url: "https://github.com/acme/tool/issues/7", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z" }), { status: 200 });
    });
    const provider = new GitHubEvidenceProvider({ token: "token", fetchImpl });
    const found = await provider.searchIssues({ query: "custom rules", repo: "acme/tool", maxResults: 4 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ repo: "acme/tool", number: 7, createdAt: "2025-01-01T00:00:00Z" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/search/issues?q=custom%20rules%20repo%3Aacme%2Ftool+is%3Aissue&per_page=4");
    expect(await provider.getIssue({ repo: "acme/tool", number: 7 })).toMatchObject({ state: "closed", updatedAt: "2025-01-02T00:00:00Z" });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("https://api.github.com/repos/acme/tool/issues/7");
  });

  it("uses gh auth when no token environment variable is configured", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const provider = new GitHubEvidenceProvider({
      fetchImpl,
      getGhToken: () => "gh-cli-token",
    });

    expect(provider.configured).toBe(true);
    await provider.searchRepos({ query: "example", maxResults: 1 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/search/repositories?q=example&per_page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gh-cli-token" }),
      }),
    );
  });

  it("prefers an explicitly configured token over gh auth", () => {
    const getGhToken = vi.fn(() => "gh-cli-token");
    const provider = new GitHubEvidenceProvider({ token: "explicit-token", getGhToken });

    expect(provider.configured).toBe(true);
    expect(getGhToken).not.toHaveBeenCalled();
  });

  it("is unconfigured when neither env credentials nor gh auth are available", () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const provider = new GitHubEvidenceProvider({ getGhToken: () => undefined });

    expect(provider.configured).toBe(false);
  });

  it("treats a private-repository 404 as access denial and does not retry", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const provider = new GitHubEvidenceProvider({ token: "token", fetchImpl });
    await expect(provider.searchRepos({ query: "private repo" })).rejects.toMatchObject({ code: "access_denied" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
