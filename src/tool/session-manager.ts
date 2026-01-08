/**
 * Session Manager - OpenCode tool for managing Gyoshu runtime sessions
 *
 * Provides runtime-only session management with:
 * - Session locking (acquire/release)
 * - Bridge socket paths
 * - Bridge metadata storage (runtime state only)
 *
 * Note: Durable research data is now stored in notebook frontmatter.
 * This tool only manages ephemeral runtime state in OS temp directories
 * (see paths.ts getRuntimeDir() for resolution order).
 *
 * @module session-manager
 */

import { tool } from "@opencode-ai/plugin";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { durableAtomicWrite, fileExists, readFile } from "../lib/atomic-write";
import {
  getRuntimeDir,
  getSessionDir,
  ensureDirSync,
  existsSync,
  shortenSessionId,
  validatePathSegment,
} from "../lib/paths";
import { getBridgeMetaLockPath, DEFAULT_LOCK_TIMEOUT_MS } from "../lib/lock-paths";
import { withLock } from "../lib/session-lock";
import {
  BridgeMeta,
  PythonEnvInfo,
  VerificationRound,
  VerificationState,
  isValidBridgeMeta,
} from "../lib/bridge-meta";
import { isPathContainedIn } from "../lib/path-security";

// ===== CONSTANTS =====

/**
 * Name of the bridge metadata file (runtime state only)
 */
const BRIDGE_META_FILE = "bridge_meta.json";

/**
 * Name of the session lock file
 */
const SESSION_LOCK_FILE = "session.lock";

/**
 * Regex pattern for valid session directory names.
 * Session directories are 12-char hex hashes from shortenSessionId().
 * Used to filter out non-session directories like "locks/".
 */
const SESSION_DIR_PATTERN = /^[0-9a-f]{12}$/;

// ===== TYPES =====
// BridgeMeta, PythonEnvInfo, VerificationRound, VerificationState
// are imported from ../lib/bridge-meta.ts (centralized definitions)

// ===== RUNTIME INITIALIZATION =====

/**
 * Ensures the runtime directory exists.
 * Runtime is now in OS temp directories, no .gitignore needed.
 */
async function ensureGyoshuRuntime(): Promise<void> {
  const runtimeDir = getRuntimeDir();
  ensureDirSync(runtimeDir, 0o700);
}

/**
 * Synchronous version for initialization in execute()
 */
function ensureGyoshuRuntimeSync(): void {
  const runtimeDir = getRuntimeDir();
  ensureDirSync(runtimeDir);
}

// ===== PATH HELPERS =====

/**
 * Gets the path to a session's bridge metadata file.
 *
 * @param sessionId - The session identifier
 * @returns Full path to bridge_meta.json
 */
function getBridgeMetaPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), BRIDGE_META_FILE);
}

/**
 * Gets the path to a session's lock file.
 *
 * @param sessionId - The session identifier
 * @returns Full path to session.lock
 */
function getSessionLockFilePath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), SESSION_LOCK_FILE);
}

// ===== VALIDATION =====

/** Maximum number of verification history entries to keep */
const MAX_VERIFICATION_HISTORY = 10;

/** Valid outcomes for verification rounds */
const VALID_OUTCOMES = ["passed", "failed", "rework_requested"] as const;

/**
 * Validates a VerificationRound object.
 *
 * @param round - The verification round to validate
 * @param index - Index in history array (for error messages)
 * @returns Error message if invalid, null if valid
 */
function validateVerificationRound(
  round: unknown,
  index: number
): string | null {
  if (!round || typeof round !== "object") {
    return `history[${index}] is not an object`;
  }

  const r = round as Record<string, unknown>;

  // Validate round number
  if (typeof r.round !== "number" || !Number.isInteger(r.round) || r.round < 1) {
    return `history[${index}].round must be a positive integer`;
  }

  // Validate timestamp
  if (typeof r.timestamp !== "string" || r.timestamp.trim() === "") {
    return `history[${index}].timestamp must be a non-empty string`;
  }

  // Validate trustScore (0-100)
  if (
    typeof r.trustScore !== "number" ||
    r.trustScore < 0 ||
    r.trustScore > 100
  ) {
    return `history[${index}].trustScore must be a number between 0 and 100`;
  }

  // Validate outcome
  if (!VALID_OUTCOMES.includes(r.outcome as typeof VALID_OUTCOMES[number])) {
    return `history[${index}].outcome must be one of: ${VALID_OUTCOMES.join(", ")}`;
  }

  return null;
}

/**
 * Validates a VerificationState object.
 *
 * @param state - The verification state to validate
 * @returns Error message if invalid, null if valid
 */
function validateVerificationState(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return "verification must be an object";
  }

  const s = state as Record<string, unknown>;

  // Validate currentRound (non-negative integer)
  if (
    typeof s.currentRound !== "number" ||
    !Number.isInteger(s.currentRound) ||
    s.currentRound < 0
  ) {
    return "currentRound must be a non-negative integer";
  }

  // Validate maxRounds (positive integer >= 1)
  if (
    typeof s.maxRounds !== "number" ||
    !Number.isInteger(s.maxRounds) ||
    s.maxRounds < 1
  ) {
    return "maxRounds must be a positive integer >= 1";
  }

  // Validate currentRound <= maxRounds
  if (s.currentRound > s.maxRounds) {
    return `currentRound (${s.currentRound}) cannot exceed maxRounds (${s.maxRounds})`;
  }

  // Validate history is an array
  if (!Array.isArray(s.history)) {
    return "history must be an array";
  }

  // Validate each history entry
  for (let i = 0; i < s.history.length; i++) {
    const error = validateVerificationRound(s.history[i], i);
    if (error) {
      return error;
    }
  }

  return null;
}

function validateSessionId(sessionId: string): void {
  validatePathSegment(sessionId, "researchSessionID");
}

// ===== DEFAULT BRIDGE META =====

function createDefaultBridgeMeta(
  sessionId: string,
  data?: Partial<BridgeMeta>
): BridgeMeta {
  const now = new Date().toISOString();
  const sessionDir = getSessionDir(sessionId);
  const socketPath = path.join(sessionDir, "bridge.sock");

  return {
    pid: 1,
    socketPath,
    sessionId,
    bridgeStarted: now,
    pythonEnv: {
      type: "unknown",
      pythonPath: "",
    },
    notebookPath: "",
    reportTitle: "",
    ...data,
  };
}

// ===== TOOL DEFINITION =====

export default tool({
  description:
    "Manage Gyoshu runtime sessions - create, read, update, delete session state. " +
    "Sessions track bridge metadata, notebook paths, and runtime state. " +
    "Research data is now stored in notebook frontmatter (not session manifests).",
  args: {
    action: tool.schema
      .enum(["create", "get", "list", "update", "delete"])
      .describe("Operation to perform on runtime sessions"),
    researchSessionID: tool.schema
      .string()
      .optional()
      .describe("Unique session identifier (required for create/get/update/delete)"),
    data: tool.schema
      .any()
      .optional()
      .describe(
        "Bridge metadata for create/update operations. Can include: " +
        "pythonEnv (type, pythonPath), notebookPath, reportTitle, " +
        "verification (currentRound, maxRounds, history)"
      ),
  },

  async execute(args) {
    ensureGyoshuRuntimeSync();

    switch (args.action) {
      // ===== CREATE =====
      case "create": {
        if (!args.researchSessionID) {
          throw new Error("researchSessionID is required for create action");
        }
        validateSessionId(args.researchSessionID);

        const sessionDir = getSessionDir(args.researchSessionID);
        const bridgeMetaPath = getBridgeMetaPath(args.researchSessionID);

        if (await fileExists(bridgeMetaPath)) {
          throw new Error(
            `Session '${args.researchSessionID}' already exists. Use 'update' to modify existing sessions.`
          );
        }

        ensureDirSync(sessionDir, 0o700);

        const bridgeMeta = createDefaultBridgeMeta(
          args.researchSessionID,
          args.data as Partial<BridgeMeta>
        );

        await withLock(
          getBridgeMetaLockPath(args.researchSessionID),
          async () => {
            await durableAtomicWrite(bridgeMetaPath, JSON.stringify(bridgeMeta, null, 2));
          },
          DEFAULT_LOCK_TIMEOUT_MS
        );

        return JSON.stringify(
          {
            success: true,
            action: "create",
            researchSessionID: args.researchSessionID,
            bridgeMeta,
            sessionDir,
          },
          null,
          2
        );
      }

      // ===== GET =====
      case "get": {
        if (!args.researchSessionID) {
          throw new Error("researchSessionID is required for get action");
        }
        validateSessionId(args.researchSessionID);

        const bridgeMetaPath = getBridgeMetaPath(args.researchSessionID);
        const sessionDir = getSessionDir(args.researchSessionID);
        const lockPath = getSessionLockFilePath(args.researchSessionID);

        if (!(await fileExists(bridgeMetaPath))) {
          throw new Error(`Session '${args.researchSessionID}' not found`);
        }

        const rawMeta = await readFile<unknown>(bridgeMetaPath, true);
        if (!isValidBridgeMeta(rawMeta)) {
          throw new Error(`Session '${args.researchSessionID}' has invalid or corrupted metadata`);
        }
        const bridgeMeta = rawMeta as BridgeMeta;
        const isLocked = await fileExists(lockPath);

        return JSON.stringify(
          {
            success: true,
            action: "get",
            researchSessionID: args.researchSessionID,
            bridgeMeta,
            sessionDir,
            isLocked,
          },
          null,
          2
        );
      }

      // ===== LIST =====
      case "list": {
        const sessions: Array<{
          researchSessionID: string;
          bridgeStarted: string;
          notebookPath: string;
          reportTitle: string;
          isLocked: boolean;
        }> = [];

        const runtimeDir = getRuntimeDir();

        let entries: Array<{ name: string; isDirectory: () => boolean }>;
        try {
          entries = await fs.readdir(runtimeDir, { withFileTypes: true });
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return JSON.stringify(
              {
                success: true,
                action: "list",
                sessions: [],
                count: 0,
              },
              null,
              2
            );
          }
          throw err;
        }

        // Filter to valid session directories only (12-char hex hashes)
        const validEntries = entries.filter(
          (entry) => entry.isDirectory() && SESSION_DIR_PATTERN.test(entry.name)
        );

        for (const entry of validEntries) {
          const bridgeMetaPath = path.join(runtimeDir, entry.name, BRIDGE_META_FILE);
          const lockPath = path.join(runtimeDir, entry.name, SESSION_LOCK_FILE);

          try {
            const rawMeta = await readFile<unknown>(bridgeMetaPath, true);
            
            if (!isValidBridgeMeta(rawMeta)) {
              process.env.GYOSHU_DEBUG && console.error(`[session-manager] Invalid metadata for ${entry.name}, skipping`);
              continue;
            }
            const bridgeMeta = rawMeta as BridgeMeta;

            // Verify anti-poisoning binding: shortId must match hashed sessionId
            if (shortenSessionId(bridgeMeta.sessionId) !== entry.name) {
              process.env.GYOSHU_DEBUG && console.error(`[session-manager] Binding mismatch for ${entry.name}, skipping`);
              continue;
            }

            const isLocked = existsSync(lockPath);

            sessions.push({
              researchSessionID: bridgeMeta.sessionId,
              bridgeStarted: bridgeMeta.bridgeStarted ?? bridgeMeta.startedAt ?? "",
              notebookPath: bridgeMeta.notebookPath ?? "",
              reportTitle: bridgeMeta.reportTitle ?? "",
              isLocked,
            });
          } catch (error) {
            process.env.GYOSHU_DEBUG && console.error(`[session-manager] Failed to read session ${entry.name}:`, error);
          }
        }

        sessions.sort(
          (a, b) =>
            new Date(b.bridgeStarted).getTime() - new Date(a.bridgeStarted).getTime()
        );

        return JSON.stringify(
          {
            success: true,
            action: "list",
            sessions,
            count: sessions.length,
          },
          null,
          2
        );
      }

      // ===== UPDATE =====
      case "update": {
        if (!args.researchSessionID) {
          throw new Error("researchSessionID is required for update action");
        }
        validateSessionId(args.researchSessionID);

        const bridgeMetaPath = getBridgeMetaPath(args.researchSessionID);

        if (!(await fileExists(bridgeMetaPath))) {
          throw new Error(
            `Session '${args.researchSessionID}' not found. Use 'create' first.`
          );
        }

        const updateData = args.data as Partial<BridgeMeta> | undefined;

        let sanitizedVerification: VerificationState | undefined = undefined;
        if (updateData?.verification !== undefined) {
          const validationError = validateVerificationState(updateData.verification);
          if (validationError) {
            throw new Error(`Invalid verification state: ${validationError}`);
          }
          const verif = updateData.verification as VerificationState;
          sanitizedVerification = {
            ...verif,
            history: verif.history.slice(-MAX_VERIFICATION_HISTORY),
          };
        }

        const updated = await withLock(
          getBridgeMetaLockPath(args.researchSessionID),
          async () => {
            const existing = await readFile<BridgeMeta>(bridgeMetaPath, true);

            const result: BridgeMeta = {
              ...existing,
              ...(updateData?.notebookPath !== undefined && {
                notebookPath: updateData.notebookPath,
              }),
              ...(updateData?.reportTitle !== undefined && {
                reportTitle: updateData.reportTitle,
              }),
              ...(sanitizedVerification !== undefined && {
                verification: sanitizedVerification,
              }),
              sessionId: existing.sessionId,
              bridgeStarted: existing.bridgeStarted,
            };

            if (updateData?.pythonEnv) {
              result.pythonEnv = {
                ...existing.pythonEnv,
                ...updateData.pythonEnv,
              };
            }

            await durableAtomicWrite(bridgeMetaPath, JSON.stringify(result, null, 2));
            return result;
          },
          DEFAULT_LOCK_TIMEOUT_MS
        );

        return JSON.stringify(
          {
            success: true,
            action: "update",
            researchSessionID: args.researchSessionID,
            bridgeMeta: updated,
          },
          null,
          2
        );
      }

      // ===== DELETE =====
      case "delete": {
        if (!args.researchSessionID) {
          throw new Error("researchSessionID is required for delete action");
        }
        validateSessionId(args.researchSessionID);

        const sessionDir = getSessionDir(args.researchSessionID);

        if (!(await fileExists(sessionDir))) {
          throw new Error(`Session '${args.researchSessionID}' not found`);
        }

        // Security: Verify path is contained within runtime directory before deletion
        if (!isPathContainedIn(sessionDir, getRuntimeDir(), { useRealpath: true })) {
          throw new Error(`Security: ${sessionDir} escapes containment`);
        }

        await fs.rm(sessionDir, { recursive: true, force: true });

        return JSON.stringify(
          {
            success: true,
            action: "delete",
            researchSessionID: args.researchSessionID,
            message: `Session '${args.researchSessionID}' and all runtime data deleted`,
          },
          null,
          2
        );
      }

      default:
        throw new Error(`Unknown action: ${args.action}`);
    }
  },
});
