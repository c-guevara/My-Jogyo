import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import {
  getLocksDir,
  getNotebookLockPath,
  getReportLockPath,
  getQueueLockPath,
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_ORDER,
} from "../src/lib/lock-paths";
import { getRuntimeDir, clearRuntimeDirCache } from "../src/lib/paths";

describe("lock-paths", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearRuntimeDirCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    clearRuntimeDirCache();
  });

  describe("getLocksDir", () => {
    test("returns path within runtime directory", () => {
      const locksDir = getLocksDir();
      const runtimeDir = getRuntimeDir();
      expect(locksDir).toStartWith(runtimeDir);
      expect(locksDir).toEndWith("locks");
    });

    test("returns consistent path for same environment", () => {
      const first = getLocksDir();
      const second = getLocksDir();
      expect(first).toBe(second);
    });
  });

  describe("getNotebookLockPath", () => {
    test("returns path with .lock extension", () => {
      const lockPath = getNotebookLockPath("test-research");
      expect(lockPath).toEndWith(".lock");
    });

    test("returns path within notebook subdirectory", () => {
      const lockPath = getNotebookLockPath("test-research");
      expect(lockPath).toContain("/notebook/");
    });

    test("returns path within runtime directory", () => {
      const lockPath = getNotebookLockPath("test-research");
      const runtimeDir = getRuntimeDir();
      expect(lockPath).toStartWith(runtimeDir);
    });

    test("uses short ID (12 chars) for long titles", () => {
      const longTitle = "very-long-research-title-that-exceeds-normal-length-limits-by-far";
      const lockPath = getNotebookLockPath(longTitle);
      const filename = path.basename(lockPath, ".lock");
      
      expect(filename.length).toBe(12);
    });

    test("produces consistent IDs regardless of title length", () => {
      const shortTitle = "a";
      const longTitle = "very-long-research-title-that-exceeds-normal-length-limits-by-far";
      
      const shortPath = getNotebookLockPath(shortTitle);
      const longPath = getNotebookLockPath(longTitle);
      
      const shortFilename = path.basename(shortPath, ".lock");
      const longFilename = path.basename(longPath, ".lock");
      
      expect(shortFilename.length).toBeLessThanOrEqual(12);
      expect(longFilename.length).toBe(12);
    });

    test("returns different paths for different titles", () => {
      const path1 = getNotebookLockPath("research-one");
      const path2 = getNotebookLockPath("research-two");
      expect(path1).not.toBe(path2);
    });

    test("returns consistent path for same title", () => {
      const first = getNotebookLockPath("test-research");
      const second = getNotebookLockPath("test-research");
      expect(first).toBe(second);
    });
  });

  describe("getReportLockPath", () => {
    test("returns path with .lock extension", () => {
      const lockPath = getReportLockPath("test-research");
      expect(lockPath).toEndWith(".lock");
    });

    test("returns path within report subdirectory", () => {
      const lockPath = getReportLockPath("test-research");
      expect(lockPath).toContain("/report/");
    });

    test("returns path within runtime directory", () => {
      const lockPath = getReportLockPath("test-research");
      const runtimeDir = getRuntimeDir();
      expect(lockPath).toStartWith(runtimeDir);
    });

    test("uses short ID for consistent path length", () => {
      const longTitle = "extremely-long-research-title-for-testing-path-length";
      const lockPath = getReportLockPath(longTitle);
      const filename = path.basename(lockPath, ".lock");
      expect(filename.length).toBe(12);
    });

    test("returns different path than notebook lock for same title", () => {
      const title = "same-research";
      const notebookLock = getNotebookLockPath(title);
      const reportLock = getReportLockPath(title);
      expect(notebookLock).not.toBe(reportLock);
    });
  });

  describe("getQueueLockPath", () => {
    test("returns path with .lock extension", () => {
      const lockPath = getQueueLockPath("test-research", "run-001");
      expect(lockPath).toEndWith(".lock");
    });

    test("returns path within queue subdirectory", () => {
      const lockPath = getQueueLockPath("test-research", "run-001");
      expect(lockPath).toContain("/queue/");
    });

    test("returns path within runtime directory", () => {
      const lockPath = getQueueLockPath("test-research", "run-001");
      const runtimeDir = getRuntimeDir();
      expect(lockPath).toStartWith(runtimeDir);
    });

    test("uses short ID for consistent path length", () => {
      const longTitle = "very-long-research-title";
      const longRunId = "run-with-very-long-identifier-001";
      const lockPath = getQueueLockPath(longTitle, longRunId);
      const filename = path.basename(lockPath, ".lock");
      expect(filename.length).toBe(12);
    });

    test("returns different paths for different runIds", () => {
      const path1 = getQueueLockPath("research", "run-001");
      const path2 = getQueueLockPath("research", "run-002");
      expect(path1).not.toBe(path2);
    });

    test("returns different paths for different reportTitles", () => {
      const path1 = getQueueLockPath("research-one", "run-001");
      const path2 = getQueueLockPath("research-two", "run-001");
      expect(path1).not.toBe(path2);
    });

    test("returns different path than notebook and report locks", () => {
      const title = "same-research";
      const notebookLock = getNotebookLockPath(title);
      const reportLock = getReportLockPath(title);
      const queueLock = getQueueLockPath(title, "run-001");
      
      expect(queueLock).not.toBe(notebookLock);
      expect(queueLock).not.toBe(reportLock);
    });
  });

  describe("lock path uniqueness", () => {
    test("different lock types produce different paths for same identifier", () => {
      const title = "same-title";
      const runId = "run-001";
      
      const notebook = getNotebookLockPath(title);
      const report = getReportLockPath(title);
      const queue = getQueueLockPath(title, runId);
      
      const allPaths = [notebook, report, queue];
      const uniquePaths = new Set(allPaths);
      
      expect(uniquePaths.size).toBe(3);
    });

    test("lock IDs are hex strings", () => {
      const lockPath = getNotebookLockPath("test-research");
      const filename = path.basename(lockPath, ".lock");
      expect(filename).toMatch(/^[a-f0-9]{12}$/);
    });
  });

  describe("DEFAULT_LOCK_TIMEOUT_MS", () => {
    test("is 30 seconds", () => {
      expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(30000);
    });
  });

  describe("LOCK_ORDER", () => {
    test("QUEUE has lowest priority number (acquired first)", () => {
      expect(LOCK_ORDER.QUEUE).toBe(1);
    });

    test("NOTEBOOK has middle priority number", () => {
      expect(LOCK_ORDER.NOTEBOOK).toBe(2);
    });

    test("REPORT has highest priority number (acquired last)", () => {
      expect(LOCK_ORDER.REPORT).toBe(3);
    });

    test("ordering is QUEUE < NOTEBOOK < REPORT", () => {
      expect(LOCK_ORDER.QUEUE).toBeLessThan(LOCK_ORDER.NOTEBOOK);
      expect(LOCK_ORDER.NOTEBOOK).toBeLessThan(LOCK_ORDER.REPORT);
    });
  });

  describe("path safety", () => {
    test("paths do not contain project directory", () => {
      const projectDir = process.cwd();
      const notebookPath = getNotebookLockPath("test");
      const reportPath = getReportLockPath("test");
      const queuePath = getQueueLockPath("test", "run");
      
      if (!process.env.GYOSHU_RUNTIME_DIR) {
        expect(notebookPath).not.toContain(projectDir);
        expect(reportPath).not.toContain(projectDir);
        expect(queuePath).not.toContain(projectDir);
      }
    });

    test("paths are within standard temp/cache locations", () => {
      const lockPath = getNotebookLockPath("test");
      const isInTempDir = (
        lockPath.includes("/tmp/") ||
        lockPath.includes("/run/user/") ||
        lockPath.includes("/.cache/") ||
        lockPath.includes("/Library/Caches/") ||
        lockPath.includes("AppData") ||
        process.env.GYOSHU_RUNTIME_DIR !== undefined
      );
      expect(isInTempDir).toBe(true);
    });
  });
});
