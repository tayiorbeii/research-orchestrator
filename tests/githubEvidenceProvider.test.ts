import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubEvidenceProvider } from "../src/adapters/GitHubEvidenceProvider.js";

afterEach(() => vi.unstubAllEnvs());

describe("GitHubEvidenceProvider authentication", () => {
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
});
