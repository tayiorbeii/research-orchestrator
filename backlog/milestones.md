# Milestones

## M1: Mock vertical slice

- Bootstrap TypeScript project.
- Implement schemas.
- Implement feature normalization.
- Implement probe generation.
- Implement mock evidence provider.
- Implement candidate scoring.
- Implement artifact writer.
- Add CLI mock command.

## M2: Real provider boundaries

- Implement Octocode provider stub.
- Implement GitHub provider stub.
- Implement DeepWiki provider stub.
- Add structured provider errors.
- Add config loading.

## M3: Octocode-backed discovery

- Call Octocode for code search.
- Normalize search results.
- Read exact files.
- Preserve evidence anchors.
- Handle pagination and incomplete results.

## M4: DeepWiki enrichment

- Check DeepWiki availability.
- Extract freshness metadata.
- Capture available repo/wiki metadata.
- Verify critical claims with Octocode.

## M5: MCP exposure

- Add MCP server.
- Expose four tools.
- Support mock mode.
- Support writing artifacts to disk.

## M6: Eval harness

- Add benchmark tasks.
- Collect metrics.
- Add golden mock snapshots.
- Track false positives and completeness.
