const NON_ANCHOR_TERMS = new Set([
  "find", "proven", "prove", "repository", "repositories", "implementations", "implementation", "examples", "example",
  "real-world", "real", "world", "research", "look", "search", "discover", "build", "create", "develop", "implement",
  "compare", "evaluate", "investigate", "analyze", "analysis", "guide", "task", "goal", "request", "for", "with", "and",
  "the", "a", "an", "of", "to", "in", "on", "by", "from", "via", "using", "use", "that", "which", "across",
  "workspace", "workspaces", "navigation", "layout", "layouts", "session", "sessions", "pane", "panes", "window", "windows",
  "tab", "tabs", "split", "splits", "terminal", "keyboard", "keymap", "keymaps", "theme", "themes", "font", "fonts",
  "configuration", "config", "integration", "integrations", "provider", "providers", "hook", "hooks", "event", "events",
  "command", "commands", "mode", "modes", "api", "sdk", "auth", "authentication", "authorization", "middleware", "route",
  "routes", "router", "schema", "query", "queries", "mutation", "cache", "queue", "worker", "cron", "schedule", "stream",
  "streaming", "websocket", "upload", "storage", "render", "rendering", "state", "store", "context", "service", "services",
  "client", "server", "database", "deployment", "test", "tests", "benchmark", "benchmarks", "source", "code", "project", "tool",
  "strict", "lint", "gradual", "baseline", "baselines", "forbidden", "vendor", "imports", "custom", "rules", "debt", "increase", "increasing", "decrease", "decreasing", "prevent", "avoid",
  "sensitive", "logging", "changed", "changed-line", "coverage", "parity", "checks", "ci", "pre-review",
]);

const MODIFIERS_BY_ANCHOR: Record<string, string[]> = {
  ruff: ["strict", "lint"],
  mypy: ["gradual", "baselines"],
  pyright: ["gradual", "baselines"],
  "pre-commit": ["parity"],
};

/** Generic goal language may refine a search, but it cannot identify one by itself. */
export function isDistinctiveAnchor(value: string): boolean {
  const term = value.trim();
  if (!term) return false;
  return hasStructuralSignal(term) || !NON_ANCHOR_TERMS.has(term.toLowerCase());
}

function hasStructuralSignal(term: string): boolean {
  return /^--[\w-]+$/.test(term) || /^@[\w.-]+\/[\w./-]+$/.test(term) ||
    /[/.]|::/.test(term) || /[A-Z]/.test(term.slice(1)) || /[0-9]/.test(term);
}

/** Caller supplied domain phrases need a separate concrete anchor. */
export function isDistinctiveVocabularyTerm(term: { kind: string; text: string }): boolean {
  if (term.kind === "domain_phrase") return false;
  if (["package", "symbol", "import_path", "config_key", "cli_token", "repository_identity"].includes(term.kind)) return true;
  return hasStructuralSignal(term.text.trim());
}

/** Keep useful modifiers next to their known tool anchor; discard loose prose. */
export function anchoredProbeTerms(terms: string[]): string[] {
  const anchors = terms.filter((term) => {
    const parts = term.split("/").filter(Boolean);
    if (!term.startsWith("@") && parts.length > 1 && parts.some((part) => terms.some((other) => other.toLowerCase() === part.toLowerCase()))) return false;
    return isDistinctiveAnchor(term);
  });
  return anchors.map((anchor) => {
    const modifiers = MODIFIERS_BY_ANCHOR[anchor.toLowerCase()] ?? [];
    return [anchor, ...modifiers.filter((modifier) => terms.some((term) => term.toLowerCase() === modifier))]
      .filter((term, index, values) => values.findIndex((value) => value.toLowerCase() === term.toLowerCase()) === index)
      .join(" ");
  });
}

export function hasDistinctiveAnchor(text: string): boolean {
  return text.split(/\s+/).some((term) => hasStructuralSignal(term) || isDistinctiveAnchor(term));
}

export function dedupeProbeTokens(text: string): string {
  const seen = new Set<string>();
  return text.split(/\s+/).filter(Boolean).filter((token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(" ");
}
