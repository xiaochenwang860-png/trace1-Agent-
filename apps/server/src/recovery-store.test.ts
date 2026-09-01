import {
  createHash,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffSnapshots,
  RecoveryIntegrityError,
  RecoveryStore,
  WorkspaceChangedError,
  WorkspaceUnstableError,
  type RecoverySnapshot,
  type RecoveryGitRepository,
} from "./recovery-store.js";
import type {
  GitRecoveryCheckpoint,
  GitRecoverySnapshot,
  LoadedGitRecoveryCheckpoint,
} from "./git-recovery-repository.js";

const temporaryDirectories: string[] = [];

function fakeOid(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function fakeGitBlobOid(bytes: Buffer): string {
  return createHash("sha256")
    .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

class InMemoryGitRecoveryRepository implements RecoveryGitRepository {
  readonly refs: string[] = [];
  readonly refTargets = new Map<string, string>();
  readonly blobs = new Map<string, Map<string, Buffer>>();
  readonly checkpoints = new Map<string, LoadedGitRecoveryCheckpoint>();
  probes = 0;

  async probe(): Promise<void> {
    this.probes += 1;
  }

  async writeBlob(repositoryId: string, bytes: Buffer): Promise<string> {
    const oid = fakeGitBlobOid(bytes);
    const repository = this.blobs.get(repositoryId) ?? new Map<string, Buffer>();
    repository.set(oid, Buffer.from(bytes));
    this.blobs.set(repositoryId, repository);
    return oid;
  }

  async readBlob(repositoryId: string, oid: string): Promise<Buffer> {
    const bytes = this.blobs.get(repositoryId)?.get(oid);
    if (!bytes) throw new Error("missing fake Git blob");
    return Buffer.from(bytes);
  }

  async capture(
    repositoryId: string,
    snapshot: GitRecoverySnapshot,
    refName?: string,
  ): Promise<GitRecoveryCheckpoint> {
    const sequence = this.checkpoints.size + 1;
    const workspaceTreeOid = fakeOid(`tree:${repositoryId}:${snapshot.rootHash}`);
    const manifestBlobOid = fakeOid(`manifest:${repositoryId}:${snapshot.rootHash}`);
    const controlTreeOid = fakeOid(`control:${workspaceTreeOid}:${manifestBlobOid}`);
    const commitOid = fakeOid(`commit:${repositoryId}:${sequence}:${controlTreeOid}`);
    const checkpoint: LoadedGitRecoveryCheckpoint = {
      storage: "git-sha256-v1",
      repositoryId,
      repositoryPath: path.join("external-recovery", `${repositoryId}.git`),
      rootHash: snapshot.rootHash,
      commitOid,
      controlTreeOid,
      workspaceTreeOid,
      manifestBlobOid,
      refName: refName ?? null,
      manifest: {
        version: 1,
        storage: "git-sha256-v1",
        repositoryId,
        repositoryIdHash: fakeOid(repositoryId),
        workspaceTreeOid,
        snapshot: structuredClone(snapshot),
      },
      snapshot: structuredClone(snapshot),
    };
    this.checkpoints.set(`${repositoryId}:${commitOid}`, checkpoint);
    if (refName) {
      this.refs.push(refName);
      this.refTargets.set(`${repositoryId}:${refName}`, commitOid);
    }
    return checkpoint;
  }

  async resolveRef(repositoryId: string, refName: string): Promise<string> {
    const oid = this.refTargets.get(`${repositoryId}:${refName}`);
    if (!oid) throw new Error("missing fake Git ref");
    return oid;
  }

  async load(
    repositoryId: string,
    commitOid: string,
  ): Promise<LoadedGitRecoveryCheckpoint> {
    const checkpoint = this.checkpoints.get(`${repositoryId}:${commitOid}`);
    if (!checkpoint) throw new Error("missing fake Git checkpoint");
    return structuredClone(checkpoint);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture(): Promise<{
  root: string;
  workspace: string;
  recovery: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "recovery-store-"));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const recovery = path.join(root, "recovery");
  await mkdir(workspace);
  return { root, workspace, recovery };
}

describe("RecoveryStore", () => {
  it("stores Agent checkpoints and restore safety points in the external Git backend", async () => {
    const { workspace, recovery } = await createFixture();
    const repository = new InMemoryGitRecoveryRepository();
    const store = new RecoveryStore(recovery, { gitRepository: repository });
    const location = { repositoryId: "agent-git", workspacePath: workspace };
    await writeFile(path.join(workspace, "deleted.txt"), "preserve me", "utf8");

    await expect(store.capture(location)).rejects.toThrow(
      "require a durable checkpoint ref",
    );
    const checkpoint = await store.capture(location, {
      refName: "refs/launchpad/runs/run-1/before",
    });
    expect(checkpoint).toMatchObject({
      storage: "git-sha256-v1",
      repositoryId: "agent-git",
      commitOid: expect.stringMatching(/^[a-f0-9]{64}$/),
      workspaceTreeOid: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestBlobOid: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const loaded = await store.load({
      repositoryId: checkpoint.repositoryId as string,
      commitOid: checkpoint.commitOid as string,
      rootHash: checkpoint.rootHash,
      workspaceTreeOid: checkpoint.workspaceTreeOid as string,
      manifestBlobOid: checkpoint.manifestBlobOid as string,
    });
    expect(loaded).toEqual(checkpoint);

    await unlink(path.join(workspace, "deleted.txt"));
    await writeFile(path.join(workspace, "new.txt"), "new", "utf8");
    const current = await store.inspect(location);
    const restored = await store.restore({
      ...location,
      snapshot: checkpoint,
      expectedCurrentRootHash: current.rootHash,
      operationId: "restore-git-1",
    });

    expect(await readFile(path.join(workspace, "deleted.txt"), "utf8")).toBe(
      "preserve me",
    );
    await expect(stat(path.join(workspace, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(workspace, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(recovery, "objects"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(restored.safetySnapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(restored.safetySnapshotId).not.toBe(current.rootHash);
    await expect(
      store.resolveSafetySnapshotId(
        location.repositoryId,
        "restore-git-1",
        current.rootHash,
      ),
    ).resolves.toBe(restored.safetySnapshotId);
    await expect(
      store.resolveSafetySnapshotId(
        location.repositoryId,
        "restore-git-1",
        checkpoint.rootHash,
      ),
    ).rejects.toThrow("does not match the pre-restore workspace");
    expect(repository.refs).toEqual([
      "refs/launchpad/runs/run-1/before",
      "refs/launchpad/safety/restore-git-1",
      "refs/launchpad/restores/restore-git-1/result",
    ]);
    expect(repository.probes).toBe(1);
  });

  it("stores content-addressed blobs once and reloads a manifest", async () => {
    const { workspace, recovery } = await createFixture();
    await writeFile(path.join(workspace, "first.txt"), "same content", "utf8");
    await writeFile(path.join(workspace, "second.txt"), "same content", "utf8");
    const store = new RecoveryStore(recovery);

    const snapshot = await store.capture(workspace);
    const loaded = await store.load(snapshot.rootHash);

    expect(loaded).toEqual(snapshot);
    const blobHash = snapshot.entries.find((entry) => entry.kind === "file")?.blobHash;
    expect(blobHash).toMatch(/^[a-f0-9]{64}$/);
    const objectDirectory = path.join(
      recovery,
      "objects",
      "sha256",
      (blobHash as string).slice(0, 2),
    );
    expect(await readdir(objectDirectory)).toEqual([blobHash]);
  });

  it("detects same-size content changes even when mtime is restored", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    await writeFile(filePath, "before", "utf8");
    const originalTimes = await stat(filePath);
    const store = new RecoveryStore(recovery);
    const before = await store.capture(workspace);

    await writeFile(filePath, "change", "utf8");
    await utimes(filePath, originalTimes.atime, originalTimes.mtime);
    const after = await store.inspect(workspace);

    expect(after.rootHash).not.toBe(before.rootHash);
    expect(diffSnapshots(before, after)).toMatchObject([
      { path: "value.txt", kind: "modified" },
    ]);
  });

  it("restores deleted trees, empty directories, and both structural type changes", async () => {
    const { workspace, recovery } = await createFixture();
    await mkdir(path.join(workspace, "deleted", "nested"), { recursive: true });
    await writeFile(
      path.join(workspace, "deleted", "nested", "value.txt"),
      "checkpoint",
      "utf8",
    );
    await mkdir(path.join(workspace, "empty"));
    await writeFile(path.join(workspace, "file-to-directory"), "file", "utf8");
    await mkdir(path.join(workspace, "directory-to-file"));
    await writeFile(
      path.join(workspace, "directory-to-file", "child.txt"),
      "child",
      "utf8",
    );
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);

    await rm(path.join(workspace, "deleted"), { recursive: true });
    await rm(path.join(workspace, "empty"), { recursive: true });
    await unlink(path.join(workspace, "file-to-directory"));
    await mkdir(path.join(workspace, "file-to-directory"));
    await writeFile(
      path.join(workspace, "file-to-directory", "new.txt"),
      "new",
      "utf8",
    );
    await rm(path.join(workspace, "directory-to-file"), { recursive: true });
    await writeFile(path.join(workspace, "directory-to-file"), "replacement", "utf8");
    await mkdir(path.join(workspace, "created", "tree"), { recursive: true });
    await writeFile(path.join(workspace, "created", "tree", "new.txt"), "new", "utf8");
    const postRun = await store.inspect(workspace);

    const preview = await store.previewRestore({
      workspacePath: workspace,
      snapshot: checkpoint,
      expectedCurrentRootHash: postRun.rootHash,
    });
    expect(preview.mode).toBe("full");
    expect(preview.changes.some((change) => change.kind === "type-changed")).toBe(true);

    const result = await store.restore({
      workspacePath: workspace,
      snapshot: checkpoint,
      expectedCurrentRootHash: postRun.rootHash,
      operationId: "structural-restore",
    });

    expect(result.restoredRootHash).toBe(checkpoint.rootHash);
    expect((await store.inspect(workspace)).rootHash).toBe(checkpoint.rootHash);
    expect(
      await readFile(path.join(workspace, "deleted", "nested", "value.txt"), "utf8"),
    ).toBe("checkpoint");
    expect(await readdir(path.join(workspace, "empty"))).toEqual([]);
    expect((await lstat(path.join(workspace, "file-to-directory"))).isFile()).toBe(true);
    expect((await lstat(path.join(workspace, "directory-to-file"))).isDirectory()).toBe(true);
    await expect(lstat(path.join(workspace, "created"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(result.quarantinePath)).isDirectory()).toBe(true);
  });

  it("persists the pre-restore workspace as a loadable safety snapshot", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    await writeFile(filePath, "checkpoint", "utf8");
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);

    await writeFile(filePath, "post-run", "utf8");
    await writeFile(path.join(workspace, "created.txt"), "current only", "utf8");
    const preRestore = await store.inspect(workspace);
    const result = await store.restore({
      workspacePath: workspace,
      snapshot: checkpoint,
      expectedCurrentRootHash: preRestore.rootHash,
      operationId: "safety-snapshot",
    });

    expect(result.previousRootHash).toBe(preRestore.rootHash);
    expect(await store.load(result.previousRootHash)).toEqual(preRestore);
  });

  it("selectively restores a subtree while preserving current unselected content", async () => {
    const { workspace, recovery } = await createFixture();
    await mkdir(path.join(workspace, "selected"));
    await writeFile(path.join(workspace, "selected", "value.txt"), "checkpoint", "utf8");
    await writeFile(path.join(workspace, "keep.txt"), "old keep", "utf8");
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);

    await writeFile(path.join(workspace, "selected", "value.txt"), "broken", "utf8");
    await writeFile(path.join(workspace, "keep.txt"), "current keep", "utf8");
    await writeFile(path.join(workspace, "untracked.txt"), "preserve me", "utf8");
    const postRun = await store.inspect(workspace);

    const result = await store.restore({
      workspacePath: workspace,
      snapshot: checkpoint,
      expectedCurrentRootHash: postRun.rootHash,
      operationId: "selective-restore",
      paths: ["selected"],
    });

    expect(result.mode).toBe("selective");
    expect(result.requestedPaths).toEqual(["selected"]);
    expect(result.targetRootHash).toBe(checkpoint.rootHash);
    expect(result.resultingRootHash).not.toBe(checkpoint.rootHash);
    expect(await readFile(path.join(workspace, "selected", "value.txt"), "utf8")).toBe(
      "checkpoint",
    );
    expect(await readFile(path.join(workspace, "keep.txt"), "utf8")).toBe("current keep");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe(
      "preserve me",
    );
    expect(result.restoredPaths).toEqual(["selected/value.txt"]);
  });

  it("recreates target ancestors when selecting one file from a deleted tree", async () => {
    const { workspace, recovery } = await createFixture();
    await mkdir(path.join(workspace, "deleted", "nested"), { recursive: true });
    await writeFile(
      path.join(workspace, "deleted", "nested", "selected.txt"),
      "restore me",
      "utf8",
    );
    await writeFile(
      path.join(workspace, "deleted", "nested", "sibling.txt"),
      "leave deleted",
      "utf8",
    );
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);

    await rm(path.join(workspace, "deleted"), { recursive: true });
    const postRun = await store.inspect(workspace);
    const result = await store.restore({
      workspacePath: workspace,
      snapshot: checkpoint,
      expectedCurrentRootHash: postRun.rootHash,
      operationId: "select-deleted-nested-file",
      paths: ["deleted/nested/selected.txt"],
    });

    expect(await readFile(
      path.join(workspace, "deleted", "nested", "selected.txt"),
      "utf8",
    )).toBe("restore me");
    await expect(
      lstat(path.join(workspace, "deleted", "nested", "sibling.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.restoredPaths).toEqual([
      "deleted",
      "deleted/nested",
      "deleted/nested/selected.txt",
    ]);
    expect((await store.inspect(workspace)).rootHash).toBe(result.resultingRootHash);
  });

  it("fails closed when a selective path needs an unselected structural parent", async () => {
    const { workspace, recovery } = await createFixture();
    await mkdir(path.join(workspace, "parent"));
    await writeFile(path.join(workspace, "parent", "child.txt"), "checkpoint", "utf8");
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);

    await rm(path.join(workspace, "parent"), { recursive: true });
    await writeFile(path.join(workspace, "parent"), "current file", "utf8");
    const postRun = await store.inspect(workspace);

    await expect(
      store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "structural-conflict",
        paths: ["parent/child.txt"],
      }),
    ).rejects.toBeInstanceOf(RecoveryIntegrityError);
    expect(await readFile(path.join(workspace, "parent"), "utf8")).toBe("current file");
  });

  it("blocks a stale expected root without mutating the workspace", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    await writeFile(filePath, "checkpoint", "utf8");
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);
    await writeFile(filePath, "post-run", "utf8");
    const postRun = await store.inspect(workspace);
    await writeFile(filePath, "human edit", "utf8");

    await expect(
      store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "stale-root",
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_CHANGED",
      expectedRootHash: postRun.rootHash,
    });
    expect(await readFile(filePath, "utf8")).toBe("human edit");
  });

  it("detects a TOCTOU write after preflight and rolls the quarantine back", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    let raceEnabled = false;
    const store = new RecoveryStore(recovery, {
      hooks: {
        afterRestorePreflight: async () => {
          if (raceEnabled) await writeFile(filePath, "raced", "utf8");
        },
      },
    });
    await writeFile(filePath, "checkpoint", "utf8");
    const checkpoint = await store.capture(workspace);
    await writeFile(filePath, "post-run", "utf8");
    const postRun = await store.inspect(workspace);
    raceEnabled = true;

    await expect(
      store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "toctou",
      }),
    ).rejects.toBeInstanceOf(WorkspaceChangedError);
    expect(await readFile(filePath, "utf8")).toBe("raced");
    await expect(
      lstat(path.join(path.dirname(workspace), ".workspace.restore-toctou.quarantine")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles a crash after quarantine by restoring the previous live workspace", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    let reconciled = false;
    const store = new RecoveryStore(recovery, {
      hooks: {
        afterWorkspaceQuarantined: async () => {
          const restartedStore = new RecoveryStore(recovery);
          await restartedStore.initialize();
          reconciled = true;
          throw new Error("simulated process termination after reconciliation");
        },
      },
    });
    await writeFile(filePath, "checkpoint", "utf8");
    const checkpoint = await store.capture(workspace);
    await writeFile(filePath, "post-run", "utf8");
    const postRun = await store.inspect(workspace);

    await expect(
      store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "restart-after-quarantine",
      }),
    ).rejects.toThrow("simulated process termination");

    expect(reconciled).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("post-run");
    expect((await new RecoveryStore(recovery).inspect(workspace)).rootHash).toBe(
      postRun.rootHash,
    );
    const journals = await readdir(path.join(recovery, "operations"));
    expect(journals).toContain("restart-after-quarantine.QUARANTINED.json");
    expect(journals).toContain("restart-after-quarantine.ROLLED_BACK.json");
  });

  it("reconciles a restart after publish by verifying the result before commit", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    let targetRootHash = "";
    let reconciled = false;
    const store = new RecoveryStore(recovery, {
      hooks: {
        afterWorkspacePublished: async ({ workspacePath }) => {
          expect(await readdir(path.join(recovery, "operations"))).toContain(
            "restart-after-publish.PUBLISHED.json",
          );
          const restartedStore = new RecoveryStore(recovery);
          await restartedStore.initialize();
          expect((await restartedStore.inspect(workspacePath)).rootHash).toBe(
            targetRootHash,
          );
          expect(await readdir(path.join(recovery, "operations"))).toContain(
            "restart-after-publish.COMMITTED.json",
          );
          reconciled = true;
        },
      },
    });
    await writeFile(filePath, "checkpoint", "utf8");
    const checkpoint = await store.capture(workspace);
    targetRootHash = checkpoint.rootHash;
    await writeFile(filePath, "post-run", "utf8");
    const postRun = await store.inspect(workspace);

    const result = await store.restore({
      workspacePath: workspace,
      snapshot: checkpoint,
      expectedCurrentRootHash: postRun.rootHash,
      operationId: "restart-after-publish",
    });

    expect(reconciled).toBe(true);
    expect(result.restoredRootHash).toBe(checkpoint.rootHash);
    expect(await readFile(filePath, "utf8")).toBe("checkpoint");
    expect(await readdir(path.join(recovery, "operations"))).not.toContain(
      "restart-after-publish.ROLLED_BACK.json",
    );
  });

  it("rolls back the quarantine when published content fails final verification", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    const store = new RecoveryStore(recovery, {
      hooks: {
        afterWorkspacePublished: async ({ workspacePath }) => {
          await writeFile(path.join(workspacePath, "value.txt"), "corrupted after publish", "utf8");
        },
      },
    });
    await writeFile(filePath, "checkpoint", "utf8");
    const checkpoint = await store.capture(workspace);
    await writeFile(filePath, "post-run", "utf8");
    const postRun = await store.inspect(workspace);

    await expect(
      store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "published-verification-failure",
      }),
    ).rejects.toBeInstanceOf(RecoveryIntegrityError);

    expect(await readFile(filePath, "utf8")).toBe("post-run");
    expect((await store.inspect(workspace)).rootHash).toBe(postRun.rootHash);
    const journals = await readdir(path.join(recovery, "operations"));
    expect(journals).toContain("published-verification-failure.PUBLISHED.json");
    expect(journals).toContain(
      "published-verification-failure.ROLLED_BACK.json",
    );
    expect(journals).not.toContain(
      "published-verification-failure.COMMITTED.json",
    );
  });

  it("restores two independent workspaces without cross-operation interference", async () => {
    const { root, workspace, recovery } = await createFixture();
    const secondWorkspace = path.join(root, "workspace-second");
    await mkdir(secondWorkspace);
    const firstFile = path.join(workspace, "value.txt");
    const secondFile = path.join(secondWorkspace, "value.txt");
    await writeFile(firstFile, "first checkpoint", "utf8");
    await writeFile(secondFile, "second checkpoint", "utf8");
    const store = new RecoveryStore(recovery);
    const [firstCheckpoint, secondCheckpoint] = await Promise.all([
      store.capture(workspace),
      store.capture(secondWorkspace),
    ]);
    await writeFile(firstFile, "first broken", "utf8");
    await writeFile(secondFile, "second broken", "utf8");
    const [firstCurrent, secondCurrent] = await Promise.all([
      store.inspect(workspace),
      store.inspect(secondWorkspace),
    ]);

    const [firstResult, secondResult] = await Promise.all([
      store.restore({
        workspacePath: workspace,
        snapshot: firstCheckpoint,
        expectedCurrentRootHash: firstCurrent.rootHash,
        operationId: "independent-first",
      }),
      store.restore({
        workspacePath: secondWorkspace,
        snapshot: secondCheckpoint,
        expectedCurrentRootHash: secondCurrent.rootHash,
        operationId: "independent-second",
      }),
    ]);

    expect(firstResult.restoredRootHash).toBe(firstCheckpoint.rootHash);
    expect(secondResult.restoredRootHash).toBe(secondCheckpoint.rootHash);
    expect(await readFile(firstFile, "utf8")).toBe("first checkpoint");
    expect(await readFile(secondFile, "utf8")).toBe("second checkpoint");
    const journals = await readdir(path.join(recovery, "operations"));
    expect(journals).toContain("independent-first.COMMITTED.json");
    expect(journals).toContain("independent-second.COMMITTED.json");
  });

  it("defers restrictive directory modes until all descendant files are hydrated", async () => {
    if (process.platform === "win32") return;
    const { workspace, recovery } = await createFixture();
    const privateDirectory = path.join(workspace, "readonly");
    const filePath = path.join(privateDirectory, "value.txt");
    await mkdir(privateDirectory);
    await writeFile(filePath, "checkpoint", "utf8");
    await chmod(privateDirectory, 0o555);
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);
    await chmod(privateDirectory, 0o755);
    await writeFile(filePath, "post-run", "utf8");
    const postRun = await store.inspect(workspace);

    try {
      await store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "readonly-directory",
      });

      expect(await readFile(filePath, "utf8")).toBe("checkpoint");
      expect((await stat(privateDirectory)).mode & 0o777).toBe(0o555);
    } finally {
      // Keep the production assertion above while allowing the fixture root to
      // be removed on non-root POSIX test runners.
      await chmod(privateDirectory, 0o755).catch(() => undefined);
    }
  });

  it("retries capture when content changes between scans", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    await writeFile(filePath, "before", "utf8");
    let changed = false;
    const store = new RecoveryStore(recovery, {
      hooks: {
        afterScanPass: async ({ workspacePath }) => {
          if (!changed && path.resolve(workspacePath) === path.resolve(workspace)) {
            changed = true;
            await writeFile(filePath, "stable", "utf8");
          }
        },
      },
    });

    const snapshot = await store.capture(workspace);
    const entry = snapshot.entries.find((item) => item.path === "value.txt");
    expect(changed).toBe(true);
    expect(entry?.blobHash).toBe(
      "f379ccb92b9116442dc65bdc35648a85d3786b34779db7f704a901fa07b00cb6",
    );
  });

  it("fails capture when the workspace never stabilizes", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    await writeFile(filePath, "aaaa", "utf8");
    let next = "bbbb";
    const store = new RecoveryStore(recovery, {
      maxCaptureAttempts: 2,
      hooks: {
        afterScanPass: async ({ workspacePath }) => {
          if (path.resolve(workspacePath) !== path.resolve(workspace)) return;
          await writeFile(filePath, next, "utf8");
          next = next === "bbbb" ? "aaaa" : "bbbb";
        },
      },
    });

    await expect(store.capture(workspace)).rejects.toBeInstanceOf(WorkspaceUnstableError);
  });

  it("verifies every blob before swapping the workspace", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    await writeFile(filePath, "checkpoint", "utf8");
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);
    const blobHash = checkpoint.entries.find((entry) => entry.kind === "file")?.blobHash as string;
    await writeFile(filePath, "post-run", "utf8");
    const postRun = await store.inspect(workspace);
    await writeFile(
      path.join(recovery, "objects", "sha256", blobHash.slice(0, 2), blobHash),
      "corrupt",
      "utf8",
    );

    await expect(
      store.previewRestore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        paths: ["value.txt"],
      }),
    ).rejects.toBeInstanceOf(RecoveryIntegrityError);
    await expect(
      store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "corrupt-blob",
      }),
    ).rejects.toBeInstanceOf(RecoveryIntegrityError);
    expect(await readFile(filePath, "utf8")).toBe("post-run");
  });

  it("rejects manifest path traversal before writing outside the workspace", async () => {
    const { root, workspace, recovery } = await createFixture();
    await writeFile(path.join(workspace, "value.txt"), "checkpoint", "utf8");
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);
    const malicious: RecoverySnapshot = structuredClone(checkpoint);
    malicious.entries[0] = { ...malicious.entries[0]!, path: "../escape.txt" };

    await expect(
      store.previewRestore({
        workspacePath: workspace,
        snapshot: malicious,
        expectedCurrentRootHash: checkpoint.rootHash,
      }),
    ).rejects.toBeInstanceOf(RecoveryIntegrityError);
    await expect(lstat(path.join(root, "escape.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symbolic links instead of following them", async () => {
    if (process.platform === "win32") return;
    const { root, workspace, recovery } = await createFixture();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(workspace, "link.txt"));
    const store = new RecoveryStore(recovery);

    await expect(store.capture(workspace)).rejects.toMatchObject({
      code: "RECOVERY_UNSUPPORTED_ENTRY",
    });
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("restores executable mode on POSIX", async () => {
    if (process.platform === "win32") return;
    const { workspace, recovery } = await createFixture();
    const executable = path.join(workspace, "run.sh");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);
    await chmod(executable, 0o644);
    const postRun = await store.inspect(workspace);

    await store.restore({
      workspacePath: workspace,
      snapshot: checkpoint,
      expectedCurrentRootHash: postRun.rootHash,
      operationId: "restore-mode",
    });
    expect((await stat(executable)).mode & 0o777).toBe(0o755);
  });

  it("serializes concurrent restores so only one can consume an expected root", async () => {
    const { workspace, recovery } = await createFixture();
    const filePath = path.join(workspace, "value.txt");
    await writeFile(filePath, "checkpoint", "utf8");
    const store = new RecoveryStore(recovery);
    const checkpoint = await store.capture(workspace);
    await writeFile(filePath, "post-run", "utf8");
    const postRun = await store.inspect(workspace);

    const results = await Promise.allSettled([
      store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "concurrent-one",
      }),
      store.restore({
        workspacePath: workspace,
        snapshot: checkpoint,
        expectedCurrentRootHash: postRun.rootHash,
        operationId: "concurrent-two",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "WORKSPACE_CHANGED" },
    });
    expect(await readFile(filePath, "utf8")).toBe("checkpoint");
  });
});
