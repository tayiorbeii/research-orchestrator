import { createHash } from "node:crypto";
import { downgradeImportedAnchor } from "./evidencePolicy.js";
import type { EvidenceAnchor } from "../schemas/evidenceAnchor.js";
import type { ResearchRun } from "../schemas/researchRun.js";
import type { SourceObservation } from "../schemas/researchContracts.js";

/**
 * Secret redaction from docs/09_security_privacy.md.
 * Env var NAMES are allowed; VALUES are redacted.
 */

const SECRET_KEY_FRAGMENT =
  "(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|API[_-]?KEY|AUTH[_-]?SECRET|GITHUB[_-]?TOKEN|GH[_-]?TOKEN|OCTOCODE[_-]?TOKEN|RESEND[_-]?KEY|JWT[_-]?PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)";

const KEY_NAME = `[A-Za-z0-9_.-]*${SECRET_KEY_FRAGMENT}[A-Za-z0-9_.-]*`;

const REDACTED = "[REDACTED]";

/**
 * A value that only references a secret (`${{ secrets.X }}`, `${VAR}`, `$VAR`) is
 * not itself a secret, and workflow evidence depends on keeping it verbatim.
 */
const SECRET_REFERENCE = /^["']?(?:\$\{\{[^}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)["']?$/;

const keepReference = (match: string, key: string, sep: string, value: string): string =>
  SECRET_REFERENCE.test(value.trim()) ? match : `${key}${sep}${REDACTED}`;

interface RedactionRule {
  pattern: RegExp;
  replacement: string | ((...args: string[]) => string);
}

const RULES: RedactionRule[] = [
  // KEY=value (env files, shell exports)
  {
    pattern: new RegExp(`\\b(${KEY_NAME})(\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s#'"]+)`, "gi"),
    replacement: keepReference,
  },
  // "key": "value" (JSON)
  {
    pattern: new RegExp(`("${KEY_NAME}")(\\s*:\\s*)"[^"]*"`, "gi"),
    replacement: (_m, key, sep) => `${key}${sep}"${REDACTED}"`,
  },
  // key: value (YAML-ish, single line)
  {
    pattern: new RegExp(`^(\\s*${KEY_NAME})(\\s*:\\s+)(\\S.*)$`, "gim"),
    replacement: keepReference,
  },
  // Well-known token literal shapes.
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bgho_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bre_[A-Za-z0-9]{16,}\b/g, replacement: REDACTED },
  { pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, replacement: REDACTED },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: REDACTED },
  // JWTs
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: REDACTED,
  },
  // Authorization headers
  {
    pattern: /\b(Authorization\s*[:=]\s*(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: (_m, prefix) => `${prefix}${REDACTED}`,
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out =
      typeof rule.replacement === "string"
        ? out.replace(rule.pattern, rule.replacement)
        : out.replace(rule.pattern, rule.replacement as (...args: string[]) => string);
  }
  return out;
}

/** Redaction policy for local snippets before deriving outbound search terms. */
export function redactLocalArtifactText(text: string): string {
  return redactSecrets(text)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\bhttps?:\/\/[^/@\s]+@[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "/[USER]");
}

/**
 * Deep-redact every string value in a JSON-serializable object.
 * Redaction is structural: regexes run on each decoded string, never on serialized
 * JSON text, where escaped quotes in source excerpts would be corrupted.
 */
export function redactObject<T>(value: T): T {
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") return redactSecrets(current);
    if (Array.isArray(current)) return current.map(walk);
    if (current === null || typeof current !== "object") return current;
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, walk(child)]),
    );
  };
  return walk(JSON.parse(JSON.stringify(value))) as T;
}

/** Redact rendered artifact text; JSON artifacts are redacted structurally. */
export function redactArtifactContent(file: string, content: string): string {
  if (!file.endsWith(".json")) return redactSecrets(content);
  return `${JSON.stringify(redactObject(JSON.parse(content)), null, 2)}${content.endsWith("\n") ? "\n" : ""}`;
}

/** Redact a research run and record when persisted excerpts no longer match provider text. */
export function redactResearchRun<T extends ResearchRun>(run: T): T {
  const persisted = redactObject(run);
  const originalObservations = run.observations ?? [];
  const persistedObservations = persisted.observations ?? [];
  for (let index = 0; index < originalObservations.length; index += 1) {
    const original = originalObservations[index]!;
    const stored = persistedObservations[index]!;
    if (original.excerpt === undefined || original.excerpt === stored.excerpt) continue;
    stored.redacted = true;
    stored.redactionNotes = [...new Set([...(stored.redactionNotes ?? []), "Source excerpt was redacted before persistence."])];
    if (stored.excerpt !== undefined) {
      // This hash identifies the stored, redacted excerpt, not the original provider text.
      stored.contentHash = createHash("sha256").update(stored.excerpt).digest("hex");
    }
  }
  return downgradeAnchorsForRedactedObservations(persisted, persistedObservations) as T;
}

export function downgradeAnchorsForRedactedObservations<T>(value: T, observations: readonly SourceObservation[]): T {
  const redacted = observations.filter((observation) => observation.redacted && observation.excerpt !== undefined);
  if (redacted.length === 0) return value;
  return walk(value) as T;

  function walk(current: unknown): unknown {
    if (Array.isArray(current)) return current.map(walk);
    if (current === null || typeof current !== "object") return current;
    const record = current as Record<string, unknown>;
    if (isEvidenceAnchor(record)) {
      const anchor = record as unknown as EvidenceAnchor;
      return redacted.some((observation) => anchorMatchesObservation(anchor, observation))
        ? downgradeImportedAnchor(anchor)
        : current;
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, walk(child)]));
  }
}

function isEvidenceAnchor(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && typeof value.path === "string" &&
    typeof value.role === "string" && typeof value.proofLevel === "string";
}

function anchorMatchesObservation(anchor: EvidenceAnchor, observation: SourceObservation): boolean {
  return anchor.repo === observation.repo && anchor.path === observation.path &&
    anchor.startLine !== undefined && anchor.endLine !== undefined &&
    observation.startLine !== undefined && observation.endLine !== undefined &&
    anchor.startLine >= observation.startLine && anchor.endLine <= observation.endLine &&
    anchor.matchText !== undefined && (anchor.matchText.includes(REDACTED) || redactSecrets(anchor.matchText) !== anchor.matchText) &&
    (observation.resolvedRevision === undefined || anchor.ref === observation.resolvedRevision);
}

/** True when a piece of text still looks like it contains a live secret. */
export function looksLikeSecret(text: string): boolean {
  return /\bghp_[A-Za-z0-9]{20,}|\bre_[A-Za-z0-9]{16,}|\bsk_(?:live|test)_[A-Za-z0-9]{10,}/.test(
    text,
  );
}
