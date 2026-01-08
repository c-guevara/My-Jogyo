import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";

import { getRuntimeDir, getSessionDir, getSessionDirByShortId, shortenSessionId } from "../lib/paths";
import { isProcessAlive as isProcessAliveWithStartTime, withLock } from "../lib/session-lock";
import { isPathContainedIn } from "../lib/path-security";
import { getBridgeMetaLockPath, getBridgeMetaLockPathByShortId, DEFAULT_LOCK_TIMEOUT_MS } from "../lib/lock-paths";
import { BridgeMeta, isValidBridgeMeta } from "../lib/bridge-meta";
import { readFileNoFollowSync } from "../lib/atomic-write";

function safeUnlinkSocket(socketPath: string): void {
  try {
    const stat = fs.lstatSync(socketPath);
    if (stat.isSocket()) {
      fs.unlinkSync(socketPath);
    } else {
      console.warn(`[gyoshu-hooks] Refusing to unlink non-socket file: ${socketPath}`);
    }
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') {
      console.warn(`[gyoshu-hooks] lstat failed for ${socketPath}: ${nodeErr.message}`);
    }
  }
}

import {
  loadState,
  saveState,
  hasPromiseTag,
  extractPromiseTags,
  checkBudgets,
  type AutoLoopState,
} from "../lib/auto-loop-state";
import { getBudgetSummary, getPromiseTag } from "../lib/auto-decision";

interface REPLSession {
  sessionId: string;
  pid: number;
  lastActivity: number;
  status: "active" | "idle" | "terminated";
}

const activeSessions = new Map<string, REPLSession>();
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// =============================================================================
// RALPH-LOOP AUTO-CONTINUATION
// =============================================================================

/**
 * Promise tags that indicate terminal conditions for the auto-loop.
 * When any of these are detected, the loop should NOT continue.
 */
const TERMINAL_PROMISE_TAGS = [
  "GYOSHU_AUTO_COMPLETE",
  "GYOSHU_AUTO_BLOCKED",
  "GYOSHU_AUTO_BUDGET_EXHAUSTED",
] as const;

/**
 * Recent output buffer for detecting promise tags.
 * Maps reportTitle to the last output text captured.
 */
const recentOutputBuffer = new Map<string, string>();

/**
 * Active auto-loop sessions being tracked.
 * Maps reportTitle to the loaded AutoLoopState.
 */
const activeAutoLoops = new Map<string, AutoLoopState>();

/**
 * Guard against double-trigger of continuation prompts.
 * Maps reportTitle to timestamp of last injection attempt.
 * Prevents spam when multiple hooks fire for the same cycle.
 */
const injectionInFlight = new Map<string, number>();

/**
 * Minimum interval between injection attempts (ms).
 * Prevents rapid-fire re-injection from multiple hook sources.
 */
const INJECTION_COOLDOWN_MS = 2000;

/**
 * Hash of the last processed output for each reportTitle.
 * Used to gate re-injection on actual output changes, not just idle events.
 */
const lastProcessedOutputHash = new Map<string, string>();

/**
 * Debounce timers for saving state after tool call increments.
 * Prevents excessive disk writes while ensuring persistence.
 */
const saveDebounceTimers = new Map<string, NodeJS.Timeout>();
const SAVE_DEBOUNCE_MS = 1000;

/**
 * Simple hash function for output change detection.
 */
function hashOutput(output: string): string {
  let hash = 0;
  for (let i = 0; i < output.length; i++) {
    const char = output.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Check if output contains any terminal promise tag.
 *
 * @param output - The text output to search
 * @returns True if any terminal promise tag is found
 */
function hasAnyTerminalTag(output: string): boolean {
  return TERMINAL_PROMISE_TAGS.some((tag) => hasPromiseTag(output, tag));
}

/**
 * Build the continuation prompt for auto-loop reinjection.
 *
 * @param state - Current auto-loop state
 * @returns The formatted continuation prompt
 */
function buildContinuationPrompt(state: AutoLoopState): string {
  const budgetSummary = getBudgetSummary(state.budgets);

  return `AUTO-CONTINUATION (Iteration ${state.iteration}/${state.maxIterations})

Previous Decision: ${state.lastDecision ?? "INITIAL"}
Trust Score: ${state.trustScore ?? "N/A"}
Goal Status: ${state.goalGateStatus ?? "PENDING"}
Budget: ${budgetSummary}

Next Objective: ${state.nextObjective || "Continue research toward goal"}

RULES:
- Do NOT ask user what to do
- Do NOT stop until COMPLETE, BLOCKED, or BUDGET_EXHAUSTED
- Emit promise tag when terminal condition reached`;
}

/**
 * Check if auto-loop should continue based on state and output.
 * Returns the continuation prompt if loop should continue, null otherwise.
 * 
 * IMPORTANT: This function is called from multiple hooks. Guards against:
 * - Cooldown-based rate limiting (INJECTION_COOLDOWN_MS)
 * - Output-change gating (only inject on new output)
 *
 * @param reportTitle - The research report title
 * @param output - Recent output to check for promise tags
 * @param client - OpenCode client for sending messages (optional)
 * @returns Object with continuation prompt (or null) and optional budget message
 */
async function checkAutoLoopContinuation(
  reportTitle: string,
  output: string,
  client?: unknown
): Promise<{ prompt: string | null; budgetExhaustedMessage?: string }> {
  const now = Date.now();
  const lastInjection = injectionInFlight.get(reportTitle) ?? 0;
  
  if (now - lastInjection < INJECTION_COOLDOWN_MS) {
    return { prompt: null };
  }

  const outputHash = hashOutput(output);
  const lastHash = lastProcessedOutputHash.get(reportTitle);
  if (lastHash === outputHash && output.length > 0) {
    return { prompt: null };
  }

  if (hasAnyTerminalTag(output)) {
    await deactivateAutoLoop(reportTitle);
    return { prompt: null };
  }

  const state = await loadState(reportTitle);
  if (!state || !state.active) {
    return { prompt: null };
  }

  activeAutoLoops.set(reportTitle, state);

  const budgetCheck = checkBudgets(state);
  if (budgetCheck.exceeded) {
    state.active = false;
    state.lastDecision = "BUDGET_EXHAUSTED";
    await saveState(state);
    activeAutoLoops.delete(reportTitle);
    injectionInFlight.delete(reportTitle);
    lastProcessedOutputHash.delete(reportTitle);
    
    const promiseTag = getPromiseTag("BUDGET_EXHAUSTED", "CYCLES_EXHAUSTED");
    return { 
      prompt: null, 
      budgetExhaustedMessage: `${budgetCheck.reason}\n\n${promiseTag}` 
    };
  }

  lastProcessedOutputHash.set(reportTitle, outputHash);
  injectionInFlight.set(reportTitle, now);

  return { prompt: buildContinuationPrompt(state) };
}

async function deactivateAutoLoop(reportTitle: string): Promise<void> {
  const state = await loadState(reportTitle);
  if (state) {
    state.active = false;
    await saveState(state);
  }
  activeAutoLoops.delete(reportTitle);
  recentOutputBuffer.delete(reportTitle);
  injectionInFlight.delete(reportTitle);
  lastProcessedOutputHash.delete(reportTitle);
  const timer = saveDebounceTimers.get(reportTitle);
  if (timer) {
    clearTimeout(timer);
    saveDebounceTimers.delete(reportTitle);
  }
}

async function incrementToolCalls(reportTitle: string): Promise<void> {
  const state = activeAutoLoops.get(reportTitle);
  if (!state || !state.active) return;
  
  state.budgets.totalToolCalls += 1;
  
  const existingTimer = saveDebounceTimers.get(reportTitle);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  
  const timer = setTimeout(async () => {
    saveDebounceTimers.delete(reportTitle);
    const currentState = activeAutoLoops.get(reportTitle);
    if (currentState) {
      await saveState(currentState);
    }
  }, SAVE_DEBOUNCE_MS);
  
  saveDebounceTimers.set(reportTitle, timer);
}

async function trySendContinuationPrompt(
  client: unknown,
  prompt: string
): Promise<boolean> {
  try {
    const c = client as { message?: { send?: (msg: string) => Promise<void> } };
    if (c?.message?.send) {
      await c.message.send(prompt);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function onSuccessfulContinuationSend(reportTitle: string): Promise<void> {
  const state = activeAutoLoops.get(reportTitle);
  if (!state || !state.active) return;
  
  state.iteration += 1;
  state.budgets.currentCycle += 1;
  
  await saveState(state);
}

export function registerAutoLoop(state: AutoLoopState): void {
  if (state.active) {
    activeAutoLoops.set(state.reportTitle, state);
  }
}

export function unregisterAutoLoop(reportTitle: string): void {
  activeAutoLoops.delete(reportTitle);
  recentOutputBuffer.delete(reportTitle);
}

export function isAutoLoopActive(reportTitle: string): boolean {
  return activeAutoLoops.has(reportTitle);
}

export async function refreshAutoLoopState(reportTitle: string): Promise<void> {
  const state = await loadState(reportTitle);
  if (state?.active) {
    activeAutoLoops.set(reportTitle, state);
  } else {
    activeAutoLoops.delete(reportTitle);
  }
}

function getBridgeMetaPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "bridge_meta.json");
}

function getBridgeMetaPathByShortId(shortId: string): string {
  return path.join(getSessionDirByShortId(shortId), "bridge_meta.json");
}

function readBridgeMeta(sessionId: string): BridgeMeta | null {
  try {
    const metaPath = getBridgeMetaPath(sessionId);
    if (!fs.existsSync(metaPath)) return null;
    const parsed = JSON.parse(readFileNoFollowSync(metaPath));
    if (!isValidBridgeMeta(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readBridgeMetaByShortId(shortId: string): BridgeMeta | null {
  try {
    const metaPath = getBridgeMetaPathByShortId(shortId);
    if (!fs.existsSync(metaPath)) return null;
    const parsed = JSON.parse(readFileNoFollowSync(metaPath));
    if (!isValidBridgeMeta(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verifyProcessIdentity(meta: BridgeMeta): Promise<boolean> {
  // Fail-closed: if we don't have processStartTime, we can't verify identity
  if (meta.processStartTime === undefined) {
    return false;
  }
  return await isProcessAliveWithStartTime(meta.pid, meta.processStartTime);
}

async function deleteMetaWithLock(metaPath: string, lockPath: string): Promise<void> {
  try {
    await withLock(
      lockPath,
      async () => {
        if (fs.existsSync(metaPath)) {
          fs.unlinkSync(metaPath);
        }
      },
      DEFAULT_LOCK_TIMEOUT_MS
    );
  } catch {
    // Ignore errors during cleanup (lock timeout or unlink failure)
  }
}

async function killBridge(sessionId: string): Promise<void> {
  const meta = readBridgeMeta(sessionId);
  if (!meta) return;
  
  const metaPath = getBridgeMetaPath(sessionId);
  const lockPath = getBridgeMetaLockPath(sessionId);
  
  if (meta.sessionId !== sessionId) {
    console.warn(`[gyoshu-hooks] Session ID mismatch in killBridge: expected ${sessionId}, got ${meta.sessionId}`);
    await deleteMetaWithLock(metaPath, lockPath);
    return;
  }
  
  if (!(await verifyProcessIdentity(meta))) {
    await deleteMetaWithLock(metaPath, lockPath);
    return;
  }
  
  try {
    process.kill(meta.pid, "SIGTERM");
  } catch {}
  
  const sessionDir = getSessionDir(sessionId);
  await deleteMetaWithLock(metaPath, lockPath);
  try {
    if (meta.socketPath && isPathContainedIn(meta.socketPath, sessionDir, { useRealpath: true })) {
      safeUnlinkSocket(meta.socketPath);
    }
  } catch {}
}

async function killBridgeByShortId(shortId: string): Promise<void> {
  const meta = readBridgeMetaByShortId(shortId);
  if (!meta) return;
  
  const metaPath = getBridgeMetaPathByShortId(shortId);
  const lockPath = getBridgeMetaLockPathByShortId(shortId);
  
  if (shortenSessionId(meta.sessionId) !== shortId) {
    console.warn(`[gyoshu-hooks] Binding mismatch in killBridgeByShortId: expected ${shortId}, got ${shortenSessionId(meta.sessionId)}`);
    await deleteMetaWithLock(metaPath, lockPath);
    return;
  }
  
  if (!(await verifyProcessIdentity(meta))) {
    await deleteMetaWithLock(metaPath, lockPath);
    return;
  }
  
  try {
    process.kill(meta.pid, "SIGTERM");
  } catch {}
  
  const sessionDir = getSessionDirByShortId(shortId);
  await deleteMetaWithLock(metaPath, lockPath);
  try {
    if (meta.socketPath && isPathContainedIn(meta.socketPath, sessionDir, { useRealpath: true })) {
      safeUnlinkSocket(meta.socketPath);
    }
  } catch {}
}

/**
 * Pattern for valid session directory names (12-char lowercase hex)
 * Used to filter cleanup to only valid session directories, avoiding locks/ etc.
 */
const SESSION_DIR_PATTERN = /^[0-9a-f]{12}$/;

async function cleanupAllBridges(): Promise<void> {
  const runtimeDir = getRuntimeDir();
  if (!fs.existsSync(runtimeDir)) return;
  
  try {
    const entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
    const validSessionDirs = entries.filter(
      (entry) => entry.isDirectory() && SESSION_DIR_PATTERN.test(entry.name)
    );
    for (const entry of validSessionDirs) {
      await killBridgeByShortId(entry.name);
    }
  } catch {
    // Silent cleanup - errors are non-fatal
  }
}

async function killIdleBridges(): Promise<void> {
  if (activeAutoLoops.size > 0) {
    return;
  }
  
  const now = Date.now();
  
  for (const [sessionId, session] of activeSessions) {
    if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
      const meta = readBridgeMeta(sessionId);
      if (meta && await verifyProcessIdentity(meta)) {
        await killBridge(sessionId);
        session.status = "terminated";
      }
    }
  }
}

let idleCheckInterval: NodeJS.Timeout | null = null;

export const GyoshuPlugin: Plugin = async ({ client }) => {
  idleCheckInterval = setInterval(killIdleBridges, IDLE_CHECK_INTERVAL_MS);
  
  return {
    "tool.execute.after": async (input, output) => {
      const args = (input as { args?: Record<string, unknown> }).args;
      
      const toolReportTitle = extractReportTitleFromArgs(args);
      if (toolReportTitle && activeAutoLoops.has(toolReportTitle)) {
        await incrementToolCalls(toolReportTitle);
      }
      
      if (input.tool === "python-repl") {
        const sessionId = args?.researchSessionID as string | undefined;
        if (sessionId) {
          const meta = readBridgeMeta(sessionId);
          const existing = activeSessions.get(sessionId);
          
          if (existing) {
            existing.lastActivity = Date.now();
            existing.status = "active";
            if (meta) existing.pid = meta.pid;
          } else {
            activeSessions.set(sessionId, {
              sessionId,
              pid: meta?.pid || 0,
              lastActivity: Date.now(),
              status: "active",
            });
          }
        }
      }
      
      if (input.tool === "gyoshu-completion") {
        const reportTitle = args?.reportTitle as string | undefined;
        const outputText = typeof output === "string" ? output : JSON.stringify(output);
        if (reportTitle) {
          recentOutputBuffer.set(reportTitle, outputText);
        }
      }
      
      if (input.tool === "session-manager" || input.tool === "research-manager") {
        const data = args?.data as Record<string, unknown> | undefined;
        const reportTitle = (args?.reportTitle || data?.reportTitle) as string | undefined;
        if (reportTitle) {
          await refreshAutoLoopState(reportTitle);
        }
      }
    },
    
    "agent.after": async ({ output }) => {
      const outputText = typeof output === "string" ? output : "";
      
      const extractedTags = extractPromiseTags(outputText);
      for (const tag of extractedTags) {
        if (TERMINAL_PROMISE_TAGS.includes(tag as typeof TERMINAL_PROMISE_TAGS[number])) {
          const matchedReportTitles = findReportTitlesInOutput(outputText);
          if (matchedReportTitles.length > 0) {
            for (const reportTitle of matchedReportTitles) {
              await deactivateAutoLoop(reportTitle);
            }
          }
          return;
        }
      }
      
      for (const [reportTitle] of activeAutoLoops) {
        const bufferedOutput = recentOutputBuffer.get(reportTitle) || "";
        const combinedOutput = bufferedOutput + outputText;
        
        const result = await checkAutoLoopContinuation(reportTitle, combinedOutput, client);
        
        if (result.budgetExhaustedMessage) {
          const sent = await trySendContinuationPrompt(client, result.budgetExhaustedMessage);
          if (sent) {
            await onSuccessfulContinuationSend(reportTitle);
          }
        } else if (result.prompt) {
          const sent = await trySendContinuationPrompt(client, result.prompt);
          if (sent) {
            await onSuccessfulContinuationSend(reportTitle);
          }
        }
        
        recentOutputBuffer.delete(reportTitle);
      }
    },
    
    event: async ({ event }) => {
      const eventType = event.type as string;
      
      if (eventType === "session.end" || eventType === "session.disposed") {
        cleanupAllBridges();
        activeAutoLoops.clear();
        recentOutputBuffer.clear();
        injectionInFlight.clear();
        lastProcessedOutputHash.clear();
        for (const timer of saveDebounceTimers.values()) {
          clearTimeout(timer);
        }
        saveDebounceTimers.clear();
      }
      
      if (eventType === "agent.idle" || eventType === "message.completed") {
        for (const [reportTitle] of activeAutoLoops) {
          const bufferedOutput = recentOutputBuffer.get(reportTitle) || "";
          
          const result = await checkAutoLoopContinuation(reportTitle, bufferedOutput, client);
          
          if (result.budgetExhaustedMessage) {
            const sent = await trySendContinuationPrompt(client, result.budgetExhaustedMessage);
            if (sent) {
              await onSuccessfulContinuationSend(reportTitle);
            }
          } else if (result.prompt) {
            const sent = await trySendContinuationPrompt(client, result.prompt);
            if (sent) {
              await onSuccessfulContinuationSend(reportTitle);
            }
          }
        }
      }
    },
    
    cleanup: async () => {
      if (idleCheckInterval) {
        clearInterval(idleCheckInterval);
        idleCheckInterval = null;
      }
      
      cleanupAllBridges();
      activeSessions.clear();
      activeAutoLoops.clear();
      recentOutputBuffer.clear();
      injectionInFlight.clear();
      lastProcessedOutputHash.clear();
      for (const timer of saveDebounceTimers.values()) {
        clearTimeout(timer);
      }
      saveDebounceTimers.clear();
    },
  };
};

function findReportTitlesInOutput(output: string): string[] {
  const matched: string[] = [];
  for (const [reportTitle] of activeAutoLoops) {
    if (output.includes(reportTitle)) {
      matched.push(reportTitle);
    }
  }
  return matched;
}

function extractReportTitleFromArgs(args?: Record<string, unknown>): string | null {
  if (!args) return null;
  
  if (typeof args.reportTitle === "string") {
    return args.reportTitle;
  }
  
  const data = args.data as Record<string, unknown> | undefined;
  if (data && typeof data.reportTitle === "string") {
    return data.reportTitle;
  }
  
  if (typeof args.researchSessionID === "string") {
    for (const [reportTitle, state] of activeAutoLoops) {
      if (state.researchSessionID === args.researchSessionID) {
        return reportTitle;
      }
    }
  }
  
  return null;
}

export default GyoshuPlugin;
