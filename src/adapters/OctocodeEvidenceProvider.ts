import type {
  EvidenceProvider,
  FileEvidence,
  FileReadRequest,
  LocalRepoRef,
  NormalizedSearchResult,
  RepoMetadata,
  RepoRef,
  RepoSearchQuery,
  RepoSearchResult,
  RepoTree,
} from "./EvidenceProvider.js";
import type { SearchProbe } from "../schemas/index.js";
import { providerNotConfigured } from "../core/errors.js";

/**
 * Octocode MCP tool caller. The orchestrator does not embed an MCP client —
 * the host (a coding agent or MCP-aware runtime) injects a function that can
 * invoke current Octocode tools (ghSearchCode, ghGetFileContent, ...).
 */
export type OctocodeToolCaller = (toolName: string, args: unknown) => Promise<unknown>;

export interface OctocodeEvidenceProviderConfig {
  /** Injected bridge to a live Octocode MCP session. */
  callTool?: OctocodeToolCaller;
  /** Cap search results per probe. */
  maxResultsPerProbe?: number;
}

const NOT_CONFIGURED_HINT =
  "Provide an OctocodeToolCaller (a bridge to a live Octocode MCP session) in the constructor, " +
  "register one via setOctocodeToolCaller(), set RESEARCH_OCTOCODE_BRIDGE to a module exporting one, " +
  "or run with --mock. See docs/04_octocode_integration.md.";

/**
 * Octocode-backed evidence provider (docs/04_octocode_integration.md).
 *
 * Octocode is the evidence engine: repo/code search, file reads, tree
 * browsing, clone, local/structural/LSP search. This adapter normalizes its
 * output; it never leaks raw Octocode responses into core logic.
 *
 * Until a tool caller is injected, every method throws a structured
 * provider_not_configured ResearchError — the interface is the contract.
 */
export class OctocodeEvidenceProvider implements EvidenceProvider {
  readonly name = "octocode" as const;
  private readonly config: OctocodeEvidenceProviderConfig;

  constructor(config: OctocodeEvidenceProviderConfig = {}) {
    this.config = config;
  }

  get configured(): boolean {
    return typeof this.config.callTool === "function";
  }

  private caller(): OctocodeToolCaller {
    if (!this.config.callTool) {
      throw providerNotConfigured("Octocode", NOT_CONFIGURED_HINT);
    }
    return this.config.callTool;
  }

  async searchCode(probes: SearchProbe[]): Promise<NormalizedSearchResult[]> {
    const call = this.caller();
    const results: NormalizedSearchResult[] = [];
    // Octocode supports up to 5 bulk queries per call.
    for (let i = 0; i < probes.length; i += 5) {
      const batch = probes.slice(i, i + 5);
      const raw = (await call("ghSearchCode", {
        queries: batch.map((probe) => ({
          id: probe.id,
          mainResearchGoal: "Find implementation evidence for the requested feature.",
          researchGoal: probe.query,
          reasoning: probe.rationale,
          keywords: splitQueryTerms(probe.query),
          limit: this.config.maxResultsPerProbe ?? 25,
          page: 1,
          concise: false,
        })),
      })) as OctocodeSearchResponse;
      results.push(...normalizeSearchResponse(raw, batch));
    }
    return results;
  }

  async searchRepos(query: RepoSearchQuery): Promise<RepoSearchResult[]> {
    const call = this.caller();
    const raw = (await call("ghSearchRepos", {
      queries: [
        {
          id: "repo_search",
          mainResearchGoal: query.query,
          researchGoal: "Find repositories that implement the requested feature.",
          reasoning: "Repository discovery supplies candidates for proof-grade code reads.",
          keywords: query.query.split(/\s+/).filter(Boolean),
          match: ["name", "description", "readme"],
          limit: this.config.maxResultsPerProbe ?? 25,
          page: 1,
          concise: false,
        },
      ],
    })) as OctocodeRepoSearchResponse;
    return normalizeRepoSearchResponse(raw);
  }

  async getRepoMetadata(repo: RepoRef): Promise<RepoMetadata> {
    // Cheap default: derive from the repo string; a live integration can call
    // ghSearchRepos for richer metadata.
    this.caller();
    const [owner = "unknown", name = repo.repo] = repo.repo.split("/");
    return { repo: repo.repo, owner, name, url: `https://github.com/${repo.repo}` };
  }

  async getFile(input: FileReadRequest): Promise<FileEvidence> {
    const call = this.caller();
    const [owner, name] = input.repo.split("/");
    const raw = (await call("ghGetFileContent", {
      queries: [
        {
          id: `${input.repo}:${input.path}`,
          owner,
          repo: name,
          path: input.path,
          minify: "none",
          ...(input.startLine ? { startLine: input.startLine, endLine: input.endLine } : { fullContent: true }),
        },
      ],
    })) as OctocodeFileResponse;
    const modernResult = raw.results?.[0];
    const file = modernResult?.data?.files?.[0] ?? raw.files?.[0];
    return {
      provider: "octocode",
      repo: input.repo,
      path: input.path,
      ref: input.ref,
      content: file?.content,
      unavailableReason: file?.error ?? providerErrorText(modernResult?.error),
    };
  }

  async getRepoTree(repo: RepoRef): Promise<RepoTree> {
    const call = this.caller();
    const [owner, name] = repo.repo.split("/");
    const raw = (await call("ghViewRepoStructure", {
      queries: [
        {
          id: repo.repo,
          owner,
          repo: name,
          path: "",
          maxDepth: 3,
          itemsPerPage: 200,
          page: 1,
        },
      ],
    })) as OctocodeTreeResponse;
    return { repo: repo.repo, paths: normalizeTreePaths(raw) };
  }

  async cloneRepo(_repo: RepoRef): Promise<LocalRepoRef> {
    throw providerNotConfigured(
      "Octocode clone",
      "Clone requires ENABLE_LOCAL=true and ENABLE_CLONE=true on the Octocode server. " + NOT_CONFIGURED_HINT,
    );
  }
}

interface LegacySearchEntry {
  queryId?: string;
  repository?: string;
  repo?: string;
  path?: string;
  matches?: Array<{ line?: number; text?: string }>;
}

interface CurrentSearchMatch {
  value?: string;
  matchIndices?: Array<{ lineOffset?: number }>;
}

interface CurrentSearchFile {
  owner?: string;
  repo?: string;
  path?: string;
  matches?: CurrentSearchMatch[];
}

interface CurrentSearchResult {
  id?: string;
  data?: { files?: CurrentSearchFile[] };
  error?: unknown;
}

export interface OctocodeSearchResponse {
  results?: Array<LegacySearchEntry | CurrentSearchResult>;
}

interface OctocodeRepoSearchResponse {
  repositories?: Array<Record<string, unknown>>;
  results?: Array<{
    data?: { repositories?: Array<Record<string, unknown>> };
    error?: unknown;
  }>;
}

interface OctocodeFileResponse {
  files?: Array<{ content?: string; error?: string }>;
  results?: Array<{
    data?: { files?: Array<{ content?: string; error?: string }> };
    error?: unknown;
  }>;
}

interface OctocodeTreeResponse {
  paths?: string[];
  results?: Array<{
    data?: {
      structure?: Array<{ dir?: string; files?: string[]; folders?: string[] }>;
    };
    error?: unknown;
  }>;
}

/**
 * Normalize current Octocode `ghSearchCode` bulk envelopes and the legacy flat
 * `githubSearchCode` response into the provider-neutral search result shape.
 * Search snippet offsets are deliberately not promoted to source line numbers:
 * proof-grade lines come from a follow-up `ghGetFileContent` read.
 */
export function normalizeSearchResponse(
  raw: OctocodeSearchResponse,
  probes: SearchProbe[],
): NormalizedSearchResult[] {
  const fallbackProbe = probes[0]?.id ?? "unknown_probe";
  return (raw.results ?? []).flatMap<NormalizedSearchResult>((entry): NormalizedSearchResult[] => {
    const current = entry as CurrentSearchResult;
    if (current.data?.files) {
      const probeId = current.id ?? fallbackProbe;
      return current.data.files.flatMap((file) => {
        const repo = file.owner && file.repo ? `${file.owner}/${file.repo}` : file.repo;
        if (!repo || !file.path) return [];
        const matches = file.matches?.length ? file.matches : [{}];
        return matches.map((match) => ({
          repo,
          path: file.path!,
          probeId,
          snippet: match.value,
          raw: file,
        }));
      });
    }

    const legacy = entry as LegacySearchEntry;
    const repo = legacy.repository ?? legacy.repo;
    if (!repo || !legacy.path) return [];
    const probeId = legacy.queryId ?? fallbackProbe;
    const matches = legacy.matches?.length ? legacy.matches : [{}];
    return matches.map((match) => ({
      repo,
      path: legacy.path!,
      line: match.line,
      probeId,
      snippet: match.text,
      raw: legacy,
    }));
  });
}

function normalizeRepoSearchResponse(raw: OctocodeRepoSearchResponse): RepoSearchResult[] {
  const current = raw.results?.flatMap((result) => result.data?.repositories ?? []) ?? [];
  const repositories = current.length > 0 ? current : (raw.repositories ?? []);
  return repositories.flatMap((repository) => {
    const owner = repository.owner ? String(repository.owner) : undefined;
    const name = repository.repo ? String(repository.repo) : undefined;
    const fullName = repository.full_name
      ? String(repository.full_name)
      : owner && name
        ? `${owner}/${name}`
        : name;
    if (!fullName) return [];
    return [{
      repo: fullName,
      url: repository.url ? String(repository.url) : `https://github.com/${fullName}`,
      description: repository.description ? String(repository.description) : undefined,
      stars: typeof repository.stars === "number" ? repository.stars : undefined,
      archived: typeof repository.archived === "boolean" ? repository.archived : undefined,
      pushedAt: repository.pushedAt ? String(repository.pushedAt) : undefined,
    }];
  });
}

function normalizeTreePaths(raw: OctocodeTreeResponse): string[] {
  if (raw.paths?.length) return raw.paths;
  const paths = new Set<string>();
  for (const result of raw.results ?? []) {
    for (const entry of result.data?.structure ?? []) {
      const dir = entry.dir && entry.dir !== "." ? entry.dir.replace(/^\.\//, "").replace(/\/$/, "") : "";
      for (const file of entry.files ?? []) paths.add(dir ? `${dir}/${file}` : file);
      for (const folder of entry.folders ?? []) paths.add(dir ? `${dir}/${folder}` : folder);
    }
  }
  return [...paths];
}

function providerErrorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return error === undefined ? undefined : JSON.stringify(error);
}

/** Turn a quoted probe query into Octocode AND-terms. */
export function splitQueryTerms(query: string): string[] {
  const terms: string[] = [];
  const quoted = query.matchAll(/"((?:[^"\\]|\\.)*)"/g);
  for (const match of quoted) terms.push(match[1]!.replace(/\\"/g, '"'));
  if (terms.length === 0) terms.push(...query.split(/\s+/).filter(Boolean));
  return terms;
}
