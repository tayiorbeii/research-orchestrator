import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OctocodeEvidenceProvider } from "../src/adapters/OctocodeEvidenceProvider.js";
import { GitHubEvidenceProvider } from "../src/adapters/GitHubEvidenceProvider.js";
import { githubRevisionResolver } from "../src/adapters/bridge.js";
import { executeBrief } from "../src/core/brief/executeBrief.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";
import type { SearchProbeV2 } from "../src/schemas/searchProbeV2.js";

const SHA = "feedfacefeedfacefeedfacefeedfacefeedface";
const budgets = { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 0, refinementProbes: 0, deadlineMs: 60_000 };
const brief: ResearchBrief = {
  id: "pin", revision: 1, goal: "pin", mechanisms: [], vocabulary: [], seeds: [], allowedSourceKinds: ["repository_file"], budgets, readiness: { status: "ready" }, lookupOutcomes: [],
  questions: [{ id: "q1", statement: "uses alphaToken", intentHints: ["implementation_behavior"], required: true, answerScope: "one", obligations: [{ facts: [{ kind: "quotation", signals: ["alphaToken"], claimScope: "implemented" }], combine: "all", scope: "same_repository" }] }],
};
const probe: SearchProbeV2 = { id: "p1", questionIds: ["q1"], mechanismIds: [], termIds: [], purpose: "discovery", intent: "q1", providerQuery: "alphaToken", providerArgs: { endpoint: "codeSearch" }, expectedSourceKinds: ["repository_file"], expectedPaths: [], rationale: "t", alternativesLeftOpen: [], predecessorProbeIds: [] };

/** A fake Octocode session that records file-read arguments. */
function fakeCaller() {
  const fileArgs: Array<Record<string, unknown>> = [];
  const callTool = async (name: string, args: unknown) => {
    if (name === "ghSearchCode") {
      const queries = (args as { queries: Array<{ id?: string }> }).queries;
      return { results: queries.map((query) => ({ id: query.id, data: { files: [{ owner: "acme", repo: "lib", path: "src/alpha.ts", matches: [{ value: "alphaToken" }] }] } })) };
    }
    if (name === "ghSearchRepos") return { results: [{ data: { repositories: [{ owner: "acme", repo: "lib", url: "https://github.com/acme/lib" }] } }] };
    if (name === "ghGetFileContent") {
      const query = (args as { queries: Array<Record<string, unknown>> }).queries[0]!;
      fileArgs.push(query);
      return { results: [{ data: { files: [{ path: query.path, content: "export const alphaToken = 1;" }] } }] };
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return { callTool, fileArgs };
}

describe("revision pinning through the Octocode provider", () => {
  it("advertises no pinning and answers unavailable without a resolver", async () => {
    const provider = new OctocodeEvidenceProvider({ callTool: fakeCaller().callTool });
    expect(provider.searchCapabilities().revisionPinning).toBe(false);
    expect(await provider.resolveRevision({ repo: "acme/lib", ref: "main" })).toMatchObject({ unavailableReason: expect.stringContaining("no revision resolver") });
  });

  it("reads at the resolved SHA and binds observations, anchors and claims to it", async () => {
    const session = fakeCaller();
    const resolved: Array<string | undefined> = [];
    const provider = new OctocodeEvidenceProvider({ callTool: session.callTool, revisionResolver: async (input) => { resolved.push(input.ref); return { sha: SHA, ref: input.ref ?? "main", source: "provider" }; } });
    expect(provider.searchCapabilities().revisionPinning).toBe(true);
    const run = await executeBrief(brief, { provider, validateBrief: (item) => ({ brief: item, issues: [] }), compileProbes: ((_b: unknown, _c: unknown, ledger: never) => ({ probes: [probe], failures: [], ledger })) as never });
    expect(session.fileArgs.every((query) => query.branch === SHA)).toBe(true);
    const files = run.observations.filter((item) => item.kind === "repository_file");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((item) => item.revisionStatus === "immutable" && item.resolvedRevision === SHA)).toBe(true);
    expect(run.assessments[0]).toMatchObject({ status: "supported", subject: { repo: "acme/lib", revision: SHA } });
    expect(run.assessments[0]?.limitations.join(" ")).not.toContain("revision is unknown");
    expect(run.budgetLedger?.consumed.metadataCallBreakdown).toMatchObject({ revisionResolution: 1 });
    // Octocode metadata carries no default branch; the resolver is asked without a ref.
    expect(resolved).toEqual([undefined]);
    expect(run.observations.find((item) => item.anchor)?.anchor?.url).toContain(`/blob/${SHA}/`);
  });
});

describe("githubRevisionResolver", () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  beforeEach(() => { delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; });
  afterEach(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  it("answers unavailable instead of throwing when no token exists", async () => {
    const resolver = githubRevisionResolver({ github: new GitHubEvidenceProvider({ getGhToken: () => undefined }) });
    expect(await resolver({ repo: "acme/lib", ref: "main" })).toMatchObject({ unavailableReason: expect.stringContaining("No GitHub token") });
  });

  it("delegates to the GitHub REST provider, looking up the default branch when no ref is given", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).endsWith("/repos/acme/lib")) return new Response(JSON.stringify({ full_name: "acme/lib", owner: { login: "acme" }, name: "lib", default_branch: "trunk" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(String(url).includes("/commits/trunk") ? SHA : "nope", { status: 200, headers: { "content-type": "application/vnd.github.sha" } });
    }) as unknown as typeof fetch;
    const resolver = githubRevisionResolver({ github: new GitHubEvidenceProvider({ token: "token", fetchImpl }) });
    expect(await resolver({ repo: "acme/lib" })).toEqual({ sha: SHA, ref: "trunk", source: "provider" });
    expect(urls.some((url) => url.endsWith("/repos/acme/lib"))).toBe(true);
  });
});
