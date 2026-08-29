import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export interface WorkspaceFileState {
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

export type WorkspaceSnapshot = Map<string, WorkspaceFileState>;

export interface WorkspaceChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  timestampMs: number;
}

const ignoredDirectories = new Set([".codex", ".git", "dist", "node_modules"]);

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  for (const [filePath, current] of after) {
    const previous = before.get(filePath);
    if (!previous) {
      changes.push({ path: filePath, kind: "created", timestampMs: current.modifiedAtMs });
    } else if (
      previous.size !== current.size ||
      previous.modifiedAtMs !== current.modifiedAtMs ||
      previous.changedAtMs !== current.changedAtMs
    ) {
      changes.push({ path: filePath, kind: "modified", timestampMs: current.modifiedAtMs });
    }
  }
  for (const [filePath] of before) {
    if (!after.has(filePath)) {
      changes.push({ path: filePath, kind: "deleted", timestampMs: Date.now() });
    }
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async snapshot(workspacePath: string): Promise<WorkspaceSnapshot> {
    const snapshot: WorkspaceSnapshot = new Map();
    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        const absolutePath = path.join(directory, entry.name);
        const relativePath = relativeDirectory
          ? path.posix.join(relativeDirectory, entry.name)
          : entry.name;
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath);
        } else if (entry.isFile()) {
          try {
            const file = await stat(absolutePath);
            snapshot.set(relativePath, {
              size: file.size,
              modifiedAtMs: file.mtimeMs,
              changedAtMs: file.ctimeMs,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    };
    await visit(workspacePath, "");
    return snapshot;
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
