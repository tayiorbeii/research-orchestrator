import type { CandidateRepo, EvidenceAnchor, FeatureSpec } from "../schemas/index.js";
import type { EvidenceProvider } from "../adapters/EvidenceProvider.js";
import { EVIDENCE_POLICY_VERSION } from "./evidencePolicy.js";
import { createHash } from "node:crypto";
import type { SourceObservation } from "../schemas/researchContracts.js";
import type { SourceObservationKind } from "../schemas/researchContracts.js";
import { selectSourceReads, type SourceRead } from "./sourceSelection.js";
import type { UntouchedSource } from "./sourceSelection.js";
import { redactObject } from "./redact.js";

export interface CollectedEvidence {
  anchors: EvidenceAnchor[];
  observations: SourceObservation[];
  warnings: string[];
  /** Ordered source selection, including the observation that motivated a follow-up read. */
  readPlan: SourceRead[];
  untouched: UntouchedSource[];
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
  now: () => Date = () => new Date(),
  options: { allowedSourceKinds?: readonly SourceObservationKind[] } = {},
): Promise<CollectedEvidence> {
  const anchors: EvidenceAnchor[] = [];
  const observations: SourceObservation[] = [];
  const warnings: string[] = [];
  const untouched: UntouchedSource[] = [];
  let counter = 0;

  // Match HybridRepoExplainer's existing per-repo ceiling while leaving room
  // for bounded config/workflow references when the tree yielded fewer paths.
  const readBudget = Math.max(12, candidate.matchedPaths.length);
  const initialSelection = selectSourceReads({
    question: spec.goal,
    obligations: spec.proofRequirements.map((requirement) => requirement.description),
    exactHits: candidate.matchedPaths,
    // The candidate's matched paths define the authorized read set here; use
    // likely paths only to prioritize entries already present in that set.
    callerPaths: spec.likelyFiles.filter((path) => !path.includes("*") && candidate.matchedPaths.includes(path)),
    ecosystem: spec.stack,
    budget: { total: readBudget, perRepo: readBudget },
  });
  const pathsToRead: SourceRead[] = [...initialSelection.reads];
  let pinnedRevision: string | undefined;
  let revisionLimitation: string | undefined;
  if (pathsToRead.some((read) => !/^issues\/\d+$/.test(read.path)) && provider.searchCapabilities?.().revisionPinning && provider.resolveRevision) {
    if (!candidate.defaultBranch && provider.name !== "mock") {
      revisionLimitation = "The repository default branch is unknown; no revision was fabricated.";
    } else {
      try {
        const resolution = await provider.resolveRevision({ repo: candidate.repo, ref: candidate.defaultBranch });
        if ("sha" in resolution && /^[a-f0-9]{40}$/i.test(resolution.sha)) pinnedRevision = resolution.sha;
        else revisionLimitation = "The provider could not pin this repository revision; evidence may reflect a moving default branch.";
      } catch {
        revisionLimitation = "The provider could not pin this repository revision; evidence may reflect a moving default branch.";
      }
    }
    if (revisionLimitation) warnings.push(`revision limitation: ${candidate.repo}: ${revisionLimitation}`);
  }
  const requestedRef = pinnedRevision ?? candidate.defaultBranch;
  const scheduled = new Set(pathsToRead.map((read) => read.path));
  for (let pathIndex = 0; pathIndex < pathsToRead.length; pathIndex += 1) {
    const { path } = pathsToRead[pathIndex]!;
    const issueMatch = path.match(/^issues\/(\d+)$/);
    if (issueMatch) {
      if (!options.allowedSourceKinds?.includes("issue_proposal")) {
        untouched.push({ path, reason: "source_kind_not_allowed" });
        continue;
      }
      if (!provider.getIssue) {
        warnings.push(`source_access_unavailable: ${provider.name} cannot read issues for ${candidate.repo}; no absence claim was made.`);
        continue;
      }
      try {
        const issue = await provider.getIssue({ repo: candidate.repo, number: Number(issueMatch[1]) });
        const safeIssue = redactObject({ title: issue.title, body: issue.body });
        const excerpt = safeIssue.body;
        const lines = excerpt.split("\n");
        const observation: SourceObservation = {
          id: `obs_${candidate.owner}_${candidate.name}_${observations.length + 1}`,
          kind: "issue_proposal", repo: candidate.repo, url: issue.url, path: `issues/${issue.number}`,
          issueState: issue.state, revisionStatus: "moving_ref", excerpt,
          contentHash: createHash("sha256").update(excerpt).digest("hex"), startLine: 1,
          endLine: Math.max(1, lines.length), retrievedAt: now().toISOString(), provider: provider.name,
          retrievalMethod: "getIssue", readStatus: "complete", origin: provider.name === "mock" ? "synthetic" : "engine",
          ...(excerpt !== issue.body ? { redacted: true, redactionNotes: ["Issue content was structurally redacted before storage."] } : {}),
        };
        for (const req of spec.proofRequirements) {
          const hits = findSignalHits(lines, req.signals, 1);
          for (const hit of hits) {
            counter += 1;
            const anchor: EvidenceAnchor = {
              id: `ev_${candidate.owner}_${candidate.name}_${counter}`, provider: provider.name,
              repo: candidate.repo, path: observation.path!, startLine: hit.line, endLine: hit.line,
              matchText: hit.text.slice(0, 200), matchedSignal: hit.signal, url: issue.url,
              role: "proposed", proofLevel: "partial", evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
              supportMethod: "exact_source_quotation",
            };
            anchors.push(anchor);
            observation.anchor = anchor;
          }
        }
        observations.push(observation);
      } catch (error) {
        warnings.push(`missingProof: ${candidate.repo}:${path} issue read failed (${(error as Error).message}).`);
      }
      continue;
    }
    if (options.allowedSourceKinds && !options.allowedSourceKinds.includes("repository_file")) {
      untouched.push({ path, reason: "source_kind_not_allowed" });
      continue;
    }
    let content: string | undefined;
    let fileProvider = provider.name;
    let file: Awaited<ReturnType<EvidenceProvider["getFile"]>> | undefined;
    try {
      file = await provider.getFile({ repo: candidate.repo, path, ref: requestedRef });
      fileProvider = file.provider;
      if (file.unavailableReason || file.readStatus === "unavailable") {
        observations.push(observation(candidate, path, file, file.content, "unavailable", observations.length + 1, now, pinnedRevision));
        warnings.push(
          `missingProof: ${candidate.repo}:${path} could not be read (${file.unavailableReason ?? "provider marked the source unavailable"}).`,
        );
        continue;
      }
      if (file.path !== path) {
        observations.push(observation(candidate, path, file, file.content, "partial", observations.length + 1, now, pinnedRevision));
        warnings.push(
          `missingProof: ${candidate.repo}:${path} returned content for a different path (${file.path}); no quotation support was recorded.`,
        );
        continue;
      }
      content = file.content;
    } catch (error) {
      observations.push({
        id: `obs_${candidate.owner}_${candidate.name}_${observations.length + 1}`,
        kind: "repository_file", repo: candidate.repo, path,
        requestedRevision: requestedRef,
        ...(pinnedRevision ? { resolvedRevision: pinnedRevision } : {}),
        revisionStatus: pinnedRevision ? "immutable" : candidate.defaultBranch ? "moving_ref" : "unknown",
        retrievedAt: now().toISOString(), provider: fileProvider,
        retrievalMethod: "getFile", readStatus: "failed", origin: provider.name === "mock" ? "synthetic" : "engine",
      });
      warnings.push(
        `missingProof: ${candidate.repo}:${path} read failed (${(error as Error).message}).`,
      );
      continue;
    }
    if (content === undefined) {
      observations.push(observation(candidate, path, file, undefined, "unavailable", observations.length + 1, now));
      warnings.push(`missingProof: ${candidate.repo}:${path} returned no content.`);
      continue;
    }

    const sourceObservation = observation(candidate, path, file, content, inferredReadStatus(file), observations.length + 1, now, pinnedRevision);
    observations.push(sourceObservation);

    const remaining = readBudget - pathsToRead.length;
    if (remaining > 0) {
      const references = extractSourceReferences(path, content).filter((reference) => !scheduled.has(reference.path));
      const followed = selectSourceReads({
        references: references.map((reference) => ({
          path: reference.path,
          referencedBy: { path, observationId: sourceObservation.id, detail: reference.detail },
        })),
        budget: { total: remaining, perRepo: remaining },
      });
      for (const read of followed.reads) {
        scheduled.add(read.path);
        pathsToRead.push(read);
        if (read.referencedBy) {
          warnings.push(`source reference: ${candidate.repo}:${read.referencedBy.path} (${read.referencedBy.observationId ?? "observation unavailable"}) references ${read.path} (${read.referencedBy.detail}); scheduled within the file-read budget.`);
        }
      }
      for (const skipped of followed.untouched) {
        const source = references.find((reference) => reference.path === skipped.path);
        warnings.push(`source reference: ${candidate.repo}:${path} (${sourceObservation.id}) references ${skipped.path}${source ? ` (${source.detail})` : ""}; not read because the repository file-read budget was exhausted.`);
      }
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
      const hits = findSignalHits(lines, signals, file.startLine ?? 1).filter(
        (hit) => req.key !== "existence_proof" || candidateRepresentsSignal(candidate, hit.signal),
      );
      if (hits.length === 0) continue;

      const branch = file.resolvedRevision ?? pinnedRevision ?? file.ref ?? candidate.defaultBranch;
      // Docs are legitimate *proved* evidence for research proofs; ordinary docs
      // matches stay "partial" context and never count as implementation proof.
      const role = isDocs ? (isResearchProof ? req.key : "docs_reference") : req.key;
      // A matching excerpt establishes only that the read source states it.
      const proofLevel = "partial" as const;
      for (const hit of hits) {
        counter += 1;
        anchors.push({
          id: `ev_${candidate.owner}_${candidate.name}_${counter}`,
          provider: fileProvider,
          repo: candidate.repo,
          ref: file.resolvedRevision ?? pinnedRevision,
          path,
          startLine: hit.line,
          endLine: hit.line,
          matchText: hit.text.slice(0, 200),
          matchedSignal: hit.signal,
          url: candidate.url && branch ? `${candidate.url}/blob/${branch}/${path}#L${hit.line}` : undefined,
          role,
          proofLevel,
          evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
          supportMethod: "exact_source_quotation",
        });
        sourceObservation.anchor = anchors[anchors.length - 1];
      }
    }
    compactLargeObservation(sourceObservation, anchors, lines, file.startLine ?? 1, isManifest);
  }

  return { anchors: dedupeAnchors(anchors), observations, warnings, readPlan: pathsToRead, untouched };
}

/** Find bounded, relative configuration/workflow references; never execute them. */
function extractSourceReferences(sourcePath: string, content: string): { path: string; detail: string }[] {
  const references: { path: string; detail: string }[] = [];
  const patterns = [
    /(?:^|\s)run\s*:\s*["']?((?:\.\/|scripts\/)[^\s"']+)["']?/gim,
    /\b(?:entry|script|path)\s*:\s*["']?((?:\.\/|scripts\/)[^\s"']+)["']?/gim,
    /(?:^|\s)(?:python|python3|bash|sh|node)\s+(\.\/|scripts\/)([^\s"';&|]+)/gim,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      // The interpreter pattern captures the prefix and remainder separately.
      const raw = match[2] === undefined ? match[1]! : `${match[1]}${match[2]}`;
      const resolved = resolveRelativePath(sourcePath, raw);
      if (!resolved || /\$\{|\*/.test(resolved)) continue;
      references.push({ path: resolved, detail: match[0].trim().slice(0, 180) });
    }
  }
  return [...new Map(references.map((reference) => [reference.path, reference])).values()];
}

function resolveRelativePath(sourcePath: string, target: string): string | undefined {
  if (target.startsWith("/")) return undefined;
  // Workflow commands such as `run: ./scripts/check.sh` resolve from the repo
  // root; explicit `../` references remain relative to the referring file.
  const rootRelative = /(^|\/)\.github\/workflows\//.test(sourcePath) && target.startsWith("./");
  const segments = (target.startsWith("./") && !rootRelative ? `${sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)}${target.slice(2)}` : target.replace(/^\.\//, ""))
    .split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return undefined;
      normalized.pop();
    } else normalized.push(segment);
  }
  return normalized.join("/") || undefined;
}

function compactLargeObservation(
  source: SourceObservation,
  anchors: EvidenceAnchor[],
  lines: string[],
  firstLine: number,
  isManifest: boolean,
): void {
  const text = source.excerpt;
  if (text === undefined || text.length <= 8_192 || (isManifest && text.length <= 16_384)) return;
  const relevantAnchors = anchors.filter((anchor) => anchor.repo === source.repo && anchor.path === source.path);
  if (relevantAnchors.length === 0) {
    delete source.excerpt;
    delete source.contentHash;
    delete source.startLine;
    delete source.endLine;
    delete source.anchor;
    return;
  }
  const lineNumbers = relevantAnchors.map((anchor) => anchor.startLine ?? firstLine);
  const firstHit = Math.min(...lineNumbers);
  const lastHit = Math.max(...lineNumbers);
  const excerptStart = Math.max(firstLine, firstHit - 2);
  const excerptEnd = Math.min(firstLine + lines.length - 1, (lastHit - firstHit <= 80 ? lastHit : firstHit) + 2);
  source.excerpt = lines.slice(excerptStart - firstLine, excerptEnd - firstLine + 1).join("\n");
  source.contentHash = createHash("sha256").update(source.excerpt).digest("hex");
  source.startLine = excerptStart;
  source.endLine = excerptEnd;
  const retained = relevantAnchors.filter((anchor) => anchor.startLine !== undefined && anchor.startLine >= excerptStart && anchor.startLine <= excerptEnd);
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const anchor = anchors[index]!;
    if (anchor.repo === source.repo && anchor.path === source.path && !retained.includes(anchor)) anchors.splice(index, 1);
  }
  source.anchor = retained.at(-1);
}

function inferredReadStatus(file: Awaited<ReturnType<EvidenceProvider["getFile"]>>): SourceObservation["readStatus"] {
  if (file.readStatus) return file.readStatus;
  return file.startLine !== undefined && file.startLine > 1 || file.offsetStart !== undefined && file.offsetStart > 0 || file.truncationNotice
    ? "partial" : "complete";
}

function observation(
  candidate: CandidateRepo,
  requestedPath: string,
  file: Awaited<ReturnType<EvidenceProvider["getFile"]>> | undefined,
  content: string | undefined,
  readStatus: SourceObservation["readStatus"],
  sequence: number,
  now: () => Date,
  pinnedRevision?: string,
): SourceObservation {
  const excerpt = content;
  const requestedRevision = pinnedRevision
    ? candidate.defaultBranch ?? pinnedRevision
    : file?.ref ?? candidate.defaultBranch;
  const resolvedRevision = file?.resolvedRevision ?? pinnedRevision ?? (/^[a-f0-9]{40}$/i.test(requestedRevision ?? "") ? requestedRevision : undefined);
  return {
    id: `obs_${candidate.owner}_${candidate.name}_${sequence}`,
    kind: "repository_file", repo: candidate.repo, path: file?.path ?? requestedPath,
    ...(requestedRevision ? { requestedRevision } : {}),
    ...(resolvedRevision ? { resolvedRevision } : {}),
    revisionStatus: resolvedRevision && /^[a-f0-9]{40}$/i.test(resolvedRevision) ? "immutable" : requestedRevision ? "moving_ref" : "unknown",
    ...(excerpt === undefined ? {} : {
      excerpt,
      contentHash: createHash("sha256").update(excerpt).digest("hex"),
      startLine: file?.startLine ?? 1,
      endLine: file?.endLine ?? Math.max(1, excerpt.split("\n").length),
    }),
    retrievedAt: now().toISOString(), provider: file?.provider,
    retrievalMethod: "getFile", readStatus, origin: file?.provider === "mock" ? "synthetic" : "engine",
    ...(file?.offsetStart === undefined ? {} : { offsetStart: file.offsetStart }),
    ...(file?.offsetSemantics ? { offsetSemantics: file.offsetSemantics } : {}),
    ...(file?.truncationNotice ?? file?.unavailableReason ? { truncationNotice: file?.truncationNotice ?? file?.unavailableReason } : {}),
  };
}

interface SignalHit {
  line: number;
  text: string;
  signal: string;
}

function findSignalHits(lines: string[], signals: string[], firstLine = 1): SignalHit[] {
  const hits: SignalHit[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const normalized = signal.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const idx = lines.findIndex((line) => lineHasSignal(line, signal));
    if (idx >= 0) hits.push({ line: firstLine + idx, text: lines[idx]!.trim(), signal });
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
    const signalKey = a.matchedSignal?.toLowerCase() ?? "";
    const key = `${a.repo}:${a.path}:${a.role}:${signalKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
