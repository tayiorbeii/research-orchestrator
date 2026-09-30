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
  ProviderSearchCapabilities,
  IssueProposal,
  IssueReadRequest,
  IssueSearchQuery,
  RevisionResolution,
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
  searchCapabilities(): ProviderSearchCapabilities {
    return {
      capabilityVersion: "github-rest-search-query-v1",
      revisionPinning: true,
      supportedQualifiers: { codeSearch: ["language", "path", "filename", "extension", "repo", "org"], repoSearch: ["language", "org"] },
      codeSearch: true,
      repoSearch: true,
      issues: true,
      batch: { codeSearch: false, repoSearch: false },
    };
  }
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

  private async request<T>(path: string, accept?: string): Promise<T> {
    this.assertConfigured();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status === 401 || response.status === 404 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") !== "0")) {
      throw new ResearchError("access_denied", `GitHub denied access (${response.status}) for ${path}.`, {
        recoverable: false,
        suggestedAction: "Check the requested repository and the caller's existing access; the provider will not retry or change credentials.",
      });
    }
    if (response.status === 429 || response.status === 403) {
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
    if (accept === "application/vnd.github.sha") return (await response.text()) as T;
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
        incomplete_results?: boolean;
      }>(`/search/code?q=${q}&per_page=10`);
      for (const item of data.items ?? []) {
        if (!item.repository?.full_name || !item.path) continue;
        results.push({ repo: item.repository.full_name, path: item.path, probeId: probe.id, truncated: data.incomplete_results === true });
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

  async searchIssues(input: IssueSearchQuery): Promise<IssueProposal[]> {
    const query = [input.query, input.repo ? `repo:${input.repo}` : undefined].filter(Boolean).join(" ");
    const data = await this.request<{ items?: Array<GitHubIssue & { pull_request?: unknown }> }>(
      `/search/issues?q=${encodeURIComponent(query)}+is%3Aissue&per_page=${input.maxResults}`,
    );
    return (data.items ?? []).filter((item) => !item.pull_request).map(normalizeIssue);
  }

  async getIssue(input: IssueReadRequest): Promise<IssueProposal> {
    const data = await this.request<GitHubIssue>(`/repos/${input.repo}/issues/${input.number}`);
    return normalizeIssue(data);
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

  async resolveRevision(input: RepoRef): Promise<RevisionResolution> {
    if (!input.ref) return { unavailableReason: "The repository default branch is unknown; no revision was fabricated." };
    try {
      const sha = await this.request<string>(`/repos/${input.repo}/commits/${encodeURIComponent(input.ref)}`, "application/vnd.github.sha");
      if (!/^[a-f0-9]{40}$/i.test(sha.trim())) return { unavailableReason: "GitHub did not return a 40-character commit SHA." };
      return { sha: sha.trim(), ref: input.ref, source: "provider" };
    } catch (error) {
      return { unavailableReason: `GitHub revision resolution failed: ${(error as Error).message}` };
    }
  }

  async getFile(input: FileReadRequest): Promise<FileEvidence> {
    try {
      const data = await this.request<{ path?: string; content?: string; encoding?: string }>(
        `/repos/${input.repo}/contents/${encodeURIComponent(input.path).replace(/%2F/g, "/")}${
          input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""
        }`,
      );
      const content =
        data.content && data.encoding === "base64"
          ? Buffer.from(data.content, "base64").toString("utf8")
          : undefined;
      return { provider: "github", repo: input.repo, path: data.path ?? input.path, ref: input.ref, content };
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

interface GitHubIssue {
  repository_url?: string;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url: string;
  created_at: string;
  updated_at: string;
}

function normalizeIssue(issue: GitHubIssue): IssueProposal {
  const repo = issue.repository_url?.replace(/^https:\/\/api\.github\.com\/repos\//, "") ?? "";
  return { repo, number: issue.number, title: issue.title, body: issue.body ?? "", state: issue.state, url: issue.html_url, createdAt: issue.created_at, updatedAt: issue.updated_at };
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
