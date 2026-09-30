import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  EvidenceProvider,
  FileEvidence,
  FileReadRequest,
  NormalizedSearchResult,
  RepoMetadata,
  RepoRef,
  RepoSearchQuery,
  RepoSearchResult,
  RepoTree,
  ProviderSearchCapabilities,
  IssueProposal,
  IssueReadRequest,
  IssueSearchQuery,
} from "./EvidenceProvider.js";
import type { CandidateRepo, SearchProbe } from "../schemas/index.js";

export interface MockFixture {
  candidates: CandidateRepo[];
  fileContents: Record<string, Record<string, string>>;
  issues?: Record<string, IssueProposal[]>;
}

/**
 * Deterministic, network-free provider backed by
 * examples/sample_research_run.json plus embedded mock file contents.
 * Used for tests, the --mock CLI flow, and agent bootstrapping.
 */
export class MockEvidenceProvider implements EvidenceProvider {
  readonly name = "mock" as const;
  searchCapabilities(): ProviderSearchCapabilities {
    return { capabilityVersion: "mock-fixture-v1", revisionPinning: true, supportedQualifiers: { codeSearch: [], repoSearch: [] }, codeSearch: true, repoSearch: true, issues: true, batch: { codeSearch: true, repoSearch: false } };
  }
  private fixture: MockFixture | undefined;
  private readonly fixturePath: string;

  constructor(options: { fixturePath?: string; fixture?: MockFixture } = {}) {
    this.fixturePath =
      options.fixturePath ??
      fileURLToPath(new URL("../../examples/sample_research_run.json", import.meta.url));
    if (options.fixture) this.fixture = options.fixture;
  }

  private async load(): Promise<MockFixture> {
    if (this.fixture) return this.fixture;
    const raw = JSON.parse(await readFile(this.fixturePath, "utf8")) as {
      candidates: CandidateRepo[];
      issues?: Record<string, IssueProposal[]>;
    };
    this.fixture = {
      candidates: raw.candidates ?? [],
      fileContents: MOCK_FILE_CONTENTS,
      issues: raw.issues ?? {},
    };
    return this.fixture;
  }

  async searchCode(probes: SearchProbe[]): Promise<NormalizedSearchResult[]> {
    const { candidates } = await this.load();
    const probeIds = new Set(probes.map((p) => p.id));
    const results: NormalizedSearchResult[] = [];
    for (const candidate of candidates) {
      const emit = Math.max(candidate.matchedPaths.length, candidate.discoveredBy.length, 1);
      for (let i = 0; i < emit; i += 1) {
        const fixtureProbeId =
          candidate.discoveredBy[i % Math.max(candidate.discoveredBy.length, 1)] ?? "mock_probe";
        // Keep the fixture's probe attribution, but if the caller generated
        // its own probes, attribute round-robin so provenance is never empty.
        const probeId = probeIds.has(fixtureProbeId)
          ? fixtureProbeId
          : (probes[i % Math.max(probes.length, 1)]?.id ?? fixtureProbeId);
        results.push({
          repo: candidate.repo,
          path: candidate.matchedPaths[i % Math.max(candidate.matchedPaths.length, 1)] ?? "README.md",
          branch: candidate.defaultBranch,
          probeId,
          snippet: candidate.candidateSignals[i]?.label,
        });
      }
    }
    return results;
  }

  async searchRepos(_query: RepoSearchQuery): Promise<RepoSearchResult[]> {
    const { candidates } = await this.load();
    return candidates.map((c) => ({
      repo: c.repo,
      url: c.url,
      stars: c.stars,
      archived: c.archived,
      pushedAt: c.pushedAt,
    }));
  }

  async searchIssues(input: IssueSearchQuery): Promise<IssueProposal[]> {
    const { issues = {} } = await this.load();
    const terms = input.query.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
    return Object.entries(issues)
      .filter(([repo]) => !input.repo || repo === input.repo)
      .flatMap(([, repoIssues]) => repoIssues)
      .filter((issue) => terms.length === 0 || terms.some((term) => `${issue.title} ${issue.body}`.toLowerCase().includes(term)))
      .slice(0, input.maxResults);
  }

  async getIssue(input: IssueReadRequest): Promise<IssueProposal> {
    const { issues = {} } = await this.load();
    const issue = (issues[input.repo] ?? []).find((item) => item.number === input.number);
    if (!issue) throw new Error(`Mock issue ${input.repo}#${input.number} is unavailable.`);
    return issue;
  }

  async getRepoMetadata(repo: RepoRef): Promise<RepoMetadata> {
    const { candidates } = await this.load();
    const candidate = candidates.find((c) => c.repo === repo.repo);
    if (!candidate) {
      const [owner = "unknown", name = repo.repo] = repo.repo.split("/");
      return { repo: repo.repo, owner, name };
    }
    return {
      repo: candidate.repo,
      owner: candidate.owner,
      name: candidate.name,
      defaultBranch: candidate.defaultBranch,
      url: candidate.url,
      archived: candidate.archived,
      stars: candidate.stars,
      pushedAt: candidate.pushedAt,
    };
  }

  async resolveRevision(input: RepoRef) {
    return { sha: "0123456789abcdef0123456789abcdef01234567", ref: input.ref ?? "fixture", source: "provider" as const };
  }

  async getFile(input: FileReadRequest): Promise<FileEvidence> {
    const { fileContents } = await this.load();
    const content = fileContents[input.repo]?.[input.path];
    if (content === undefined) {
      return {
        provider: "mock",
        repo: input.repo,
        path: input.path,
        unavailableReason: "no mock content for this path",
      };
    }
    return { provider: "mock", repo: input.repo, path: input.path, content };
  }

  async getRepoTree(repo: RepoRef): Promise<RepoTree> {
    const { fileContents } = await this.load();
    return { repo: repo.repo, paths: Object.keys(fileContents[repo.repo] ?? {}) };
  }

  /** Also usable directly by tests that need raw candidates. */
  async getCandidates(): Promise<CandidateRepo[]> {
    const { candidates } = await this.load();
    return candidates;
  }
}

/**
 * Mock file contents for fixture repos. Note: the AUTH_RESEND_KEY value below
 * is a fake secret used to verify the redaction pipeline; it must never
 * appear in generated artifacts.
 */
export const MOCK_FILE_CONTENTS: Record<string, Record<string, string>> = {
  "headcodecms/headcodecms": {
    "package.json": `{
  "name": "headcodecms",
  "private": true,
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "convex": "^1.17.0",
    "@convex-dev/auth": "^0.0.81",
    "@auth/core": "^0.37.0",
    "resend": "^4.0.0"
  }
}
`,
    "convex/auth.ts": `import { convexAuth } from "@convex-dev/auth/server";
import Resend from "@auth/core/providers/resend";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Resend({
      from: "HeadcodeCMS <auth@example.com>",
    }),
  ],
});
`,
    "app/(admin)/admin/login/page.tsx": `"use client";
import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";

export default function LoginPage() {
  const { signIn } = useAuthActions();
  const [sent, setSent] = useState(false);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        void signIn('resend', formData).then(() => setSent(true));
      }}
    >
      {sent ? <p>Check your email for a magic link.</p> : (
        <>
          <input name="email" type="email" required />
          <button type="submit">Send magic link</button>
        </>
      )}
    </form>
  );
}
`,
    "proxy.ts": `import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

const isProtected = createRouteMatcher(["/admin(.*)"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  if (isProtected(request) && !(await convexAuth.isAuthenticated())) {
    return nextjsMiddlewareRedirect(request, "/admin/login");
  }
});

export const config = {
  matcher: ["/((?!.*\\\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
`,
  },
  "justinwlin/convex-magic-link-authentication": {
    "README.md": `# Convex Magic Link Authentication

A guide to setting up magic-link auth with Convex Auth and Resend.

## Setup

Install @convex-dev/auth, then configure the Resend provider in convex/auth.ts.

Set your environment variables:

AUTH_RESEND_KEY=re_FAKEFAKEFAKEFAKEFAKE1234
SITE_URL=http://localhost:3000

Then call useAuthActions().signIn("resend", formData) from your login form.
`,
  },
};
