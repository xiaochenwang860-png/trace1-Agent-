import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setRecoveryOperatorToken } from "./api";
import type {
  AgentRun,
  RecoveryFile,
  RecoveryFileKind,
  RecoveryPreview,
  RecoverySelection,
  RestoreOperation,
  RunRecovery,
} from "./types";

interface RecoveryPanelProps {
  run: AgentRun;
  accessMode: "owner" | "developer";
  onRestored: () => void | Promise<void>;
}

interface PreviewContext {
  preview: RecoveryPreview;
  selection: RecoverySelection;
}

const terminalStatuses = new Set<AgentRun["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

const recoveryOperatorSessionKey = "launchpad.recovery-operator-token";

const kindOrder: Record<RecoveryFileKind, number> = {
  deleted: 0,
  modified: 1,
  created: 2,
};

const kindLabels: Record<RecoveryFileKind, string> = {
  deleted: "Deleted during this run",
  modified: "Modified during this run",
  created: "Created during this run",
};

const restoreDescriptions: Record<RecoveryFileKind, string> = {
  deleted: "Recreate from checkpoint",
  modified: "Replace with checkpoint copy",
  created: "Delete the created file",
};

function shortHash(value: string | null): string {
  if (!value) return "missing";
  const normalized = value.startsWith("sha256:") ? value.slice(7) : value;
  return normalized.slice(0, 10);
}

function formatCapturedAt(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? value
    : timestamp.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function previewFromError(error: unknown): RecoveryPreview | null {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== "object") {
    return null;
  }
  const preview = (error.data as { preview?: unknown }).preview;
  if (!preview || typeof preview !== "object" || !("id" in preview)) return null;
  return preview as RecoveryPreview;
}

function operationKey(): string {
  return globalThis.crypto?.randomUUID?.() ??
    "restore-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function readRecoveryOperatorToken(): string {
  try {
    return window.sessionStorage.getItem(recoveryOperatorSessionKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeRecoveryOperatorToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(recoveryOperatorSessionKey, token);
    else window.sessionStorage.removeItem(recoveryOperatorSessionKey);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function RecoveryPanel({ run, accessMode, onRestored }: RecoveryPanelProps) {
  const [recovery, setRecovery] = useState<RunRecovery | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [previewContext, setPreviewContext] = useState<PreviewContext | null>(null);
  const [operation, setOperation] = useState<RestoreOperation | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operatorToken, setOperatorToken] = useState(() =>
    accessMode === "developer" ? readRecoveryOperatorToken() : "",
  );
  const recoveryRequestGeneration = useRef(0);
  const previewRequestGeneration = useRef(0);

  const terminal = terminalStatuses.has(run.status);

  const refreshRecovery = useCallback(async () => {
    const generation = ++recoveryRequestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result =
        accessMode === "developer"
          ? await api.developerRecovery(run.id)
          : await api.recovery(run.id);
      if (generation !== recoveryRequestGeneration.current) return;
      setRecovery(result.recovery);
      setNotFound(false);
    } catch (reason) {
      if (generation !== recoveryRequestGeneration.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        setRecovery(null);
        setNotFound(true);
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (generation === recoveryRequestGeneration.current) {
        setLoading(false);
      }
    }
  }, [accessMode, run.id]);

  useEffect(() => {
    if (accessMode !== "developer") return;
    const normalized = operatorToken.trim();
    setRecoveryOperatorToken(normalized);
    writeRecoveryOperatorToken(normalized);
  }, [accessMode, operatorToken]);

  useEffect(() => {
    setRecovery(null);
    setSelectedPaths(new Set());
    setPreviewContext(null);
    setOperation(null);
    setNotFound(false);
    setError(null);
    if (terminal) void refreshRecovery();
    return () => {
      recoveryRequestGeneration.current += 1;
      previewRequestGeneration.current += 1;
    };
  }, [refreshRecovery, terminal]);

  const files = useMemo(
    () =>
      [...(recovery?.files ?? [])].sort(
        (left, right) =>
          kindOrder[left.kind] - kindOrder[right.kind] ||
          left.path.localeCompare(right.path),
      ),
    [recovery],
  );

  const restorablePaths = useMemo(
    () => files.filter((file) => file.restorable).map((file) => file.path),
    [files],
  );

  const selectedCount = selectedPaths.size;
  const hasOperatorToken = operatorToken.trim().length > 0;
  const canApplyRestore = accessMode === "owner" || hasOperatorToken;
  const allSelected =
    restorablePaths.length > 0 &&
    restorablePaths.every((path) => selectedPaths.has(path));

  const invalidatePreview = () => {
    previewRequestGeneration.current += 1;
    setPreviewing(false);
    setPreviewContext(null);
    setOperation(null);
    setError(null);
  };

  const togglePath = (path: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    invalidatePreview();
  };

  const toggleAll = () => {
    setSelectedPaths(allSelected ? new Set() : new Set(restorablePaths));
    invalidatePreview();
  };

  const previewRestore = async (selection: RecoverySelection) => {
    if (!recovery) return;
    const generation = ++previewRequestGeneration.current;
    setPreviewing(true);
    setPreviewContext(null);
    setOperation(null);
    setError(null);
    try {
      const request = {
        checkpointId: recovery.checkpointId,
        selection,
      };
      const result =
        accessMode === "developer"
          ? await api.developerRecoveryPreview(run.id, request)
          : await api.recoveryPreview(run.id, request);
      if (generation !== previewRequestGeneration.current) return;
      setPreviewContext({ preview: result.preview, selection });
    } catch (reason) {
      if (generation !== previewRequestGeneration.current) return;
      const conflictPreview = previewFromError(reason);
      if (conflictPreview) {
        setPreviewContext({ preview: conflictPreview, selection });
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === previewRequestGeneration.current) {
        setPreviewing(false);
      }
    }
  };

  const restorePreview = async () => {
    const normalizedOperatorToken = operatorToken.trim();
    if (
      !recovery ||
      !previewContext?.preview.canApply ||
      (accessMode === "developer" && !normalizedOperatorToken)
    ) {
      return;
    }
    if (accessMode === "developer") {
      setRecoveryOperatorToken(normalizedOperatorToken);
    }
    setRestoring(true);
    setError(null);
    try {
      const request = {
        checkpointId: recovery.checkpointId,
        previewId: previewContext.preview.id,
        selection: previewContext.selection,
      };
      const idempotencyKey = operationKey();
      const result =
        accessMode === "developer"
          ? await api.developerRecoveryRestore(
              run.id,
              request,
              idempotencyKey,
            )
          : await api.recoveryRestore(run.id, request, idempotencyKey);
      setOperation(result.operation);
      setPreviewContext(null);
      setSelectedPaths(new Set());
      await Promise.all([refreshRecovery(), onRestored()]);
    } catch (reason) {
      const conflictPreview = previewFromError(reason);
      if (conflictPreview) {
        setPreviewContext((current) =>
          current
            ? { ...current, preview: conflictPreview }
            : { preview: conflictPreview, selection: { mode: "all" } },
        );
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRestoring(false);
    }
  };

  if (!terminal || notFound) return null;

  if (loading && !recovery) {
    return (
      <section className="recovery-panel recovery-panel-loading" aria-label="Run recovery">
        <span className="recovery-loading-indicator" aria-hidden="true" />
        <span>Loading recovery point...</span>
      </section>
    );
  }

  if (!recovery) {
    return error ? (
      <section className="recovery-panel" aria-label="Run recovery">
        <div className="recovery-inline-error" role="alert">
          <span>{error}</span>
          <button className="button button-ghost" type="button" onClick={refreshRecovery}>
            Retry
          </button>
        </div>
      </section>
    ) : null;
  }

  const preview = previewContext?.preview ?? null;
  const groupedFiles = (["deleted", "modified", "created"] as const)
    .map((kind) => ({ kind, files: files.filter((file) => file.kind === kind) }))
    .filter((group) => group.files.length > 0);

  return (
    <section className="recovery-panel" aria-labelledby={"recovery-title-" + run.id}>
      <div className="recovery-heading">
        <div>
          <span className="eyebrow">Workspace recovery</span>
          <h4 id={"recovery-title-" + run.id}>Recovery point</h4>
        </div>
        <span className={"recovery-state recovery-state-" + recovery.status}>
          {recovery.status}
        </span>
      </div>

      <div className="recovery-checkpoint-meta">
        <code title={recovery.checkpointId}>
          Checkpoint {shortHash(recovery.checkpointId)}
        </code>
        <span>{formatCapturedAt(recovery.capturedAt)}</span>
        <span title={recovery.currentStateHash}>
          Current state {shortHash(recovery.currentStateHash)}
        </span>
      </div>

      <dl className="recovery-summary" aria-label="Workspace changes">
        <div>
          <dt>Total</dt>
          <dd>{recovery.summary.total}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{recovery.summary.created}</dd>
        </div>
        <div>
          <dt>Modified</dt>
          <dd>{recovery.summary.modified}</dd>
        </div>
        <div>
          <dt>Deleted</dt>
          <dd>{recovery.summary.deleted}</dd>
        </div>
      </dl>

      {files.length === 0 ? (
        <p className="recovery-empty">This run did not change recoverable workspace files.</p>
      ) : (
        <>
          <div className="recovery-selection-toolbar">
            <span>
              {selectedCount === 0
                ? "Select paths to restore"
                : selectedCount + " path" + (selectedCount === 1 ? "" : "s") + " selected"}
            </span>
            <button
              className="recovery-select-toggle"
              type="button"
              onClick={toggleAll}
              disabled={restorablePaths.length === 0 || previewing || restoring}
            >
              {allSelected ? "Clear selection" : "Select all"}
            </button>
          </div>

          <div className="recovery-file-groups">
            {groupedFiles.map((group) => (
              <section className="recovery-file-group" key={group.kind}>
                <h5>
                  {kindLabels[group.kind]}
                  <span>{group.files.length}</span>
                </h5>
                <ul>
                  {group.files.map((file: RecoveryFile) => (
                    <li key={file.path}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedPaths.has(file.path)}
                          disabled={!file.restorable || previewing || restoring}
                          onChange={() => togglePath(file.path)}
                        />
                        <span className="recovery-file-path" title={file.path}>
                          {file.path}
                        </span>
                      </label>
                      <span className={"recovery-file-kind recovery-file-kind-" + file.kind}>
                        {file.kind}
                      </span>
                      <span className="recovery-file-action">
                        {file.restorable
                          ? restoreDescriptions[file.kind]
                          : "Checkpoint content unavailable"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="recovery-actions">
            <button
              className="button button-ghost"
              type="button"
              disabled={selectedCount === 0 || previewing || restoring}
              onClick={() =>
                void previewRestore({
                  mode: "paths",
                  paths: [...selectedPaths].sort(),
                })
              }
            >
              {previewing ? "Checking workspace..." : "Preview selected"}
            </button>
            <button
              className="button button-ghost"
              type="button"
              disabled={restorablePaths.length === 0 || previewing || restoring}
              onClick={() => void previewRestore({ mode: "all" })}
            >
              Preview all changes
            </button>
          </div>
        </>
      )}

      {preview && (
        <section
          className={
            "recovery-preview " +
            (preview.canApply ? "recovery-preview-clean" : "recovery-preview-conflict")
          }
          aria-live="polite"
        >
          <div className="recovery-preview-heading">
            <div>
              <span className="eyebrow">Restore preview</span>
              <h5>
                {preview.canApply
                  ? preview.actions.length +
                    " path" +
                    (preview.actions.length === 1 ? "" : "s") +
                    " ready"
                  : "Restore blocked"}
              </h5>
            </div>
            <span>{preview.canApply ? "No conflicts" : preview.conflicts.length + " conflicts"}</span>
          </div>

          {preview.canApply ? (
            <>
              <ul className="recovery-preview-actions">
                {preview.actions.map((action) => (
                  <li key={action.path}>
                    <span>{action.action}</span>
                    <code title={action.path}>{action.path}</code>
                  </li>
                ))}
              </ul>
              <p>
                A safety snapshot will be captured before these workspace changes are applied.
              </p>
              {accessMode === "developer" && (
                <div className="recovery-operator-auth">
                  <label htmlFor={"recovery-operator-token-" + run.id}>
                    <span>Recovery operator token</span>
                    <input
                      id={"recovery-operator-token-" + run.id}
                      type="password"
                      value={operatorToken}
                      disabled={restoring}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="Required to apply restore"
                      onChange={(event) => setOperatorToken(event.target.value)}
                    />
                  </label>
                  {hasOperatorToken && (
                    <button
                      className="recovery-operator-clear"
                      type="button"
                      disabled={restoring}
                      onClick={() => setOperatorToken("")}
                    >
                      Clear
                    </button>
                  )}
                  <small>
                    Kept only for this browser session and sent only with the restore request.
                  </small>
                </div>
              )}
              <button
                className="button button-danger"
                type="button"
                disabled={
                  restoring || preview.actions.length === 0 || !canApplyRestore
                }
                onClick={() => void restorePreview()}
                title={
                  canApplyRestore ? undefined : "Enter the recovery operator token"
                }
              >
                {restoring
                  ? "Restoring..."
                  : "Restore " +
                    preview.actions.length +
                    " path" +
                    (preview.actions.length === 1 ? "" : "s")}
              </button>
            </>
          ) : (
            <ul className="recovery-conflicts">
              {preview.conflicts.map((conflict) => (
                <li key={conflict.path + conflict.code}>
                  <code>{conflict.path}</code>
                  <span>{conflict.message}</span>
                  <small>
                    Expected {shortHash(conflict.expectedHash)} / Current {shortHash(conflict.actualHash)}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {operation && (
        <div className="recovery-complete" role="status">
          <strong>Workspace restored</strong>
          <span>
            {operation.restoredPaths.length} path
            {operation.restoredPaths.length === 1 ? "" : "s"} restored. Safety snapshot {shortHash(operation.safetySnapshotId)}.
          </span>
        </div>
      )}

      {error && (
        <div className="recovery-inline-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
