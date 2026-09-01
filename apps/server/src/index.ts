import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { GitClient, resolveGitExecutable } from "./git-client.js";
import { GitRecoveryRepository } from "./git-recovery-repository.js";
import { RecoveryStore } from "./recovery-store.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const gitClient = new GitClient({
  gitBin: resolveGitExecutable(config.gitBin),
  timeoutMs: config.gitTimeoutMs,
  maxOutputBytes: config.gitMaxOutputBytes,
});
const gitRecoveryRepository = new GitRecoveryRepository(
  path.join(config.dataDirectory, "recovery"),
  gitClient,
);
const recoveryStore = new RecoveryStore(
  path.join(config.dataDirectory, "recovery"),
  { gitRepository: gitRecoveryRepository },
);
const service = new AgentService(config, store, workspaces, runner, recoveryStore);
await service.initialize();

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
