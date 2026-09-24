import { execFileSync } from "node:child_process";
import type {
  EvidenceProvider,
  FileEvidence,
  FileReadRequest,
  NormalizedSearchResult,
  RepoMetadata,
  RepoRef,
  RepoSearchQuery,
  RepoSearchResult,
} from "./EvidenceProvider.js";
import type { SearchProbe } from "../schemas/index.js";
import { providerNotConfigured, ResearchError } from "../core/errors.js";

export interface GitHubEvidenceProviderConfig {
  /** Personal access token; use a low-scope token (docs/09_security_privacy.md). */
  token?: string;
  baseUrl?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable gh token lookup for tests; defaults to `gh auth token`. */
  getGhToken?: () => string | undefined;
}

const NOT_CONFIGURED_HINT =
  "Run `gh auth login` or set GITHUB_TOKEN/GH_TOKEN, then retry; alternatively pass { token } or use --mock.";

/**
 * Direct GitHub REST provider — a fallback evidence engine when Octocode is
 * unavailable. Not-configured calls throw structured errors instead of
 * guessing.
 */
export class GitHubEvidenceProvider implements EvidenceProvider {
  readonly name = "github" as const;
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GitHubEvidenceProviderConfig = {}) {
    this.token =
      config.token?.trim() ||
      process.env.GITHUB_TOKEN?.trim() ||
      process.env.GH_TOKEN?.trim() ||
      (config.getGhToken ?? getGhCliToken)();
    this.baseUrl = config.baseUrl ?? "https://api.github.com";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  private assertConfigured(): void {
    if (!this.configured) throw providerNotConfigured("GitHub", NOT_CONFIGURED_HINT);
  }

  private async request<T>(path: string): Promise<T> {
    this.assertConfigured();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status === 403 || response.status === 429) {
      throw new ResearchError("rate_limited", `GitHub rate limited (${response.status}) for ${path}.`, {
        recoverable: true,
        suggestedAction: "Wait for the rate-limit window or use a token with more quota.",
      });
    }
    if (!response.ok) {
      throw new ResearchError("incomplete_results", `GitHub request failed (${response.status}) for ${path}.`, {
        recoverable: true,
      });
    }
    return (await response.json()) as T;
  }

  async searchCode(probes: SearchProbe[]): Promise<NormalizedSearchResult[]> {
    this.assertConfigured();
    const results: NormalizedSearchResult[] = [];
    for (const probe of probes) {
      if (probe.kind === "repo_search") continue;
      const q = encodeURIComponent(toGitHubQuery(probe.query));
      const data = await this.request<{
        items?: Array<{ repository?: { full_name?: string }; path?: string }>;
      }>(`/search/code?q=${q}&per_page=10`);
      for (const item of data.items ?? []) {
        if (!item.repository?.full_name || !item.path) continue;
        results.push({ repo: item.repository.full_name, path: item.path, probeId: probe.id });
      }
    }
    return results;
  }

  async searchRepos(query: RepoSearchQuery): Promise<RepoSearchResult[]> {
    const data = await this.request<{
      items?: Array<{
        full_name: string;
        html_url: string;
        description?: string;
        stargazers_count?: number;
        archived?: boolean;
        pushed_at?: string;
      }>;
    }>(`/search/repositories?q=${encodeURIComponent(query.query)}&per_page=${query.maxResults ?? 10}`);
    return (data.items ?? []).map((item) => ({
      repo: item.full_name,
      url: item.html_url,
      description: item.description,
      stars: item.stargazers_count,
      archived: item.archived,
      pushedAt: item.pushed_at,
    }));
  }

  async getRepoMetadata(repo: RepoRef): Promise<RepoMetadata> {
    const data = await this.request<{
      full_name: string;
      owner: { login: string };
      name: string;
      default_branch?: string;
      html_url?: string;
      archived?: boolean;
      stargazers_count?: number;
      pushed_at?: string;
    }>(`/repos/${repo.repo}`);
    return {
      repo: data.full_name,
      owner: data.owner.login,
      name: data.name,
      defaultBranch: data.default_branch,
      url: data.html_url,
      archived: data.archived,
      stars: data.stargazers_count,
      pushedAt: data.pushed_at,
    };
  }

  async getFile(input: FileReadRequest): Promise<FileEvidence> {
    try {
      const data = await this.request<{ content?: string; encoding?: string }>(
        `/repos/${input.repo}/contents/${encodeURIComponent(input.path).replace(/%2F/g, "/")}${
          input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""
        }`,
      );
      const content =
        data.content && data.encoding === "base64"
          ? Buffer.from(data.content, "base64").toString("utf8")
          : undefined;
      return { provider: "github", repo: input.repo, path: input.path, ref: input.ref, content };
    } catch (error) {
      if (error instanceof ResearchError && error.code === "provider_not_configured") throw error;
      return {
        provider: "github",
        repo: input.repo,
        path: input.path,
        unavailableReason: (error as Error).message,
      };
    }
  }
}

/** Convert probe syntax ("a" "b" path:foo) to GitHub code-search qualifiers. */
function getGhCliToken(): string | undefined {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function toGitHubQuery(query: string): string {
  return query
    .replace(/path:(\S+)/g, "path:$1")
    .replace(/\s+/g, " ")
    .trim();
}
