import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { addLocalArtifactFingerprints } from "../src/core/brief/localArtifacts.js";

describe("local artifact path policy", () => {
  it("allows an explicitly listed project file under the home directory", async () => {
    const root = await mkdtemp(join(homedir(), "local-artifact-project-"));
    try {
      await writeFile(join(root, "source.ts"), 'import Widget from "@acme/widget";');
      const result = await addLocalArtifactFingerprints({ localArtifacts: [{ path: "source.ts" }] }, root);
      expect(result.vocabulary).toEqual(expect.arrayContaining([expect.objectContaining({ text: "@acme/widget", kind: "import_path" })]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses symlinks outside the project and explicitly listed roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-artifact-project-"));
    const outside = await mkdtemp(join(tmpdir(), "local-artifact-outside-"));
    try {
      await writeFile(join(outside, "source.ts"), 'import Widget from "@acme/widget";');
      await symlink(join(outside, "source.ts"), join(root, "linked.ts"));
      await expect(addLocalArtifactFingerprints({ localArtifacts: [{ path: "linked.ts" }] }, root)).rejects.toThrow(/outside/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses credential-like files and directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-artifact-project-"));
    try {
      await writeFile(join(root, ".env"), "SECRET=value");
      await writeFile(join(root, ".envrc"), "SECRET=value");
      await mkdir(join(root, "folder"));
      await expect(addLocalArtifactFingerprints({ localArtifacts: [{ path: ".env" }] }, root)).rejects.toThrow(/Credential-like/);
      await expect(addLocalArtifactFingerprints({ localArtifacts: [{ path: ".envrc" }] }, root)).rejects.toThrow(/Credential-like/);
      await expect(addLocalArtifactFingerprints({ localArtifacts: [{ path: "folder" }] }, root)).rejects.toThrow(/regular files/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
