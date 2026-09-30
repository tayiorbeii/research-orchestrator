/** Deterministic, budget-bounded ordering for repository source reads. */
export type SourceReadReason =
  | "exact_hit"
  | "caller_path"
  | "ecosystem_config"
  | "implementation_path"
  | "tree_sample";
export type UntouchedSourceReason = SourceReadReason | "source_kind_not_allowed";

export interface SourceRead {
  path: string;
  reason: SourceReadReason;
  /** Set for a bounded follow-up read discovered in another source. */
  referencedBy?: { path: string; observationId?: string; detail: string };
}

export interface UntouchedSource {
  path: string;
  reason: UntouchedSourceReason;
}

export interface SourceSelectionInput {
  question?: string;
  obligations?: readonly string[];
  exactHits?: readonly string[];
  callerPaths?: readonly string[];
  treeSample?: readonly string[];
  ecosystem?: string | readonly string[];
  budget: { total: number; perRepo: number };
  /** Sources previously read, used to schedule bounded config/workflow references. */
  references?: readonly {
    path: string;
    referencedBy: { path: string; observationId?: string; detail: string };
  }[];
}

export interface SourceSelection {
  reads: SourceRead[];
  untouched: UntouchedSource[];
}

const ECOSYSTEM_CONFIGS = new Set([
  "pyproject.toml", "ruff.toml", ".ruff.toml", ".pre-commit-config.yaml",
  ".pre-commit-config.yml", "package.json", "tsconfig.json", "setup.cfg",
  "mypy.ini", ".github/workflows",
]);

/**
 * Pick paths without treating file type as evidence. Explicit hits and caller
 * paths win; ecosystem configuration and likely implementation sources follow;
 * the incomplete tree sample is last. Directories are never returned as reads.
 */
export function selectSourceReads(input: SourceSelectionInput): SourceSelection {
  const candidates = new Map<string, SourceRead>();
  const add = (path: string, reason: SourceReadReason, referencedBy?: SourceRead["referencedBy"]) => {
    const normalized = normalizePath(path);
    if (!normalized || isDirectory(path)) return;
    const current = candidates.get(normalized);
    if (!current || priority(reason) < priority(current.reason)) {
      candidates.set(normalized, { path: normalized, reason, ...(referencedBy ? { referencedBy } : {}) });
    }
  };

  for (const path of input.exactHits ?? []) add(path, "exact_hit");
  for (const path of input.callerPaths ?? []) add(path, "caller_path");

  const ecosystemNames = ecosystemList(input.ecosystem);
  const configPaths = [...(input.treeSample ?? []), ...(input.references ?? []).map((item) => item.path)];
  for (const path of configPaths) {
    if (isEcosystemConfig(path, ecosystemNames)) {
      const ref = input.references?.find((item) => normalizePath(item.path) === normalizePath(path));
      add(path, "ecosystem_config", ref?.referencedBy);
    }
  }

  for (const path of input.treeSample ?? []) {
    if (isImplementationPath(path)) add(path, "implementation_path");
  }
  for (const ref of input.references ?? []) {
    // References are an explicit lead. Keep them ahead of an incidental sample,
    // while preserving the public reason vocabulary for source-read consumers.
    if (!isEcosystemConfig(ref.path, ecosystemNames)) add(ref.path, "implementation_path", ref.referencedBy);
  }
  for (const path of input.treeSample ?? []) add(path, "tree_sample");

  // Map insertion order preserves provider hit/caller/tree ranking within a
  // tier; the tier ordering itself supplies the deterministic priority.
  const ordered = [...candidates.values()].sort((a, b) => priority(a.reason) - priority(b.reason));
  const cap = Math.max(0, Math.min(input.budget.total, input.budget.perRepo));
  return { reads: ordered.slice(0, cap), untouched: ordered.slice(cap).map(({ path, reason }) => ({ path, reason })) };
}

function priority(reason: SourceReadReason): number {
  return ["exact_hit", "caller_path", "ecosystem_config", "implementation_path", "tree_sample"].indexOf(reason);
}

function normalizePath(path: string): string {
  return path.replace(/^(\.\/)+/, "").replace(/\\/g, "/");
}

function isDirectory(path: string): boolean {
  return path.endsWith("/") || path === "." || path === "..";
}

function ecosystemList(value: SourceSelectionInput["ecosystem"]): string[] {
  return typeof value === "string" ? [value.toLowerCase()] : (value ?? []).map((item) => item.toLowerCase());
}

function isEcosystemConfig(path: string, ecosystems: string[]): boolean {
  const normalized = path.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (ECOSYSTEM_CONFIGS.has(basename)) return true;
  if (normalized.startsWith(".github/workflows/") && /\.(ya?ml)$/i.test(normalized)) return true;
  if (ecosystems.includes("python")) return /(^|\/)(tox\.ini|pytest\.ini|\.flake8|\.pylintrc)$/.test(normalized);
  if (ecosystems.includes("node") || ecosystems.includes("javascript") || ecosystems.includes("typescript")) {
    return /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[^/]+)?|vite\.config\.[cm]?[jt]s)$/.test(normalized);
  }
  return false;
}

function isImplementationPath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|pyi|rs|go|java|kt|rb|php|cs|cpp|h|swift)$/i.test(path) &&
    !/(^|\/)(?:test|tests|__tests__|docs?|examples?)\//i.test(path);
}

/** Shared §7.4 path classification for both read ranking and claim scope. */
export function classifySourcePath(path: string): "implementation_path" | "ecosystem_config" | undefined {
  if (isEcosystemConfig(path, ["node", "typescript", "python"])) return "ecosystem_config";
  if (isImplementationPath(path)) return "implementation_path";
  return undefined;
}
