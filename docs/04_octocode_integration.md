# 04 Octocode Integration

## Role of Octocode

Octocode is the evidence engine. Research Orchestrator should use it for:

- GitHub code search
- GitHub repository discovery
- GitHub file reads
- GitHub repo structure
- PR/history research
- npm package lookup
- clone/materialize to local
- local text/regex search
- local AST/structural search
- LSP semantic proof
- minified/symbolic content reads

Research Orchestrator should not duplicate these primitives initially.

## Recommended modes

### Fast discovery profile

Use this profile for broad searches.

```jsonc
{
  "ENABLE_LOCAL": "true",
  "ENABLE_CLONE": "false",
  "OCTOCODE_OUTPUT_FORMAT": "json",
  "OCTOCODE_OUTPUT_DEFAULT_CHAR_LENGTH": "12000"
}
```

### Deep proof profile

Use this profile only after candidate scoring.

```jsonc
{
  "ENABLE_LOCAL": "true",
  "ENABLE_CLONE": "true",
  "OCTOCODE_OUTPUT_FORMAT": "json",
  "OCTOCODE_OUTPUT_DEFAULT_CHAR_LENGTH": "20000"
}
```

## Tool sequence for feature examples

```text
ghSearchCode / ghSearchRepos
  -> ghViewRepoStructure
  -> ghGetFileContent
  -> ghCloneRepo only after scoring
  -> localSearchCode / structural search / LSP only when needed
```

## Query strategy

Use up to five independent queries per Octocode bulk call when available.

Batch independent probes:

```text
"convexAuth" "Resend("
"signIn('resend'" "@convex-dev/auth/react"
"convexAuthNextjsMiddleware"
"ConvexAuthNextjsProvider"
"AUTH_RESEND_KEY"
```

Serialize dependent steps:

```text
candidate repo found
  -> read package.json
  -> read matched file
  -> browse repo tree if path uncertain
  -> read surrounding files
```

## Evidence discipline

Search snippets are not proof. Promote evidence only after exact file content or precise line anchors are read.

## Escalation rules

Use `ghSearchCode` when:

- searching public GitHub for patterns
- matching exact strings
- looking for likely implementation files

Use `ghSearchRepos` when:

- looking for projects by name/topic/readme
- you need repo metadata first

Use `ghGetFileContent` when:

- reading a specific file or line range
- reading a small exact slice
- fetching symbols/skeleton first

Use `ghViewRepoStructure` when:

- file paths are uncertain
- a repo needs orientation before reading

Use `ghCloneRepo` when:

- many reads are needed
- files are too large for remote content APIs
- AST/LSP/local proof is required
- repeated local searches are cheaper than remote calls

Use `localSearchCode` after clone when:

- searching many files
- using PCRE or structural queries
- finding negative evidence
- enumerating matches

Use LSP only when:

- the repo is already shortlisted
- a real line anchor exists
- definition/reference/call hierarchy proof is needed

## Adapter responsibilities

`OctocodeEvidenceProvider` should return normalized objects, not raw Octocode output.

```ts
type NormalizedSearchResult = {
  repo: string;
  path: string;
  branch?: string;
  line?: number;
  probeId: string;
  snippet?: string;
  raw?: unknown;
};
```

## Error handling

Return structured warnings:

```json
{
  "kind": "provider_warning",
  "provider": "octocode",
  "message": "Search returned no results; verify spelling, branch, auth, filters, pagination, or rate limits.",
  "recoverable": true
}
```

## Performance guidance

Prefer:

- concise/discovery results first
- exact slices over full files
- symbols/skeletons before deep reads
- clone only after scoring
- cached local paths when available

Avoid:

- fullContent on large files
- repeated CLI process startup loops
- clone for low-scoring repos
- unbounded PR/history reads
- reading all comments/diffs before PR selection
