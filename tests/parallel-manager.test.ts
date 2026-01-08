import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

import parallelManager from "../src/tool/parallel-manager";
import { clearProjectRootCache } from "../src/lib/paths";

function parseResponse<T = Record<string, unknown>>(result: string): T {
  return JSON.parse(result) as T;
}

async function callManager(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await parallelManager.execute(args);
  return parseResponse(result);
}

describe("parallel-manager", () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-test-"));
    process.env.GYOSHU_PROJECT_ROOT = tempDir;
    clearProjectRootCache();
    await fs.mkdir(path.join(tempDir, "reports"), { recursive: true });
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    clearProjectRootCache();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("init", () => {
    test("creates queue with default config", async () => {
      const result = await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("init");
      expect(result.reportTitle).toBe("test-research");
      expect(result.runId).toBe("run-001");
      expect(result.config).toBeDefined();

      const config = result.config as Record<string, number>;
      expect(config.maxJobAttempts).toBe(3);
      expect(config.staleClaimMs).toBe(120000);
      expect(config.heartbeatIntervalMs).toBe(30000);
    });

    test("creates queue with custom config", async () => {
      const result = await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-002",
        config: {
          maxJobAttempts: 5,
          staleClaimMs: 60000,
          heartbeatIntervalMs: 15000,
        },
      });

      expect(result.success).toBe(true);

      const config = result.config as Record<string, number>;
      expect(config.maxJobAttempts).toBe(5);
      expect(config.staleClaimMs).toBe(60000);
      expect(config.heartbeatIntervalMs).toBe(15000);
    });

    test("fails without reportTitle", async () => {
      await expect(
        callManager({
          action: "init",
          runId: "run-001",
        })
      ).rejects.toThrow("reportTitle is required");
    });

    test("fails without runId", async () => {
      await expect(
        callManager({
          action: "init",
          reportTitle: "test-research",
        })
      ).rejects.toThrow("runId is required");
    });

    test("fails if queue already exists", async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });

      await expect(
        callManager({
          action: "init",
          reportTitle: "test-research",
          runId: "run-001",
        })
      ).rejects.toThrow("Queue already exists");
    });

    test("prevents path traversal in reportTitle", async () => {
      await expect(
        callManager({
          action: "init",
          reportTitle: "../evil",
          runId: "run-001",
        })
      ).rejects.toThrow("Invalid reportTitle");
    });

    test("prevents path traversal in runId", async () => {
      await expect(
        callManager({
          action: "init",
          reportTitle: "test-research",
          runId: "../evil",
        })
      ).rejects.toThrow("Invalid runId");
    });
  });

  describe("enqueue", () => {
    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });
    });

    test("adds jobs with PENDING status", async () => {
      const result = await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [
          { stageId: "S01_load", kind: "execute_stage", payload: { task: "load data" } },
          { stageId: "S02_clean", kind: "execute_stage", payload: { task: "clean data" } },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("enqueue");
      expect(result.enqueuedCount).toBe(2);
      expect(result.totalJobs).toBe(2);
      expect((result.jobIds as string[]).length).toBe(2);

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const jobCounts = status.jobCounts as Record<string, number>;
      expect(jobCounts.PENDING).toBe(2);
      expect(jobCounts.CLAIMED).toBe(0);
      expect(jobCounts.DONE).toBe(0);
      expect(jobCounts.FAILED).toBe(0);
    });

    test("generates unique job IDs", async () => {
      const result = await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [
          { stageId: "S01", kind: "execute_stage" },
          { stageId: "S02", kind: "execute_stage" },
          { stageId: "S03", kind: "execute_stage" },
        ],
      });

      const jobIds = result.jobIds as string[];
      expect(jobIds.length).toBe(3);

      const uniqueIds = new Set(jobIds);
      expect(uniqueIds.size).toBe(3);

      for (const id of jobIds) {
        expect(id).toMatch(/^job-[a-f0-9]{8}$/);
      }
    });

    test("fails on non-existent queue", async () => {
      await expect(
        callManager({
          action: "enqueue",
          reportTitle: "nonexistent",
          runId: "run-001",
          jobs: [{ stageId: "S01", kind: "execute_stage" }],
        })
      ).rejects.toThrow("Queue not found");
    });

    test("fails without jobs array", async () => {
      await expect(
        callManager({
          action: "enqueue",
          reportTitle: "test-research",
          runId: "run-001",
        })
      ).rejects.toThrow("jobs array is required");
    });

    test("fails with empty jobs array", async () => {
      await expect(
        callManager({
          action: "enqueue",
          reportTitle: "test-research",
          runId: "run-001",
          jobs: [],
        })
      ).rejects.toThrow("jobs array is required");
    });
  });

  describe("claim", () => {
    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });

      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [
          { stageId: "S01", kind: "execute_stage", payload: { task: "first" } },
          { stageId: "S02", kind: "execute_stage", payload: { task: "second" } },
        ],
      });
    });

    test("claims first available job", async () => {
      const result = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("claim");
      expect(result.workerId).toBe("worker-001");

      const job = result.job as Record<string, unknown>;
      expect(job.jobId).toBeDefined();
      expect(job.stageId).toBe("S01");
      expect(job.kind).toBe("execute_stage");
      expect(job.payload).toEqual({ task: "first" });
      expect(job.attempt).toBe(1);
    });

    test("marks job as CLAIMED", async () => {
      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const jobCounts = status.jobCounts as Record<string, number>;
      expect(jobCounts.PENDING).toBe(1);
      expect(jobCounts.CLAIMED).toBe(1);
    });

    test("registers worker", async () => {
      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
        capabilities: ["gpu", "large-memory"],
      });

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const workers = status.workers as Array<Record<string, unknown>>;
      expect(workers.length).toBe(1);
      expect(workers[0].workerId).toBe("worker-001");
      expect(workers[0].capabilities).toEqual(["gpu", "large-memory"]);
    });

    test("returns success=false when no jobs", async () => {
      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-002",
      });

      const result = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-003",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("no_jobs");
    });

    test("respects capabilities", async () => {
      await callManager({
        action: "init",
        reportTitle: "cap-test",
        runId: "run-001",
      });

      await callManager({
        action: "enqueue",
        reportTitle: "cap-test",
        runId: "run-001",
        jobs: [
          {
            stageId: "S01",
            kind: "execute_stage",
            requiredCapabilities: ["gpu"],
          },
        ],
      });

      const resultWithoutGpu = await callManager({
        action: "claim",
        reportTitle: "cap-test",
        runId: "run-001",
        workerId: "worker-cpu",
        capabilities: ["cpu"],
      });

      expect(resultWithoutGpu.success).toBe(false);
      expect(resultWithoutGpu.reason).toBe("no_jobs");

      const resultWithGpu = await callManager({
        action: "claim",
        reportTitle: "cap-test",
        runId: "run-001",
        workerId: "worker-gpu",
        capabilities: ["gpu"],
      });

      expect(resultWithGpu.success).toBe(true);
    });

    test("fails without workerId", async () => {
      await expect(
        callManager({
          action: "claim",
          reportTitle: "test-research",
          runId: "run-001",
        })
      ).rejects.toThrow("workerId is required");
    });
  });

  describe("heartbeat", () => {
    let jobId: string;

    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });

      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [{ stageId: "S01", kind: "execute_stage" }],
      });

      const claimResult = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      const job = claimResult.job as Record<string, unknown>;
      jobId = job.jobId as string;
    });

    test("updates worker heartbeat", async () => {
      const result = await callManager({
        action: "heartbeat",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("heartbeat");
      expect(result.workerId).toBe("worker-001");
      expect(result.timestamp).toBeDefined();
    });

    test("updates job heartbeat when jobId provided", async () => {
      const result = await callManager({
        action: "heartbeat",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
        jobId: jobId,
      });

      expect(result.success).toBe(true);
      expect(result.jobId).toBe(jobId);
    });

    test("fails without workerId", async () => {
      await expect(
        callManager({
          action: "heartbeat",
          reportTitle: "test-research",
          runId: "run-001",
        })
      ).rejects.toThrow("workerId is required");
    });
  });

  describe("complete", () => {
    let jobId: string;

    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });

      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [{ stageId: "S01", kind: "execute_stage" }],
      });

      const claimResult = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      const job = claimResult.job as Record<string, unknown>;
      jobId = job.jobId as string;
    });

    test("marks job DONE", async () => {
      const result = await callManager({
        action: "complete",
        reportTitle: "test-research",
        runId: "run-001",
        jobId: jobId,
        result: { output: "success" },
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("complete");
      expect(result.jobId).toBe(jobId);
      expect(result.stageId).toBe("S01");
      expect(result.completedAt).toBeDefined();

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const jobCounts = status.jobCounts as Record<string, number>;
      expect(jobCounts.DONE).toBe(1);
      expect(jobCounts.CLAIMED).toBe(0);
    });

    test("stores result", async () => {
      const resultData = { accuracy: 0.95, metrics: { precision: 0.9, recall: 0.92 } };

      await callManager({
        action: "complete",
        reportTitle: "test-research",
        runId: "run-001",
        jobId: jobId,
        result: resultData,
      });

      const queuePath = path.join(tempDir, "reports", "test-research", "queue", "run-001.json");
      const queueData = JSON.parse(await fs.readFile(queuePath, "utf-8"));

      const job = queueData.jobs.find((j: Record<string, unknown>) => j.jobId === jobId);
      expect(job.result).toEqual(resultData);
    });

    test("fails on non-existent job", async () => {
      await expect(
        callManager({
          action: "complete",
          reportTitle: "test-research",
          runId: "run-001",
          jobId: "nonexistent-job",
          result: {},
        })
      ).rejects.toThrow("not found");
    });

    test("fails on PENDING job", async () => {
      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [{ stageId: "S02", kind: "execute_stage" }],
      });

      const queuePath = path.join(tempDir, "reports", "test-research", "queue", "run-001.json");
      const queueData = JSON.parse(await fs.readFile(queuePath, "utf-8"));
      const pendingJob = queueData.jobs.find((j: Record<string, unknown>) => j.stageId === "S02");

      await expect(
        callManager({
          action: "complete",
          reportTitle: "test-research",
          runId: "run-001",
          jobId: pendingJob.jobId,
          result: {},
        })
      ).rejects.toThrow("not in CLAIMED state");
    });

    test("fails without jobId", async () => {
      await expect(
        callManager({
          action: "complete",
          reportTitle: "test-research",
          runId: "run-001",
          result: {},
        })
      ).rejects.toThrow("jobId is required");
    });
  });

  describe("fail", () => {
    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
        config: { maxJobAttempts: 2 },
      });

      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [{ stageId: "S01", kind: "execute_stage" }],
      });
    });

    test("marks job FAILED after maxAttempts", async () => {
      const claim1 = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });
      const jobId = (claim1.job as Record<string, unknown>).jobId as string;

      await callManager({
        action: "fail",
        reportTitle: "test-research",
        runId: "run-001",
        jobId: jobId,
        error: "First failure",
      });

      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-002",
      });

      const failResult = await callManager({
        action: "fail",
        reportTitle: "test-research",
        runId: "run-001",
        jobId: jobId,
        error: "Second failure",
      });

      expect(failResult.success).toBe(true);
      expect(failResult.finalStatus).toBe("FAILED");
      expect(failResult.attempt).toBe(2);
      expect(failResult.maxAttempts).toBe(2);
      expect(failResult.message).toContain("permanently failed");

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const jobCounts = status.jobCounts as Record<string, number>;
      expect(jobCounts.FAILED).toBe(1);
      expect(jobCounts.PENDING).toBe(0);
    });

    test("resets to PENDING if attempts remaining", async () => {
      const claim1 = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });
      const jobId = (claim1.job as Record<string, unknown>).jobId as string;

      const failResult = await callManager({
        action: "fail",
        reportTitle: "test-research",
        runId: "run-001",
        jobId: jobId,
        error: "Temporary failure",
      });

      expect(failResult.success).toBe(true);
      expect(failResult.finalStatus).toBe("PENDING");
      expect(failResult.attempt).toBe(1);
      expect(failResult.message).toContain("reset to PENDING");

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const jobCounts = status.jobCounts as Record<string, number>;
      expect(jobCounts.PENDING).toBe(1);
      expect(jobCounts.CLAIMED).toBe(0);
    });

    test("fails without jobId", async () => {
      await expect(
        callManager({
          action: "fail",
          reportTitle: "test-research",
          runId: "run-001",
          error: "test error",
        })
      ).rejects.toThrow("jobId is required");
    });

    test("fails without error message", async () => {
      const claim = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });
      const jobId = (claim.job as Record<string, unknown>).jobId as string;

      await expect(
        callManager({
          action: "fail",
          reportTitle: "test-research",
          runId: "run-001",
          jobId: jobId,
        })
      ).rejects.toThrow("error message is required");
    });
  });

  describe("status", () => {
    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });
    });

    test("returns correct job counts", async () => {
      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [
          { stageId: "S01", kind: "execute_stage" },
          { stageId: "S02", kind: "execute_stage" },
          { stageId: "S03", kind: "execute_stage" },
        ],
      });

      const claim = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });
      const jobId = (claim.job as Record<string, unknown>).jobId as string;

      await callManager({
        action: "complete",
        reportTitle: "test-research",
        runId: "run-001",
        jobId: jobId,
        result: {},
      });

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(status.success).toBe(true);
      expect(status.totalJobs).toBe(3);

      const jobCounts = status.jobCounts as Record<string, number>;
      expect(jobCounts.PENDING).toBe(2);
      expect(jobCounts.CLAIMED).toBe(0);
      expect(jobCounts.DONE).toBe(1);
      expect(jobCounts.FAILED).toBe(0);
    });

    test("returns worker list", async () => {
      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [
          { stageId: "S01", kind: "execute_stage" },
          { stageId: "S02", kind: "execute_stage" },
        ],
      });

      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
        capabilities: ["cpu"],
      });

      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-002",
        capabilities: ["gpu"],
      });

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const workers = status.workers as Array<Record<string, unknown>>;
      expect(workers.length).toBe(2);

      const worker1 = workers.find((w) => w.workerId === "worker-001");
      const worker2 = workers.find((w) => w.workerId === "worker-002");

      expect(worker1).toBeDefined();
      expect(worker1?.capabilities).toEqual(["cpu"]);

      expect(worker2).toBeDefined();
      expect(worker2?.capabilities).toEqual(["gpu"]);
    });

    test("returns isComplete and hasFailed flags", async () => {
      const status1 = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(status1.isComplete).toBe(true);
      expect(status1.hasFailed).toBe(false);
    });
  });

  describe("reap", () => {
    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
        config: { staleClaimMs: 100, maxJobAttempts: 3 },
      });

      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [
          { stageId: "S01", kind: "execute_stage" },
          { stageId: "S02", kind: "execute_stage" },
        ],
      });
    });

    test("reclaims stale CLAIMED jobs", async () => {
      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      let status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });
      expect((status.jobCounts as Record<string, number>).CLAIMED).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const reapResult = await callManager({
        action: "reap",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(reapResult.success).toBe(true);
      expect(reapResult.reapedCount).toBe(1);
      expect((reapResult.reapedJobIds as string[]).length).toBe(1);

      status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });
      expect((status.jobCounts as Record<string, number>).CLAIMED).toBe(0);
      expect((status.jobCounts as Record<string, number>).PENDING).toBe(2);
    });

    test("resets to PENDING with incremented attempt", async () => {
      const claim = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });
      const jobId = (claim.job as Record<string, unknown>).jobId as string;

      await new Promise((resolve) => setTimeout(resolve, 150));

      await callManager({
        action: "reap",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const claim2 = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-002",
      });

      const job2 = claim2.job as Record<string, unknown>;
      expect(job2.jobId).toBe(jobId);
      expect(job2.attempt).toBe(2);
    });

    test("leaves fresh claims alone", async () => {
      await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      const reapResult = await callManager({
        action: "reap",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(reapResult.reapedCount).toBe(0);

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });
      expect((status.jobCounts as Record<string, number>).CLAIMED).toBe(1);
    });

    test("marks as FAILED after maxAttempts during reap", async () => {
      await callManager({
        action: "init",
        reportTitle: "test-reap-fail",
        runId: "run-001",
        config: { staleClaimMs: 100, maxJobAttempts: 1 },
      });

      await callManager({
        action: "enqueue",
        reportTitle: "test-reap-fail",
        runId: "run-001",
        jobs: [{ stageId: "S01", kind: "execute_stage" }],
      });

      await callManager({
        action: "claim",
        reportTitle: "test-reap-fail",
        runId: "run-001",
        workerId: "worker-001",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      await callManager({
        action: "reap",
        reportTitle: "test-reap-fail",
        runId: "run-001",
      });

      const status = await callManager({
        action: "status",
        reportTitle: "test-reap-fail",
        runId: "run-001",
      });

      expect((status.jobCounts as Record<string, number>).FAILED).toBe(1);
      expect((status.jobCounts as Record<string, number>).PENDING).toBe(0);
    });
  });

  describe("barrier_wait", () => {
    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });

      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [
          { stageId: "stage-A", kind: "execute_stage" },
          { stageId: "stage-A", kind: "execute_stage" },
          { stageId: "stage-B", kind: "execute_stage" },
        ],
      });
    });

    test("returns complete=false when jobs pending", async () => {
      const result = await callManager({
        action: "barrier_wait",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(result.success).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.pending).toBe(3);
      expect(result.claimed).toBe(0);
      expect(result.done).toBe(0);
    });

    test("returns complete=false when jobs claimed", async () => {
      for (let i = 0; i < 3; i++) {
        await callManager({
          action: "claim",
          reportTitle: "test-research",
          runId: "run-001",
          workerId: `worker-00${i}`,
        });
      }

      const result = await callManager({
        action: "barrier_wait",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(result.complete).toBe(false);
      expect(result.pending).toBe(0);
      expect(result.claimed).toBe(3);
    });

    test("returns complete=true when all done", async () => {
      const jobIds: string[] = [];

      for (let i = 0; i < 3; i++) {
        const claim = await callManager({
          action: "claim",
          reportTitle: "test-research",
          runId: "run-001",
          workerId: `worker-00${i}`,
        });
        jobIds.push((claim.job as Record<string, unknown>).jobId as string);
      }

      for (const jobId of jobIds) {
        await callManager({
          action: "complete",
          reportTitle: "test-research",
          runId: "run-001",
          jobId: jobId,
          result: {},
        });
      }

      const result = await callManager({
        action: "barrier_wait",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(result.complete).toBe(true);
      expect(result.pending).toBe(0);
      expect(result.claimed).toBe(0);
      expect(result.done).toBe(3);
    });

    test("filters by stageId when provided", async () => {
      const claim1 = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      const claim2 = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-002",
      });

      await callManager({
        action: "complete",
        reportTitle: "test-research",
        runId: "run-001",
        jobId: (claim1.job as Record<string, unknown>).jobId as string,
        result: {},
      });

      await callManager({
        action: "complete",
        reportTitle: "test-research",
        runId: "run-001",
        jobId: (claim2.job as Record<string, unknown>).jobId as string,
        result: {},
      });

      const resultA = await callManager({
        action: "barrier_wait",
        reportTitle: "test-research",
        runId: "run-001",
        stageId: "stage-A",
      });

      expect(resultA.complete).toBe(true);
      expect(resultA.stageId).toBe("stage-A");
      expect(resultA.totalJobs).toBe(2);

      const resultB = await callManager({
        action: "barrier_wait",
        reportTitle: "test-research",
        runId: "run-001",
        stageId: "stage-B",
      });

      expect(resultB.complete).toBe(false);
      expect(resultB.stageId).toBe("stage-B");
      expect(resultB.totalJobs).toBe(1);
      expect(resultB.pending).toBe(1);
    });

    test("returns complete=true with some FAILED jobs", async () => {
      await callManager({
        action: "init",
        reportTitle: "barrier-fail-test",
        runId: "run-001",
        config: { maxJobAttempts: 1 },
      });

      await callManager({
        action: "enqueue",
        reportTitle: "barrier-fail-test",
        runId: "run-001",
        jobs: [
          { stageId: "S01", kind: "execute_stage" },
          { stageId: "S02", kind: "execute_stage" },
        ],
      });

      const claim1 = await callManager({
        action: "claim",
        reportTitle: "barrier-fail-test",
        runId: "run-001",
        workerId: "worker-001",
      });

      await callManager({
        action: "fail",
        reportTitle: "barrier-fail-test",
        runId: "run-001",
        jobId: (claim1.job as Record<string, unknown>).jobId as string,
        error: "intentional failure",
      });

      const claim2 = await callManager({
        action: "claim",
        reportTitle: "barrier-fail-test",
        runId: "run-001",
        workerId: "worker-002",
      });

      await callManager({
        action: "complete",
        reportTitle: "barrier-fail-test",
        runId: "run-001",
        jobId: (claim2.job as Record<string, unknown>).jobId as string,
        result: {},
      });

      const result = await callManager({
        action: "barrier_wait",
        reportTitle: "barrier-fail-test",
        runId: "run-001",
      });

      expect(result.complete).toBe(true);
      expect(result.done).toBe(1);
      expect(result.failed).toBe(1);
    });
  });

  describe("concurrent operations", () => {
    beforeEach(async () => {
      await callManager({
        action: "init",
        reportTitle: "concurrent-test",
        runId: "run-001",
      });

      await callManager({
        action: "enqueue",
        reportTitle: "concurrent-test",
        runId: "run-001",
        jobs: [
          { stageId: "S01", kind: "execute_stage" },
          { stageId: "S02", kind: "execute_stage" },
          { stageId: "S03", kind: "execute_stage" },
          { stageId: "S04", kind: "execute_stage" },
          { stageId: "S05", kind: "execute_stage" },
        ],
      });
    });

    test("multiple claims get different jobs", async () => {
      const claimPromises = [];
      for (let i = 0; i < 5; i++) {
        claimPromises.push(
          callManager({
            action: "claim",
            reportTitle: "concurrent-test",
            runId: "run-001",
            workerId: `worker-${i}`,
          })
        );
      }

      const results = await Promise.all(claimPromises);

      for (const result of results) {
        expect(result.success).toBe(true);
      }

      const claimedJobIds = results.map((r) => (r.job as Record<string, unknown>).jobId);
      const uniqueJobIds = new Set(claimedJobIds);
      expect(uniqueJobIds.size).toBe(5);
    });

    test("queue state remains consistent after many operations", async () => {
      const operations = [];

      for (let i = 0; i < 5; i++) {
        operations.push(
          callManager({
            action: "claim",
            reportTitle: "concurrent-test",
            runId: "run-001",
            workerId: `worker-${i}`,
          })
        );
      }

      const claimResults = await Promise.all(operations);

      const completions = [];
      for (let i = 0; i < 3; i++) {
        const jobId = (claimResults[i].job as Record<string, unknown>).jobId as string;
        completions.push(
          callManager({
            action: "complete",
            reportTitle: "concurrent-test",
            runId: "run-001",
            jobId: jobId,
            result: { worker: `worker-${i}` },
          })
        );
      }

      for (let i = 3; i < 5; i++) {
        const jobId = (claimResults[i].job as Record<string, unknown>).jobId as string;
        completions.push(
          callManager({
            action: "fail",
            reportTitle: "concurrent-test",
            runId: "run-001",
            jobId: jobId,
            error: `failure from worker-${i}`,
          })
        );
      }

      await Promise.all(completions);

      const status = await callManager({
        action: "status",
        reportTitle: "concurrent-test",
        runId: "run-001",
      });

      const jobCounts = status.jobCounts as Record<string, number>;

      expect(jobCounts.DONE).toBe(3);
      expect(jobCounts.CLAIMED).toBe(0);
      expect(jobCounts.PENDING).toBe(2);
      expect(jobCounts.FAILED).toBe(0);

      expect(status.totalJobs).toBe(5);
    });

    test("no lost updates under mutations", async () => {
      const addAndClaimPromises = [];

      addAndClaimPromises.push(
        callManager({
          action: "enqueue",
          reportTitle: "concurrent-test",
          runId: "run-001",
          jobs: [
            { stageId: "S06", kind: "execute_stage" },
            { stageId: "S07", kind: "execute_stage" },
            { stageId: "S08", kind: "execute_stage" },
          ],
        })
      );

      for (let i = 0; i < 3; i++) {
        addAndClaimPromises.push(
          callManager({
            action: "claim",
            reportTitle: "concurrent-test",
            runId: "run-001",
            workerId: `worker-${i}`,
          })
        );
      }

      await Promise.all(addAndClaimPromises);

      const status = await callManager({
        action: "status",
        reportTitle: "concurrent-test",
        runId: "run-001",
      });

      expect(status.totalJobs).toBe(8);

      const jobCounts = status.jobCounts as Record<string, number>;
      expect(jobCounts.PENDING + jobCounts.CLAIMED + jobCounts.DONE + jobCounts.FAILED).toBe(8);
    });
  });

  describe("edge cases", () => {
    test("unknown action throws error", async () => {
      await expect(
        callManager({
          action: "unknown_action" as unknown,
          reportTitle: "test",
          runId: "run-001",
        })
      ).rejects.toThrow("Unknown action");
    });

    test("operations on non-existent queue throw error", async () => {
      await expect(
        callManager({
          action: "status",
          reportTitle: "nonexistent",
          runId: "run-001",
        })
      ).rejects.toThrow("Queue not found");
    });

    test("handles special characters in stageId", async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });

      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [
          { stageId: "S01_load_data", kind: "execute_stage" },
          { stageId: "S02-clean-data", kind: "execute_stage" },
          { stageId: "stage.with.dots", kind: "execute_stage" },
        ],
      });

      const status = await callManager({
        action: "status",
        reportTitle: "test-research",
        runId: "run-001",
      });

      expect(status.totalJobs).toBe(3);
    });

    test("handles large payload", async () => {
      await callManager({
        action: "init",
        reportTitle: "test-research",
        runId: "run-001",
      });

      const largePayload = {
        data: "x".repeat(10000),
        nested: {
          array: Array.from({ length: 100 }, (_, i) => ({ index: i, value: `item-${i}` })),
        },
      };

      await callManager({
        action: "enqueue",
        reportTitle: "test-research",
        runId: "run-001",
        jobs: [{ stageId: "S01", kind: "execute_stage", payload: largePayload }],
      });

      const claim = await callManager({
        action: "claim",
        reportTitle: "test-research",
        runId: "run-001",
        workerId: "worker-001",
      });

      const job = claim.job as Record<string, unknown>;
      expect((job.payload as Record<string, unknown>).data).toHaveLength(10000);
    });
  });
});
