import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OctocodeEvidenceProvider,
  normalizeSearchResponse,
  splitQueryTerms,
  type OctocodeToolCaller,
} from "../src/adapters/OctocodeEvidenceProvider.js";
import {
  OCTOCODE_BRIDGE_ENV,
  loadOctocodeToolCallerFromEnv,
  resolveOctocodeProvider,
  setOctocodeToolCaller,
} from "../src/adapters/bridge.js";
import { MOCK_FILE_CONTENTS } from "../src/adapters/MockEvidenceProvider.js";
import { runResearch } from "../src/core/pipeline.js";
import { findImplementations, resolveProvider } from "../src/mcp/tools/findImplementations.js";
import type { SearchProbe } from "../src/schemas/index.js";

const GOAL = "Build a Next.js + Convex app with email magic links via Resend.";
const REPO = "headcodecms/headcodecms";
const REPO_FILES = MOCK_FILE_CONTENTS[REPO]!;

interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Canned Octocode-shaped responses backed by the mock fixture contents. */
function fakeOctocodeCaller(calls: RecordedCall[] = []): OctocodeToolCaller {
  return async (toolName, rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    calls.push({ tool: toolName, args });
    switch (toolName) {
      case "ghSearchCode": {
        const queries = args.queries as Array<{ id?: string }>;
        const [owner, repo] = REPO.split("/") as [string, string];
        const paths = Object.keys(REPO_FILES);
        return {
          results: queries.map((q) => ({
            id: q.id,
            data: {
              files: paths.map((path) => ({
                owner,
                repo,
                path,
                matches: [{ value: `snippet for ${path}` }],
              })),
            },
          })),
        };
      }
      case "ghGetFileContent": {
        const q = (args.queries as Array<{ owner: string; repo: string; path: string }>)[0]!;
        const content = MOCK_FILE_CONTENTS[`${q.owner}/${q.repo}`]?.[q.path];
        return {
          results: [
            {
              id: `${q.owner}/${q.repo}`,
              data: {
                files: [content === undefined ? { path: q.path, error: "not found" } : { path: q.path, content }],
              },
            },
          ],
        };
      }
      case "ghViewRepoStructure":
        return {
          results: [
            {
              id: REPO,
              data: { structure: [{ dir: ".", files: Object.keys(REPO_FILES), folders: [] }] },
            },
          ],
        };
      case "ghSearchRepos": {
        const [owner, repo] = REPO.split("/") as [string, string];
        return {
          results: [
            {
              id: "repo_search",
              data: { repositories: [{ owner, repo, stars: 120 }] },
            },
          ],
        };
      }
      default:
        throw new Error(`unexpected Octocode tool: ${toolName}`);
    }
  };
}

const probe = (id: string, query: string): SearchProbe =>
  ({
    id,
    type: "high_precision",
    provider: "octocode",
    query,
    rationale: "test probe",
  }) as unknown as SearchProbe;

afterEach(() => {
  setOctocodeToolCaller(undefined);
});

describe("Octocode normalization", () => {
  it("splitQueryTerms turns quoted probe queries into AND terms", () => {
    expect(splitQueryTerms('"convexAuth" "Resend("')).toEqual(["convexAuth", "Resend("]);
    expect(splitQueryTerms('"signIn(\'resend\'" "@convex-dev/auth/react"')).toEqual([
      "signIn('resend'",
      "@convex-dev/auth/react",
    ]);
    expect(splitQueryTerms("convexAuthNextjsMiddleware")).toEqual([
      "convexAuthNextjsMiddleware",
    ]);
  });

  it("normalizeSearchResponse flattens matches and attributes probes", () => {
    const probes = [probe("p1", '"convexAuth"'), probe("p2", '"Resend("')];
    const results = normalizeSearchResponse(
      {
        results: [
          {
            queryId: "p2",
            repository: REPO,
            path: "convex/auth.ts",
            matches: [
              { line: 4, text: "convexAuth({" },
              { line: 6, text: "Resend({" },
            ],
          },
          // Entries missing repo or path are dropped, never guessed.
          { queryId: "p1", path: "orphan.ts" },
          { queryId: "p1", repository: "a/b" },
          // Missing queryId falls back to the first probe of the batch.
          { repository: "a/b", path: "src/x.ts" },
        ],
      },
      probes,
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ repo: REPO, path: "convex/auth.ts", line: 4, probeId: "p2" });
    expect(results[1]).toMatchObject({ line: 6, snippet: "Resend({" });
    expect(results[2]).toMatchObject({ repo: "a/b", path: "src/x.ts", probeId: "p1" });
  });

  it("normalizes current ghSearchCode bulk envelopes without inventing line numbers", () => {
    const probes = [probe("p1", '"MIDISourceCreate"')];
    const results = normalizeSearchResponse(
      {
        results: [
          {
            id: "p1",
            data: {
              files: [
                {
                  owner: "mixedinkey-opensource",
                  repo: "MIKMIDI",
                  path: "Source/MIKMIDIClientSourceEndpoint.h",
                  matches: [{ value: "using MIDISourceCreate()", matchIndices: [{ lineOffset: 1 }] }],
                },
              ],
            },
          },
        ],
      },
      probes,
    );
    expect(results).toEqual([
      expect.objectContaining({
        repo: "mixedinkey-opensource/MIKMIDI",
        path: "Source/MIKMIDIClientSourceEndpoint.h",
        probeId: "p1",
        snippet: "using MIDISourceCreate()",
      }),
    ]);
    expect(results[0]!.line).toBeUndefined();
  });

  it("searchCode batches at most 5 probes and sends the current Octocode schema", async () => {
    const calls: RecordedCall[] = [];
    const provider = new OctocodeEvidenceProvider({ callTool: fakeOctocodeCaller(calls) });
    const probes = Array.from({ length: 7 }, (_, i) => probe(`p${i}`, `"signal${i}"`));
    await provider.searchCode(probes);
    const searchCalls = calls.filter((c) => c.tool === "ghSearchCode");
    expect(searchCalls).toHaveLength(2);
    expect((searchCalls[0]!.args.queries as unknown[]).length).toBe(5);
    expect((searchCalls[1]!.args.queries as unknown[]).length).toBe(2);
    expect((searchCalls[0]!.args.queries as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "p0",
      keywords: ["signal0"],
      page: 1,
      concise: false,
    });
  });
});

describe("full pipeline against a fake Octocode caller", () => {
  it("search -> metadata -> getFile -> anchors -> scoring proves the repo", async () => {
    const calls: RecordedCall[] = [];
    const provider = new OctocodeEvidenceProvider({ callTool: fakeOctocodeCaller(calls) });
    expect(provider.configured).toBe(true);

    const { run, evidence } = await runResearch({ goal: GOAL, provider });

    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.repo).toBe(REPO);
    expect(run.candidates[0]!.matchedPaths.length).toBe(4);

    const scored = run.scoredCandidates[0]!;
    expect(scored.class).toBe("production");
    expect(scored.nextAction).toBe("extract");
    expect(run.selectedRepos).toContain(REPO);

    const proved = evidence.filter((a) => a.proofLevel === "proved");
    expect(proved.length).toBeGreaterThanOrEqual(3);
    for (const anchor of evidence) expect(anchor.provider).toBe("octocode");

    // Exact reads happened through the bridge (search + one read per path).
    expect(calls.some((c) => c.tool === "ghGetFileContent")).toBe(true);
  });

  it("unreadable files become missingProof warnings, never guesses", async () => {
    const caller: OctocodeToolCaller = async (toolName, rawArgs) => {
      if (toolName === "ghSearchCode") {
        const queries = (rawArgs as { queries: Array<{ id?: string }> }).queries;
        return {
          results: [
            {
              id: queries[0]?.id,
              data: {
                files: [
                  { owner: "headcodecms", repo: "headcodecms", path: "convex/auth.ts", matches: [{}] },
                ],
              },
            },
          ],
        };
      }
      if (toolName === "ghGetFileContent") {
        return { results: [{ id: REPO, data: { files: [{ error: "rate limited" }] } }] };
      }
      return {};
    };
    const { run } = await runResearch({ goal: GOAL, provider: new OctocodeEvidenceProvider({ callTool: caller }) });
    expect(run.warnings.some((w) => w.includes("missingProof") && w.includes("rate limited"))).toBe(true);
    expect(run.scoredCandidates[0]!.class).not.toBe("production");
  });
});

describe("Octocode bridge wiring (end-to-end configuration)", () => {
  it("resolveOctocodeProvider uses the programmatic registry", async () => {
    setOctocodeToolCaller(fakeOctocodeCaller());
    const provider = await resolveOctocodeProvider({ requireConfigured: true });
    expect(provider.configured).toBe(true);
    const tree = await provider.getRepoTree({ repo: REPO });
    expect(tree.paths).toContain("convex/auth.ts");
  });

  it("an explicit callTool wins over the registry", async () => {
    setOctocodeToolCaller(async () => {
      throw new Error("registry caller must not be used");
    });
    const provider = await resolveOctocodeProvider({ callTool: fakeOctocodeCaller() });
    await expect(provider.getRepoTree({ repo: REPO })).resolves.toMatchObject({ repo: REPO });
  });

  it("loads a caller from a RESEARCH_OCTOCODE_BRIDGE module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ro-bridge-"));
    const modulePath = join(dir, "bridge.mjs");
    await writeFile(
      modulePath,
      "export default async function callTool(toolName, args) {\n" +
        "  if (toolName === 'ghViewRepoStructure') return { paths: ['from-env-bridge.ts'] };\n" +
        "  return {};\n" +
        "}\n",
      "utf8",
    );
    const env = { [OCTOCODE_BRIDGE_ENV]: modulePath } as NodeJS.ProcessEnv;
    const caller = await loadOctocodeToolCallerFromEnv(env);
    expect(typeof caller).toBe("function");

    const provider = await resolveOctocodeProvider({ env, requireConfigured: true });
    const tree = await provider.getRepoTree({ repo: "owner/name" });
    expect(tree.paths).toEqual(["from-env-bridge.ts"]);
  });

  it("a broken RESEARCH_OCTOCODE_BRIDGE fails with a structured error", async () => {
    const env = { [OCTOCODE_BRIDGE_ENV]: "/nonexistent/bridge.mjs" } as NodeJS.ProcessEnv;
    await expect(resolveOctocodeProvider({ env })).rejects.toMatchObject({
      name: "ResearchError",
      code: "provider_not_configured",
    });
  });

  it("mode:'octocode' fails fast with provider_not_configured when nothing is wired", async () => {
    await expect(resolveProvider("octocode")).rejects.toMatchObject({
      code: "provider_not_configured",
    });
    await expect(findImplementations({ goal: GOAL, mode: "octocode" })).rejects.toMatchObject({
      code: "provider_not_configured",
    });
  });

  it("mode:'octocode' runs the MCP tool end-to-end once a bridge is registered", async () => {
    setOctocodeToolCaller(fakeOctocodeCaller());
    const output = await findImplementations({ goal: GOAL, mode: "octocode" });
    expect(output.selectedRepos).toContain(REPO);
    expect(output.evidence.filter((a) => a.proofLevel === "proved").length).toBeGreaterThanOrEqual(3);
    expect(output.runId.startsWith("run_next_convex_magic_link_auth")).toBe(true);
  });
});
