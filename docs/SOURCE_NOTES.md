# Source Notes

These notes summarize the external research used to create the plan. They are not required reading for implementation, but they explain the reasoning behind key design decisions.

## Octocode capabilities

Octocode is positioned as an evidence-first code research platform with local workspace and external GitHub/npm capabilities. It exposes GitHub code/repo/file/tree/history/clone tools, local search/file/tree/binary tools, npm search, LSP semantic navigation, and OQL.

Relevant source paths:

- `README.md`
- `AGENTS.md`
- `docs/mcp/tools/GITHUB_TOOLS.md`
- `docs/mcp/tools/LOCAL_TOOLS.md`
- `docs/mcp/tools/TOOL_BEHAVIOR.md`
- `docs/AGENT_RESEARCH_WORKFLOWS.md`
- `packages/octocode-engine/ARCHITECTURE.md`
- `docs/mcp/CONFIGURATION.md`

Repo:

```text
https://github.com/bgauryy/octocode
```

## Octocode architecture notes

Octocode's architecture separates thin interface packages from shared execution logic and native engine primitives. This supports the recommendation to build an orchestration layer instead of replacing the evidence engine.

## Octocode performance notes

The repo benchmark output showed raw native structural search was fast, while agent-safe/result-shaped and CLI paths have overhead from validation, sanitization, pagination, result shaping, and process startup. This supports the recommendation to use long-lived MCP/direct adapter flows instead of repeated CLI process loops.

## DeepWiki notes

DeepWiki appears useful as a repo-explanation layer when a repo is indexed and fresh. The plan treats it as optional enrichment and verifies critical claims with exact source evidence.

Public site:

```text
https://deepwiki.com/
```

Example repo wiki pattern:

```text
https://deepwiki.com/{owner}/{repo}
```

## GitHub search notes

GitHub search has practical limitations around result caps, incomplete results, default-branch code search, file-size searchability, rate limits, query length, and query operators. This supports sharding probes, caching results, and not treating search snippets as proof.

Docs:

```text
https://docs.github.com/en/rest/search/search
https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax
```

## Example feature research notes

Earlier exploratory research found:

- a small guide/reference repo for Convex + magic link auth
- a more production-shaped public app using `@convex-dev/auth`, Convex, Next.js, Resend provider config, login page sign-in, and route protection

These examples informed the magic-link proof checklist and scoring rubric. The kit intentionally keeps examples as mock/sample data rather than depending on live network availability.
