import type { CandidateRepo, EvidenceAnchor, FeatureSpec } from "../schemas/index.js";
import type { EvidenceProvider } from "../adapters/EvidenceProvider.js";

export interface CollectedEvidence {
  anchors: EvidenceAnchor[];
  warnings: string[];
}

const DOCS_PATH_PATTERN = /(^|\/)readme(\.|$)|\.mdx?$|(^|\/)docs\//i;
const MANIFEST_PATH_PATTERN =
  /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|cargo\.toml|go\.mod|gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?)$/i;

/**
 * Read the matched files of a candidate and promote proof-requirement
 * signals found in exact file content into evidence anchors.
 *
 * Documentation is partial context for application goals, but may be proved
 * evidence for research requirements where docs are the authoritative source.
 */
export async function collectEvidence(
  provider: EvidenceProvider,
  spec: FeatureSpec,
  candidate: CandidateRepo,
): Promise<CollectedEvidence> {
  const anchors: EvidenceAnchor[] = [];
  const warnings: string[] = [];
  let counter = 0;

  for (const path of candidate.matchedPaths) {
    let content: string | undefined;
    let fileProvider = provider.name;
    try {
      const file = await provider.getFile({ repo: candidate.repo, path });
      fileProvider = file.provider;
      if (file.unavailableReason) {
        warnings.push(
          `missingProof: ${candidate.repo}:${path} could not be read (${file.unavailableReason}).`,
        );
        continue;
      }
      content = file.content;
    } catch (error) {
      warnings.push(
        `missingProof: ${candidate.repo}:${path} read failed (${(error as Error).message}).`,
      );
      continue;
    }
    if (content === undefined) {
      warnings.push(`missingProof: ${candidate.repo}:${path} returned no content.`);
      continue;
    }

    const lines = content.split("\n");
    const isDocs = DOCS_PATH_PATTERN.test(path);
    const isManifest = MANIFEST_PATH_PATTERN.test(path);

    for (const req of spec.proofRequirements) {
      const isResearchProof = spec.goalKind === "research" && req.key !== "dependency_proof";
      // Dependency proof must come from a dependency manifest, not incidental imports.
      if (req.key === "dependency_proof" && !isManifest) continue;
      // Non-dependency application proofs must come from source, not manifests.
      if (req.key !== "dependency_proof" && !isResearchProof && isManifest) continue;
      // A manifest may establish project existence, but package metadata is not
      // authoritative evidence of behavior.
      if (req.key === "behavior_proof" && isManifest) continue;

      const signals = isDocs && !isResearchProof ? [...req.signals, ...spec.requiredConcepts] : req.signals;
      const hits =
        req.key === "existence_proof"
          ? findSignalHits(lines, signals).filter((hit) =>
              candidateRepresentsSignal(candidate, hit.signal),
            )
          : [findFirstSignal(lines, signals)].filter(
              (hit): hit is SignalHit => hit !== undefined,
            );
      if (hits.length === 0) continue;

      const branch = candidate.defaultBranch ?? "main";
      // Docs are legitimate *proved* evidence for research proofs; ordinary docs
      // matches stay "partial" context and never count as implementation proof.
      const role = isDocs ? (isResearchProof ? req.key : "docs_reference") : req.key;
      const proofLevel = isDocs ? (isResearchProof ? "proved" : "partial") : "proved";
      for (const hit of hits) {
        counter += 1;
        anchors.push({
          id: `ev_${candidate.owner}_${candidate.name}_${counter}`,
          provider: fileProvider,
          repo: candidate.repo,
          ref: candidate.defaultBranch,
          path,
          startLine: hit.line,
          endLine: hit.line,
          matchText: hit.text.slice(0, 200),
          matchedSignal: hit.signal,
          url: candidate.url ? `${candidate.url}/blob/${branch}/${path}#L${hit.line}` : undefined,
          role,
          proofLevel,
        });
      }
    }
  }

  return { anchors: dedupeAnchors(anchors), warnings };
}

interface SignalHit {
  line: number;
  text: string;
  signal: string;
}

function findFirstSignal(lines: string[], signals: string[]): SignalHit | undefined {
  return findSignalHits(lines, signals)[0];
}

function findSignalHits(lines: string[], signals: string[]): SignalHit[] {
  const hits: SignalHit[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const normalized = signal.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const idx = lines.findIndex((line) => lineHasSignal(line, signal));
    if (idx >= 0) hits.push({ line: idx + 1, text: lines[idx]!.trim(), signal });
  }
  return hits;
}

function candidateRepresentsSignal(candidate: CandidateRepo, signal: string): boolean {
  const normalizedSignal = normalizeEntity(signal);
  if (!normalizedSignal) return false;
  const identityParts = [candidate.owner, candidate.name, ...candidate.repo.split("/")]
    .flatMap((part) => part.split(/[-_.]/))
    .map(normalizeEntity)
    .filter(Boolean);
  return identityParts.some(
    (part) =>
      part === normalizedSignal ||
      (normalizedSignal.length >= 4 && part.startsWith(normalizedSignal)) ||
      (part.length >= 4 && normalizedSignal.startsWith(part)),
  );
}

function normalizeEntity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Substring match with identifier-boundary checks so "convexAuth" does not
 * match inside "convexAuthNextjsMiddleware".
 */
export function lineHasSignal(line: string, signal: string): boolean {
  const needle = signal.trim().toLowerCase();
  if (!needle) return false;
  const haystack = line.toLowerCase();
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const first = needle[0]!;
    const last = needle[needle.length - 1]!;
    const beforeOk =
      !WORD_CHAR.test(first) || idx === 0 || !WORD_CHAR.test(haystack[idx - 1]!);
    const afterIdx = idx + needle.length;
    const afterOk =
      !WORD_CHAR.test(last) || afterIdx >= haystack.length || !WORD_CHAR.test(haystack[afterIdx]!);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  return false;
}

function dedupeAnchors(anchors: EvidenceAnchor[]): EvidenceAnchor[] {
  const seen = new Set<string>();
  return anchors.filter((a) => {
    const signalKey =
      a.role === "existence_proof" ? (a.matchedSignal?.toLowerCase() ?? "") : "";
    const key = `${a.repo}:${a.path}:${a.role}:${signalKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
