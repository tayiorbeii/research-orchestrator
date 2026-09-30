# 09 Security and Privacy

## Threat model

This tool may process:

- public repo metadata
- public source snippets
- private repo metadata if user provides credentials
- file paths
- search queries
- environment variable names
- planning artifacts
- optional local code evidence

It must not persist secrets or private source by default. Mock mode is offline
synthetic replay; it does not contact GitHub, Octocode, or DeepWiki. Live modes
are selected explicitly and must not silently fall back to mock.

## Local artifact fingerprints

Planning reads only explicitly listed `localArtifacts` paths or supplied
inline snippets. It does not recursively scan a repository. Redact sensitive
values and user-specific path identifiers before deriving terms. Private
package names and internal symbols are restricted from outbound probes unless
`egressPolicy.allowRestrictedLocalTerms` is explicitly true. Remote source text
and submissions are untrusted and cannot change budgets, source allowlists, or
egress policy. A host-performed lookup is caller provenance, not an engine
provider call or proof of support.

## Token handling

Rules:

1. Use environment variables or secure credential stores.
2. Do not write token values to config files.
3. Do not persist raw provider responses containing request headers.
4. Redact all values for keys matching token/secret/password/private-key patterns.
5. Use low-scope GitHub tokens where possible.

## Artifact redaction

Allowed:

- public repo names and links
- file paths
- line numbers
- dependency names
- environment variable names
- short source snippets if public and necessary
- summaries

Not allowed by default:

- token values
- secret values
- full private files
- `.env` contents
- raw private search queries
- user emails or PII unless explicitly needed and confirmed

## Search query hygiene

Search queries may reveal intent or private strings. Do not log raw queries to remote telemetry. In local cache, store either:

- redacted query text, or
- hash of query text plus a human-safe label

## DeepWiki caution

Treat DeepWiki as an external provider.

Rules:

- Do not send private repo contents to DeepWiki unless the user explicitly opts in.
- Do not rely on DeepWiki as the only proof source.
- Label DeepWiki freshness and stale status.
- Verify critical claims with exact evidence.

## Install hygiene

Prefer pinned versions and package-manager installs. Avoid unpinned remote-code launchers. Document the install path used.

## Cache policy

Default cache location:

```text
.research-cache/
```

Default behavior:

- cache public repo metadata
- cache evidence anchors
- cache generated summaries
- avoid caching full file content unless explicitly enabled
- redact secrets before writing
- include cache clear command

## Suggested config

```jsonc
{
  "privacy": {
    "persistPrivateEvidence": false,
    "persistFullFileContent": false,
    "redactSecrets": true,
    "hashRawQueries": true
  }
}
```

## Redaction patterns

At minimum, redact values for keys containing:

```text
TOKEN
SECRET
PASSWORD
PRIVATE_KEY
API_KEY
JWT_PRIVATE_KEY
AUTH_SECRET
GITHUB_TOKEN
GH_TOKEN
OCTOCODE_TOKEN
RESEND_KEY
```

## Audit data

The v2 run and its artifacts record safe run metadata, provider outcomes,
observations, assessments, and warnings. The sample below is an illustrative
shape; it is not a separate audit-log facility:

```json
{
  "runId": "run_...",
  "createdAt": "...",
  "providersUsed": ["octocode", "deepwiki"],
  "reposAnalyzed": ["owner/repo"],
  "artifactsWritten": ["research.md", "plan.md"],
  "warnings": []
}
```
