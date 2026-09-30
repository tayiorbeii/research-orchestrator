import { describe, expect, it } from "vitest";
import type { ClaimAssessment, SourceObservation } from "../src/schemas/researchContracts.js";
import { EVIDENCE_POLICY_VERSION } from "../src/core/evidencePolicy.js";
import { assessScopedContradiction } from "../src/core/assessment/contradiction.js";
import type { ClaimSpec } from "../src/core/assessment/types.js";

const claim: ClaimSpec = {
  claimId: "ci-ruff", questionId: "q1", subject: { repo: "acme/tool", revision: "rev1" },
  assertion: "workflow command python ./scripts/lint.py is present in file .github/workflows/lint.yml",
  target: { kind: "workflow", command: "./scripts/lint.py", file: ".github/workflows/lint.yml" },
};

function observation(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    id: "obs1", kind: "repository_file", repo: "acme/tool", path: ".github/workflows/lint.yml",
    requestedRevision: "main", resolvedRevision: "rev1", revisionStatus: "immutable",
    excerpt: "jobs:\n  lint:\n    steps:\n      - run: python ./scripts/lint.py",
    retrievedAt: "2026-09-29T00:00:00.000Z", retrievalMethod: "getFile", readStatus: "complete", origin: "engine",
    ...overrides,
  };
}

function supported(): ClaimAssessment {
  return {
    claimId: claim.claimId, questionId: claim.questionId, subject: claim.subject,
    assertion: claim.assertion, requiredObservationIds: ["obs1"], status: "supported",
    method: "workflow_command", assessorOrigin: "engine", evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    rationale: "The workflow contains this command.", remainingObligations: [], limitations: [],
  };
}

describe("scoped contradiction assessment", () => {
  it("contradicts a same-revision command disabled in its own workflow step", () => {
    const result = assessScopedContradiction(claim, supported(), [observation({
      excerpt: "jobs:\n  lint:\n    steps:\n      - name: Lint\n        if: false\n        run: python ./scripts/lint.py",
    })]);
    expect(result.status).toBe("contradicted");
    expect(result.requiredObservationIds).toContain("obs1");
  });

  it.each([
    ["continue-on-error", "        continue-on-error: true"],
    ["allowed failure", "    allow_failure: true"],
    ["skipped step", "        skip: true"],
  ])("scopes %s to the asserted workflow command", (_label, falsifier) => {
    const excerpt = `jobs:\n  lint:\n${falsifier.includes("allow_failure") ? `${falsifier}\n` : "    steps:\n      - name: Lint\n"}${falsifier.includes("allow_failure") ? "    steps:\n      - name: Lint\n" : `${falsifier}\n`}        run: python ./scripts/lint.py`;
    expect(assessScopedContradiction(claim, supported(), [observation({ excerpt })]).status).toBe("contradicted");
  });

  it("narrows a claim when a nearby job skip is not scoped to the asserted step", () => {
    const result = assessScopedContradiction(claim, supported(), [observation({
      excerpt: "jobs:\n  lint:\n    steps:\n      - name: Prepare\n        if: false\n        run: echo prepare\n      - name: Lint\n        run: python ./scripts/lint.py",
    })]);
    expect(result.status).toBe("partial");
    expect(result.rationale).toMatch(/relationship to the asserted subject is not established/i);
  });

  it("keeps historical and current revisions as a partial difference, never a contradiction", () => {
    const result = assessScopedContradiction(claim, supported(), [observation({
      id: "obs-current", resolvedRevision: "rev2", excerpt: "jobs:\n  lint:\n    steps:\n      - run: echo skipped",
    })]);
    expect(result.status).toBe("partial");
    expect(result.status).not.toBe("contradicted");
    expect(result.rationale).toMatch(/different revision/);
    expect(result.requiredObservationIds).toContain("obs-current");
  });

  it("does not contradict an unpinned supported claim using a falsifier from another observed revision", () => {
    const unpinned = { ...claim, subject: { repo: claim.subject.repo } };
    const unpinnedSupport = { ...supported(), subject: { repo: claim.subject.repo } };
    const result = assessScopedContradiction(unpinned, unpinnedSupport, [
      observation({ id: "obs1", resolvedRevision: "rev1" }),
      observation({ id: "obs2", resolvedRevision: "rev2", excerpt: "jobs:\n  lint:\n    steps:\n      - if: false\n        run: python ./scripts/lint.py" }),
    ]);
    expect(result.status).toBe("partial");
    expect(result.status).not.toBe("contradicted");
    expect(result.rationale).toMatch(/different revision/);
  });

  it("does not contradict a supported claim with an unrelated repository override", () => {
    const result = assessScopedContradiction(claim, supported(), [observation({
      id: "other", repo: "other/tool", excerpt: "continue-on-error: true",
    })]);
    expect(result).toEqual(supported());
  });

  it("does not treat an unrelated disabled configuration flag as a workflow contradiction", () => {
    const result = assessScopedContradiction(claim, supported(), [observation({
      excerpt: "strict: false\njobs:\n  lint:\n    steps:\n      - run: python ./scripts/lint.py",
    })]);
    expect(result).toEqual(supported());
  });

  it("contradicts a workflow claim when its same-revision referenced helper is an explicit no-op", () => {
    const helper = observation({
      id: "helper", path: "scripts/lint.py", excerpt: "#!/usr/bin/env python3\npass", readStatus: "complete",
    });
    const result = assessScopedContradiction(claim, supported(), [observation(), helper]);
    expect(result.status).toBe("contradicted");
    expect(result.rationale).toMatch(/same-revision contents are an explicit no-op/);
    expect(result.requiredObservationIds).toContain("helper");
  });

  it("scopes a named rule ignore to that rule and target path", () => {
    const ruleClaim: ClaimSpec = {
      ...claim, assertion: "Ruff rule F401 is enforced for package/core.py",
      target: { kind: "quotation", path: "ruff.toml", signals: ["F401"] },
    };
    const result = assessScopedContradiction(ruleClaim, { ...supported(), assertion: ruleClaim.assertion }, [observation({
      path: "ruff.toml", excerpt: "[tool.ruff.lint.per-file-ignores]\n\"package/*.py\" = [\"F401\"]",
    })]);
    expect(result.status).toBe("contradicted");
  });
});
