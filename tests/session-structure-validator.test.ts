import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

import sessionStructureValidator from "../src/tool/session-structure-validator";
import { clearProjectRootCache, getLegacySessionsDir } from "../src/lib/paths";

let testProjectDir: string;
let testLegacyDir: string;
let originalProjectRoot: string | undefined;
let legacyDirCreatedByTest = false;

async function execute(args: {
  action: string;
  dryRun?: boolean;
  reportTitle?: string;
}): Promise<{ success: boolean; [key: string]: unknown }> {
  const result = await sessionStructureValidator.execute(args as any);
  return JSON.parse(result);
}

async function createLegacyResearchNotebook(
  reportTitle: string,
  notebookName: string = "analysis.ipynb"
): Promise<void> {
  const notebooksDir = path.join(
    testProjectDir,
    "gyoshu",
    "research",
    reportTitle,
    "notebooks"
  );
  await fs.mkdir(notebooksDir, { recursive: true });
  
  const notebook = {
    cells: [{ cell_type: "code", source: ["print('hello')"], metadata: {}, outputs: [] }],
    metadata: { kernelspec: { name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  await fs.writeFile(
    path.join(notebooksDir, notebookName),
    JSON.stringify(notebook, null, 2)
  );
}

async function createLegacyResearchArtifacts(
  reportTitle: string,
  artifacts: string[]
): Promise<void> {
  const artifactsDir = path.join(
    testProjectDir,
    "gyoshu",
    "research",
    reportTitle,
    "artifacts"
  );
  await fs.mkdir(artifactsDir, { recursive: true });
  
  for (const artifact of artifacts) {
    await fs.writeFile(path.join(artifactsDir, artifact), `Content of ${artifact}`);
  }
}

async function createGyoshuRootNotebook(notebookName: string): Promise<void> {
  const gyoshuDir = path.join(testProjectDir, "gyoshu");
  await fs.mkdir(gyoshuDir, { recursive: true });
  
  const notebook = {
    cells: [],
    metadata: { kernelspec: { name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  await fs.writeFile(
    path.join(gyoshuDir, notebookName),
    JSON.stringify(notebook, null, 2)
  );
}

async function createLegacyHomeSession(sessionId: string): Promise<void> {
  const sessionDir = path.join(testLegacyDir, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  
  const manifest = {
    researchSessionID: sessionId,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    status: "active",
    goal: `Test goal for ${sessionId}`,
  };
  await fs.writeFile(
    path.join(sessionDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
}

beforeAll(() => {
  originalProjectRoot = process.env.GYOSHU_PROJECT_ROOT;
});

afterAll(async () => {
  if (originalProjectRoot !== undefined) {
    process.env.GYOSHU_PROJECT_ROOT = originalProjectRoot;
  } else {
    delete process.env.GYOSHU_PROJECT_ROOT;
  }
  clearProjectRootCache();
});

beforeEach(async () => {
  testProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gyoshu-validator-test-"));
  testLegacyDir = getLegacySessionsDir();
  
  try {
    await fs.access(testLegacyDir);
    legacyDirCreatedByTest = false;
  } catch {
    await fs.mkdir(testLegacyDir, { recursive: true });
    legacyDirCreatedByTest = true;
  }
  
  process.env.GYOSHU_PROJECT_ROOT = testProjectDir;
  clearProjectRootCache();
});

afterEach(async () => {
  if (testProjectDir) {
    await fs.rm(testProjectDir, { recursive: true, force: true });
  }
  
  try {
    const entries = await fs.readdir(testLegacyDir);
    for (const entry of entries) {
      if (entry.startsWith("test-validator-")) {
        await fs.rm(path.join(testLegacyDir, entry), { recursive: true, force: true });
      }
    }
    
    if (legacyDirCreatedByTest) {
      const remaining = await fs.readdir(testLegacyDir);
      if (remaining.length === 0) {
        await fs.rm(testLegacyDir, { recursive: true, force: true });
        const parentDir = path.dirname(testLegacyDir);
        try {
          const parentEntries = await fs.readdir(parentDir);
          if (parentEntries.length === 0) {
            await fs.rm(parentDir, { recursive: true, force: true });
          }
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore
  }
  
  clearProjectRootCache();
});

describe("Scan Action", () => {
  describe("when project has no violations", () => {
    test("returns no project-local violations", async () => {
      const result = await execute({ action: "scan" });
      
      expect(result.success).toBe(true);
      expect(result.action).toBe("scan");
      expect(Array.isArray(result.violations)).toBe(true);
      
      const violations = result.violations as any[];
      const projectViolations = violations.filter(
        (v) => v.type !== "legacy_session"
      );
      expect(projectViolations.length).toBe(0);
    });

    test("summary includes all violation types", async () => {
      const result = await execute({ action: "scan" });
      
      expect(result.success).toBe(true);
      const summary = result.summary as any;
      expect(typeof summary.totalViolations).toBe("number");
      expect(typeof summary.autoFixable).toBe("number");
      expect(typeof summary.manualRequired).toBe("number");
      expect(typeof summary.byType).toBe("object");
    });

    test("returns appropriate message", async () => {
      const result = await execute({ action: "scan" });
      
      expect(result.success).toBe(true);
      expect(typeof result.message).toBe("string");
    });
  });

  describe("when legacy research notebooks exist", () => {
    test("detects notebook in gyoshu/research/*/notebooks/", async () => {
      await createLegacyResearchNotebook("my-analysis");
      
      const result = await execute({ action: "scan" });
      
      expect(result.success).toBe(true);
      const violations = result.violations as any[];
      expect(violations.length).toBeGreaterThan(0);
      
      const notebookViolation = violations.find(
        (v) => v.type === "notebook_wrong_location"
      );
      expect(notebookViolation).toBeDefined();
      expect(notebookViolation.reportTitle).toBe("my-analysis");
      expect(notebookViolation.canAutoFix).toBe(true);
    });

    test("suggests correct target path", async () => {
      await createLegacyResearchNotebook("customer-churn");
      
      const result = await execute({ action: "scan" });
      
      const violations = result.violations as any[];
      const notebookViolation = violations.find(
        (v) => v.type === "notebook_wrong_location"
      );
      
      expect(notebookViolation.suggestedPath).toContain("notebooks");
      expect(notebookViolation.suggestedPath).toContain("customer-churn.ipynb");
    });
  });

  describe("when legacy research artifacts exist", () => {
    test("detects artifacts in gyoshu/research/*/artifacts/", async () => {
      await createLegacyResearchArtifacts("my-analysis", ["plot.png", "model.pkl"]);
      
      const result = await execute({ action: "scan" });
      
      const violations = result.violations as any[];
      const artifactViolation = violations.find(
        (v) => v.type === "report_wrong_location"
      );
      expect(artifactViolation).toBeDefined();
      expect(artifactViolation.reportTitle).toBe("my-analysis");
      expect(artifactViolation.canAutoFix).toBe(true);
    });

    test("suggests reports directory as target", async () => {
      await createLegacyResearchArtifacts("data-analysis", ["results.json"]);
      
      const result = await execute({ action: "scan" });
      
      const violations = result.violations as any[];
      const artifactViolation = violations.find(
        (v) => v.type === "report_wrong_location"
      );
      
      expect(artifactViolation.suggestedPath).toContain("reports");
      expect(artifactViolation.suggestedPath).toContain("data-analysis");
    });
  });

  describe("when notebooks in gyoshu root exist", () => {
    test("detects notebook in gyoshu/ root", async () => {
      await createGyoshuRootNotebook("orphan.ipynb");
      
      const result = await execute({ action: "scan" });
      
      const violations = result.violations as any[];
      const rootViolation = violations.find(
        (v) => v.type === "gyoshu_root_notebook"
      );
      expect(rootViolation).toBeDefined();
      expect(rootViolation.canAutoFix).toBe(true);
    });
  });

  describe("when orphaned gyoshu/research directory exists", () => {
    test("detects orphaned research directory with content", async () => {
      await createLegacyResearchNotebook("orphan-project");
      
      const result = await execute({ action: "scan" });
      
      const violations = result.violations as any[];
      const orphanViolation = violations.find(
        (v) => v.type === "orphaned_research"
      );
      expect(orphanViolation).toBeDefined();
    });
  });

  describe("filtering by reportTitle", () => {
    test("filters violations by reportTitle", async () => {
      await createLegacyResearchNotebook("project-a");
      await createLegacyResearchNotebook("project-b");
      
      const result = await execute({ action: "scan", reportTitle: "project-a" });
      
      const violations = result.violations as any[];
      expect(violations.every((v) => v.reportTitle === "project-a" || v.reportTitle === undefined)).toBe(true);
    });
  });
});

describe("Fix Action", () => {
  describe("when no auto-fixable violations exist", () => {
    test("returns appropriate result", async () => {
      const result = await execute({ action: "fix" });
      
      expect(result.action).toBe("fix");
      const fixResult = result.result as any;
      expect(Array.isArray(fixResult.moved)).toBe(true);
      expect(Array.isArray(fixResult.errors)).toBe(true);
      expect(Array.isArray(fixResult.skipped)).toBe(true);
    });
  });

  describe("dry run mode", () => {
    test("does not move files in dry run", async () => {
      await createLegacyResearchNotebook("dry-test");
      
      const result = await execute({ action: "fix", dryRun: true });
      
      expect(result.dryRun).toBe(true);
      
      const fixResult = result.result as any;
      const dryRunMoves = fixResult.moved.filter((m: string) => m.includes("[DRY RUN]"));
      expect(dryRunMoves.length).toBeGreaterThan(0);
      
      const sourceStillExists = await fs.access(
        path.join(testProjectDir, "gyoshu", "research", "dry-test", "notebooks")
      ).then(() => true).catch(() => false);
      expect(sourceStillExists).toBe(true);
      
      const targetCreated = await fs.access(
        path.join(testProjectDir, "notebooks", "dry-test.ipynb")
      ).then(() => true).catch(() => false);
      expect(targetCreated).toBe(false);
    });

    test("reports what would be done", async () => {
      await createLegacyResearchNotebook("preview-test");
      
      const result = await execute({ action: "fix", dryRun: true });
      
      expect(result.message).toContain("Dry run");
      const summary = result.summary as any;
      expect(typeof summary.totalFixed).toBe("number");
    });
  });

  describe("actual fix", () => {
    test("moves notebook to correct location", async () => {
      await createLegacyResearchNotebook("move-test");
      
      const result = await execute({ action: "fix" });
      
      const fixResult = result.result as any;
      const movedNotebook = fixResult.moved.find((m: string) => 
        m.includes("move-test") && m.includes("Moved")
      );
      expect(movedNotebook).toBeDefined();
      
      const targetExists = await fs.access(
        path.join(testProjectDir, "notebooks", "move-test.ipynb")
      ).then(() => true).catch(() => false);
      expect(targetExists).toBe(true);
    });

    test("copies artifacts to reports directory", async () => {
      await createLegacyResearchArtifacts("artifact-test", ["data.csv", "plot.png"]);
      
      const result = await execute({ action: "fix" });
      
      const fixResult = result.result as any;
      const hasArtifactFix = fixResult.moved.some(
        (m: string) => m.includes("artifact") || m.includes("Copied")
      );
      expect(hasArtifactFix).toBe(true);
      
      const reportsDir = path.join(testProjectDir, "reports", "artifact-test");
      const targetExists = await fs.access(reportsDir).then(() => true).catch(() => false);
      expect(targetExists).toBe(true);
    });

    test("does not overwrite existing target", async () => {
      await createLegacyResearchNotebook("conflict-test");
      
      const targetDir = path.join(testProjectDir, "notebooks");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(
        path.join(targetDir, "conflict-test.ipynb"),
        '{"cells":[], "metadata":{}, "nbformat":4}'
      );
      
      const result = await execute({ action: "fix" });
      
      const fixResult = result.result as any;
      const hasConflictError = fixResult.errors.some(
        (e: string) => e.includes("already exists")
      );
      expect(hasConflictError).toBe(true);
    });
  });

  describe("skipped violations", () => {
    test("skips non-auto-fixable violations", async () => {
      await createLegacyHomeSession("test-validator-session");
      
      const result = await execute({ action: "fix" });
      
      const fixResult = result.result as any;
      expect(fixResult.skipped.length).toBeGreaterThan(0);
    });
  });
});

describe("Validate Action", () => {
  describe("basic validation", () => {
    test("returns validation result structure", async () => {
      const result = await execute({ action: "validate" });
      
      expect(result.success).toBe(true);
      expect(result.action).toBe("validate");
      expect(typeof result.valid).toBe("boolean");
      expect(Array.isArray(result.issues)).toBe(true);
    });

    test("returns message string", async () => {
      const result = await execute({ action: "validate" });
      
      expect(typeof result.message).toBe("string");
    });
  });

  describe("when structure has violations", () => {
    test("returns valid false", async () => {
      await createLegacyResearchNotebook("invalid-project");
      
      const result = await execute({ action: "validate" });
      
      expect(result.success).toBe(true);
      expect(result.valid).toBe(false);
      expect((result.issues as any[]).length).toBeGreaterThan(0);
    });

    test("lists all issues", async () => {
      await createLegacyResearchNotebook("issue-project");
      
      const result = await execute({ action: "validate" });
      
      const issues = result.issues as string[];
      expect(issues.some((i) => i.includes("notebook_wrong_location"))).toBe(true);
    });
  });

  describe("filtering by reportTitle", () => {
    test("validates specific report only", async () => {
      await createLegacyResearchNotebook("report-a");
      await createLegacyResearchNotebook("report-b");
      
      const result = await execute({ action: "validate", reportTitle: "report-a" });
      
      expect(result.reportTitle).toBe("report-a");
      const issues = result.issues as string[];
      expect(issues.every((i) => !i.includes("report-b"))).toBe(true);
    });
  });
});

describe("Error Handling", () => {
  test("throws for unknown action", async () => {
    await expect(
      execute({ action: "invalid-action" as any })
    ).rejects.toThrow("Unknown action");
  });
});
