import type { CandidateRepo, EvidenceAnchor, FeatureSpec, ProofRequirement } from "../schemas/index.js";
import type { EvidenceProvider } from "../adapters/EvidenceProvider.js";
import { EVIDENCE_POLICY_VERSION } from "./evidencePolicy.js";
import { createHash } from "node:crypto";
import type { SourceObservation } from "../schemas/researchContracts.js";
import type { SourceObservationKind } from "../schemas/researchContracts.js";
import { selectSourceReads, type SourceRead } from "./sourceSelection.js";
import type { UntouchedSource } from "./sourceSelection.js";
import { redactObject } from "./redact.js";
import { QUOTATION_SIGNAL_WINDOW_LINES } from "./assessment/types.js";

export interface CollectedEvidence {
  anchors: EvidenceAnchor[];
  observations: SourceObservation[];
  warnings: string[];
  /** Ordered source selection, including the observation that motivated a follow-up read. */
  readPlan: SourceRead[];
  untouched: UntouchedSource[];
}

/**
 * What a read is looking for. This is all evidence collection needs to know
 * about a request: the facts to find (as signal lists), which files the caller
 * expects to matter, and ecosystem hints for ranking configuration files.
 */
export interface ProofTargets {
  goal: string;
  goalKind: "application" | "research";
  requirements: readonly ProofRequirement[];
  /** Paths the caller expects; they only prioritize paths already matched. */
  likelyFiles: readonly string[];
  ecosystem: readonly string[];
  /** Extra docs-only signals for application goals. */
  requiredConcepts: readonly string[];
}

export function proofTargetsFromFeatureSpec(spec: FeatureSpec): ProofTargets {
  return { goal: spec.goal, goalKind: spec.goalKind, requirements: spec.proofRequirements, likelyFiles: spec.likelyFiles, ecosystem: spec.stack, requiredConcepts: spec.requiredConcepts };
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
export interface CollectEvidenceOptions {
  allowedSourceKinds?: readonly SourceObservationKind[];
  /** Read exactly these paths instead of the candidate's matched paths (a follow-up pass). */
  paths?: readonly string[];
  /** Ids continue after observations/anchors already recorded for this repository. */
  observationOffset?: number;
  anchorOffset?: number;
}

export async function collectEvidence(
  provider: EvidenceProvider,
  spec: FeatureSpec | ProofTargets,
  candidate: CandidateRepo,
  now: () => Date = () => new Date(),
  options: CollectEvidenceOptions = {},
): Promise<CollectedEvidence> {
  const targets = "proofRequirements" in spec ? proofTargetsFromFeatureSpec(spec) : spec;
  const anchors: EvidenceAnchor[] = [];
  const observations: SourceObservation[] = [];
  const warnings: string[] = [];
  const untouched: UntouchedSource[] = [];
  let counter = options.anchorOffset ?? 0;
  const nextSequence = () => (options.observationOffset ?? 0) + observations.length + 1;

  // Match HybridRepoExplainer's existing per-repo ceiling while leaving room
  // for bounded config/workflow references when the tree yielded fewer paths.
  // An explicit follow-up path set is read as-is, with no reference following.
  const authorized = options.paths ?? candidate.matchedPaths;
  const readBudget = options.paths ? options.paths.length : Math.max(12, candidate.matchedPaths.length);
  const initialSelection = selectSourceReads({
    question: targets.goal,
    obligations: targets.requirements.map((requirement) => requirement.description),
    exactHits: authorized,
    // The candidate's matched paths define the authorized read set here; use
    // likely paths only to prioritize entries already present in that set.
    callerPaths: targets.likelyFiles.filter((path) => !path.includes("*") && authorized.includes(path)),
    ecosystem: targets.ecosystem,
    budget: { total: readBudget, perRepo: readBudget },
  });
  const pathsToRead: SourceRead[] = [...initialSelection.reads];
  let pinnedRevision: string | undefined;
  let revisionLimitation: string | undefined;
  if (pathsToRead.some((read) => !/^issues\/\d+$/.test(read.path)) && provider.searchCapabilities?.().revisionPinning && provider.resolveRevision) {
    // The resolver decides what it can pin: a missing default branch (search
    // metadata rarely carries one) is its problem to look up or to report.
    try {
      const resolution = await provider.resolveRevision({ repo: candidate.repo, ref: candidate.defaultBranch });
      if ("sha" in resolution && /^[a-f0-9]{40}$/i.test(resolution.sha)) pinnedRevision = resolution.sha;
      else revisionLimitation = "unavailableReason" in resolution && resolution.unavailableReason
        ? `The provider could not pin this repository revision (${resolution.unavailableReason}); evidence may reflect a moving default branch.`
        : "The provider could not pin this repository revision; evidence may reflect a moving default branch.";
    } catch {
      revisionLimitation = "The provider could not pin this repository revision; evidence may reflect a moving default branch.";
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
          id: `obs_${candidate.owner}_${candidate.name}_${nextSequence()}`,
          kind: "issue_proposal", repo: candidate.repo, url: issue.url, path: `issues/${issue.number}`,
          issueState: issue.state, revisionStatus: "moving_ref", excerpt,
          contentHash: createHash("sha256").update(excerpt).digest("hex"), startLine: 1,
          endLine: Math.max(1, lines.length), retrievedAt: now().toISOString(), provider: provider.name,
          retrievalMethod: "getIssue", readStatus: "complete", origin: provider.name === "mock" ? "synthetic" : "engine",
          ...(excerpt !== issue.body ? { redacted: true, redactionNotes: ["Issue content was structurally redacted before storage."] } : {}),
        };
        for (const req of targets.requirements) {
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
        observations.push(observation(candidate, path, file, file.content, "unavailable", nextSequence(), now, pinnedRevision));
        warnings.push(
          `missingProof: ${candidate.repo}:${path} could not be read (${file.unavailableReason ?? "provider marked the source unavailable"}).`,
        );
        continue;
      }
      if (file.path !== path) {
        observations.push(observation(candidate, path, file, file.content, "partial", nextSequence(), now, pinnedRevision));
        warnings.push(
          `missingProof: ${candidate.repo}:${path} returned content for a different path (${file.path}); no quotation support was recorded.`,
        );
        continue;
      }
      content = file.content;
    } catch (error) {
      observations.push({
        id: `obs_${candidate.owner}_${candidate.name}_${nextSequence()}`,
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
      observations.push(observation(candidate, path, file, undefined, "unavailable", nextSequence(), now));
      warnings.push(`missingProof: ${candidate.repo}:${path} returned no content.`);
      continue;
    }

    const sourceObservation = observation(candidate, path, file, content, inferredReadStatus(file), nextSequence(), now, pinnedRevision);
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

    for (const req of targets.requirements) {
      const isResearchProof = targets.goalKind === "research" && req.key !== "dependency_proof";
      // Dependency proof must come from a dependency manifest, not incidental imports.
      if (req.key === "dependency_proof" && !isManifest) continue;
      // Non-dependency application proofs must come from source, not manifests.
      if (req.key !== "dependency_proof" && !isResearchProof && isManifest) continue;
      // A manifest may establish project existence, but package metadata is not
      // authoritative evidence of behavior.
      if (req.key === "behavior_proof" && isManifest) continue;

      const signals = isDocs && !isResearchProof ? [...req.signals, ...targets.requiredConcepts] : req.signals;
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
    // One read can establish facts for several questions. Each hit cluster stays
    // its own observation (original line numbers, own hash); the densest leads.
    const windows = compactLargeObservation(sourceObservation, anchors, lines, file.startLine ?? 1, isManifest);
    Object.assign(sourceObservation, windows[0]);
    for (const window of windows.slice(1)) observations.push({ ...window, id: `obs_${candidate.owner}_${candidate.name}_${nextSequence()}` });
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

/** Whole files up to this size are kept; larger ones are cut to their hit clusters. */
const WHOLE_FILE_EXCERPT_BYTES = 8_192;
const WHOLE_MANIFEST_EXCERPT_BYTES = 16_384;
/** A cluster stops growing here so a dense file cannot return itself whole. */
const MAX_CLUSTER_LINES = 80;
/** Most windows one file may keep; the densest clusters win the slots. */
const MAX_WINDOWS_PER_FILE = 6;

/**
 * Cut a large file down to the lines an assessor can use. Every hit gets a
 * window as wide as the quotation policy's co-occurrence window and touching
 * windows merge into clusters. Each cluster becomes its own observation, so
 * questions that share a file do not starve each other; the cluster stating
 * the most distinct signals comes first (it keeps the original observation's
 * slot), the rest follow in file order. Windows are never joined: a window
 * is an exact slice with its own line range and hash, so unrelated regions
 * cannot combine into code the file does not contain.
 */
function compactLargeObservation(
  source: SourceObservation,
  anchors: EvidenceAnchor[],
  lines: string[],
  firstLine: number,
  isManifest: boolean,
): SourceObservation[] {
  const text = source.excerpt;
  if (text === undefined || text.length <= WHOLE_FILE_EXCERPT_BYTES || (isManifest && text.length <= WHOLE_MANIFEST_EXCERPT_BYTES)) return [source];
  const relevantAnchors = anchors.filter((anchor) => anchor.repo === source.repo && anchor.path === source.path);
  if (relevantAnchors.length === 0) {
    delete source.excerpt;
    delete source.contentHash;
    delete source.startLine;
    delete source.endLine;
    delete source.anchor;
    return [source];
  }
  const lastLine = firstLine + lines.length - 1;
  const window = QUOTATION_SIGNAL_WINDOW_LINES;
  const hits = relevantAnchors
    .map((anchor) => ({ line: anchor.startLine ?? firstLine, signal: anchor.matchedSignal?.toLowerCase() ?? "" }))
    .sort((left, right) => left.line - right.line);
  const clusters: Array<{ start: number; end: number; signals: Set<string>; hits: number }> = [];
  for (const hit of hits) {
    const start = Math.max(firstLine, hit.line - window);
    const end = Math.min(lastLine, hit.line + window);
    const last = clusters.at(-1);
    if (last && start <= last.end + 1 && end - last.start <= MAX_CLUSTER_LINES) {
      last.end = Math.max(last.end, end);
      last.signals.add(hit.signal);
      last.hits += 1;
    } else clusters.push({ start, end, signals: new Set([hit.signal]), hits: 1 });
  }
  const ranked = [...clusters].sort((left, right) =>
    right.signals.size - left.signals.size || right.hits - left.hits || left.start - right.start).slice(0, MAX_WINDOWS_PER_FILE);
  const kept = [ranked[0]!, ...ranked.slice(1).sort((left, right) => left.start - right.start)];
  const retainedAnchors = new Set<EvidenceAnchor>();
  const windows = kept.map(({ start, end }) => {
    const excerpt = lines.slice(start - firstLine, end - firstLine + 1).join("\n");
    const inside = relevantAnchors.filter((anchor) => anchor.startLine !== undefined && anchor.startLine >= start && anchor.startLine <= end);
    for (const anchor of inside) retainedAnchors.add(anchor);
    return {
      ...source, excerpt, startLine: start, endLine: end,
      contentHash: createHash("sha256").update(excerpt).digest("hex"),
      anchor: inside.at(-1),
    };
  });
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const anchor = anchors[index]!;
    if (anchor.repo === source.repo && anchor.path === source.path && !retainedAnchors.has(anchor)) anchors.splice(index, 1);
  }
  return windows;
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

/** Hits per signal kept for excerpt windowing; anchors are deduped to one per signal later. */
const MAX_HITS_PER_SIGNAL = 25;

function findSignalHits(lines: string[], signals: string[], firstLine = 1): SignalHit[] {
  const hits: SignalHit[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const normalized = signal.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    let found = 0;
    for (let index = 0; index < lines.length && found < MAX_HITS_PER_SIGNAL; index += 1) {
      if (!lineHasSignal(lines[index]!, signal)) continue;
      hits.push({ line: firstLine + index, text: lines[index]!.trim(), signal });
      found += 1;
    }
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
