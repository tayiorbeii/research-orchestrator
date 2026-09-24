import type {
  CandidateRepo,
  EvidenceAnchor,
  EvidenceProviderName,
  FeatureSpec,
  RepoQuestionAnswer,
  SearchProbe,
} from "../schemas/index.js";

export interface RepoRef {
  repo: string; // "owner/name"
  ref?: string;
}

/** Normalized search result — never raw provider output. */
export interface NormalizedSearchResult {
  repo: string;
  path: string;
  branch?: string;
  line?: number;
  probeId: string;
  snippet?: string;
  raw?: unknown;
}

export interface RepoSearchQuery {
  query: string;
  language?: string;
  maxResults?: number;
}

export interface RepoSearchResult {
  repo: string;
  url?: string;
  description?: string;
  stars?: number;
  archived?: boolean;
  pushedAt?: string;
}

export interface RepoMetadata {
  repo: string;
  owner: string;
  name: string;
  defaultBranch?: string;
  url?: string;
  archived?: boolean;
  stars?: number;
  pushedAt?: string;
}

export interface FileReadRequest {
  repo: string;
  path: string;
  ref?: string;
  startLine?: number;
  endLine?: number;
}

export interface FileEvidence {
  provider: EvidenceProviderName;
  repo: string;
  path: string;
  ref?: string;
  content?: string;
  url?: string;
  /** Set when the file could not be read; the reason becomes a missingProof entry. */
  unavailableReason?: string;
}

export interface RepoTree {
  repo: string;
  paths: string[];
}

export interface LocalRepoRef {
  repo: string;
  localPath: string;
}

/**
 * Core evidence interface from docs/01_architecture.md. Core logic depends
 * on this interface only — never on Octocode/GitHub/DeepWiki directly.
 */
export interface EvidenceProvider {
  readonly name: EvidenceProviderName;
  searchCode(probes: SearchProbe[]): Promise<NormalizedSearchResult[]>;
  searchRepos(query: RepoSearchQuery): Promise<RepoSearchResult[]>;
  getRepoMetadata(repo: RepoRef): Promise<RepoMetadata>;
  getFile(input: FileReadRequest): Promise<FileEvidence>;
  getRepoTree?(repo: RepoRef): Promise<RepoTree>;
  cloneRepo?(repo: RepoRef): Promise<LocalRepoRef>;
}

// ---------------------------------------------------------------------------
// Repo explainer (DeepWiki + fallback) interfaces from docs/05_deepwiki_adapter.md
// ---------------------------------------------------------------------------

export interface CapabilityResult {
  provider: string;
  available: boolean;
  indexed?: boolean;
  lastIndexedAt?: string;
  indexedCommit?: string;
  stale?: boolean;
  reason?: string;
}

export interface ExplainInput {
  repo: RepoRef;
  feature: FeatureSpec;
  questions: string[];
  freshnessPolicy?: {
    maxAgeDays?: number;
    requireCommitCheck?: boolean;
  };
}

export interface ExplainOutput {
  provider: "deepwiki" | "octocode-fallback" | "hybrid" | "mock";
  repo: string;
  answers: RepoQuestionAnswer[];
  freshness?: CapabilityResult;
  warnings: string[];
  /** Exact evidence anchors collected while verifying (hybrid/fallback flows). */
  anchors?: EvidenceAnchor[];
}

export interface RepoExplainer {
  canExplain(repo: RepoRef): Promise<CapabilityResult>;
  explain(input: ExplainInput): Promise<ExplainOutput>;
}

/** Helper to build a CandidateRepo shell from a repo string. */
export function candidateShell(repo: string): Pick<CandidateRepo, "repo" | "owner" | "name"> {
  const [owner = "unknown", name = repo] = repo.split("/");
  return { repo, owner, name };
}

export type { EvidenceAnchor };
