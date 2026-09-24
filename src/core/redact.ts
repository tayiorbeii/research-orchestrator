/**
 * Secret redaction from docs/09_security_privacy.md.
 * Env var NAMES are allowed; VALUES are redacted.
 */

const SECRET_KEY_FRAGMENT =
  "(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|API[_-]?KEY|AUTH[_-]?SECRET|GITHUB[_-]?TOKEN|GH[_-]?TOKEN|OCTOCODE[_-]?TOKEN|RESEND[_-]?KEY|JWT[_-]?PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)";

const KEY_NAME = `[A-Za-z0-9_.-]*${SECRET_KEY_FRAGMENT}[A-Za-z0-9_.-]*`;

const REDACTED = "[REDACTED]";

interface RedactionRule {
  pattern: RegExp;
  replacement: string | ((...args: string[]) => string);
}

const RULES: RedactionRule[] = [
  // KEY=value (env files, shell exports)
  {
    pattern: new RegExp(`\\b(${KEY_NAME})(\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s#'"]+)`, "gi"),
    replacement: (_m, key, eq) => `${key}${eq}${REDACTED}`,
  },
  // "key": "value" (JSON)
  {
    pattern: new RegExp(`("${KEY_NAME}")(\\s*:\\s*)"[^"]*"`, "gi"),
    replacement: (_m, key, sep) => `${key}${sep}"${REDACTED}"`,
  },
  // key: value (YAML-ish, single line)
  {
    pattern: new RegExp(`^(\\s*${KEY_NAME})(\\s*:\\s+)(\\S.*)$`, "gim"),
    replacement: (_m, key, sep) => `${key}${sep}${REDACTED}`,
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

/** Deep-redact every string value in a JSON-serializable object. */
export function redactObject<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value, null, 2))) as T;
}

/** True when a piece of text still looks like it contains a live secret. */
export function looksLikeSecret(text: string): boolean {
  return /\bghp_[A-Za-z0-9]{20,}|\bre_[A-Za-z0-9]{16,}|\bsk_(?:live|test)_[A-Za-z0-9]{10,}/.test(
    text,
  );
}
