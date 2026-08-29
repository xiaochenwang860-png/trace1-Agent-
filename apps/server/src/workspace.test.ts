import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffWorkspaceSnapshots, WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Workspace snapshots", () => {
  it("detects created, modified and deleted files while ignoring dependency data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-snapshot-"));
    temporaryDirectories.push(root);
    const workspacePath = path.join(root, "agent");
    await mkdir(path.join(workspacePath, "node_modules"), { recursive: true });
    await writeFile(path.join(workspacePath, "modified.txt"), "before", "utf8");
    await writeFile(path.join(workspacePath, "deleted.txt"), "delete me", "utf8");
    await writeFile(
      path.join(workspacePath, "node_modules", "ignored.js"),
      "ignored",
      "utf8",
    );

    const manager = new WorkspaceManager(root);
    const before = await manager.snapshot(workspacePath);
    await writeFile(path.join(workspacePath, "modified.txt"), "after change", "utf8");
    await rm(path.join(workspacePath, "deleted.txt"));
    await writeFile(path.join(workspacePath, "created.txt"), "new", "utf8");
    const after = await manager.snapshot(workspacePath);

    expect(diffWorkspaceSnapshots(before, after).map(({ path, kind }) => ({
      path,
      kind,
    }))).toEqual([
      { path: "created.txt", kind: "created" },
      { path: "deleted.txt", kind: "deleted" },
      { path: "modified.txt", kind: "modified" },
    ]);
    expect(after.has("node_modules/ignored.js")).toBe(false);
  });
});
