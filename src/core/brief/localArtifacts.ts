import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { redactLocalArtifactText } from "../redact.js";
import type { VocabularyTerm } from "../../schemas/researchBrief.js";

type ArtifactInput = { path?: string; snippet?: string; content?: string };

/** Read only explicitly listed files and turn code fingerprints into redacted terms. */
export async function addLocalArtifactFingerprints(request: Record<string, unknown>, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const artifacts = [
    ...(Array.isArray(request.localArtifacts) ? request.localArtifacts as ArtifactInput[] : []),
    ...(Array.isArray(request.snippets) ? request.snippets.map((snippet): ArtifactInput => typeof snippet === "string" ? { snippet } : snippet as ArtifactInput) : []),
  ];
  if (!artifacts.length) return request;
  const projectRoot = await realpath(cwd);
  const listedRoots = Array.isArray(request.localArtifactRoots)
    ? (request.localArtifactRoots as unknown[]).filter((root): root is string => typeof root === "string")
    : [];
  const allowedRoots = [projectRoot];
  for (const root of listedRoots) {
    const resolvedRoot = await realpath(resolve(cwd, root));
    if (!(await stat(resolvedRoot)).isDirectory()) throw new Error(`Local artifact root is not a directory: ${root}`);
    allowedRoots.push(resolvedRoot);
  }
  const terms: VocabularyTerm[] = [];
  const questionIds = Array.isArray(request.questions) && request.questions.length
    ? (request.questions as Array<{ id?: unknown }>).map((question, index) => typeof question.id === "string" ? question.id : `q${index + 1}`)
    : ["q1"];
  for (const [index, artifact] of artifacts.entries()) {
    let text: string;
    let label: string;
    if (typeof artifact.path === "string") {
      const requestedPath = resolve(cwd, artifact.path);
      const path = await realpath(requestedPath);
      if (isCredentialPath(requestedPath) || isCredentialPath(path)) throw new Error("Credential-like local artifact paths are not allowed.");
      if (!allowedRoots.some((root) => isInside(root, path))) throw new Error("Local artifact path is outside the project root and explicitly listed localArtifactRoots.");
      if (!(await stat(path)).isFile()) throw new Error("Local artifact paths must name regular files.");
      text = await readFile(path, "utf8");
      label = `artifact-${index + 1}${extname(path)}`;
    } else {
      text = String(artifact.snippet ?? artifact.content ?? "");
      label = `snippet-${index + 1}`;
    }
    terms.push(...fingerprint(text, label, questionIds));
  }
  const current = Array.isArray(request.vocabulary) ? request.vocabulary as VocabularyTerm[] : [];
  const seen = new Set(current.map((term) => term.text.toLowerCase()));
  return { ...request, vocabulary: [...current, ...terms.filter((term) => !seen.has(term.text.toLowerCase()))] };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isCredentialPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
  const basename = parts.at(-1) ?? "";
  return /^\.env/.test(basename) || basename === ".npmrc" || basename === ".netrc" ||
    /^id_.+/.test(basename) || /\.(?:pem|key)$/.test(basename) ||
    parts.some((part) => [".ssh", ".aws", ".gnupg"].includes(part)) ||
    parts.some((part, index) => part === ".config" && parts[index + 1] === "gh");
}

function fingerprint(raw: string, label: string, questionIds: string[]): VocabularyTerm[] {
  const safe = redactSensitiveLiterals(redactLocalArtifactText(raw));
  const found: Array<{ text: string; kind: VocabularyTerm["kind"] }> = [];
  const add = (text: string | undefined, kind: VocabularyTerm["kind"]) => {
    const value = text?.trim();
    if (!value || value.length > 100 || value.includes("[REDACTED]") || /https?:|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:user|username|account.?id|tenant.?id|owner.?id|customer.?id|member.?id|person.?id|actor.?id|email)/i.test(value)) return;
    if (/(?:token|secret|password|passwd|private.?key|api.?key|client.?secret)/i.test(value)) return;
    found.push({ text: value, kind });
  };
  for (const match of safe.matchAll(/\bimport\s+(?:[^\n]*?\s+from\s+)?["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) add(match[1] ?? match[2], "import_path");
  for (const match of safe.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)) add(match[1], "symbol");
  for (const match of safe.matchAll(/(?:--[a-z][a-z0-9-]+|\b[A-Z][A-Z0-9_]{2,}\b)/g)) add(match[0], "cli_token");
  if (/\.ya?ml\b|\.json\b/.test(label)) {
    for (const match of safe.matchAll(/["']?([A-Za-z][\w.-]{1,})["']?\s*:/g)) add(match[1], "config_key");
  }
  const unique = new Map<string, typeof found[number]>();
  for (const item of found) unique.set(item.text.toLowerCase(), item);
  return [...unique.values()].map((item, index) => ({
    id: `local-${slug(label)}-${index + 1}`,
    text: item.text,
    questionIds,
    kind: item.kind,
    origin: "local_artifact_derived",
    sourceRefs: [`local-artifact:${label}`],
    egress: isRestricted(item.text, item.kind) ? "restricted" : "public",
    status: "observed",
  }));
}

function redactSensitiveLiterals(text: string): string {
  return text.replace(/(["'])([^"'\\\r\n]{32,})\1/g, (match, quote: string, value: string) => {
    // Commit ids and ordinary hex fingerprints are metadata, not query terms.
    if (/^[a-f0-9]{40}$/i.test(value)) return match;
    const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length;
    return classes >= 3 ? `${quote}[REDACTED]${quote}` : match;
  });
}

function isRestricted(value: string, kind: VocabularyTerm["kind"]): boolean {
  return kind === "symbol" || (kind === "import_path" && value.startsWith("@")) || /(?:internal|private|company|corp|proprietary|_internal)/i.test(value) || /^_[A-Za-z]/.test(value);
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact"; }
