import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  evaluateReportGate,
  isReportReady,
  validateSections,
  countFindings,
  extractArtifactRefs,
  validateArtifacts,
  reportDirExists,
  reportFileExists,
} from "../src/lib/report-gates";
import { clearProjectRootCache } from "../src/lib/paths";

describe("report-gates", () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-gates-test-"));
    originalEnv = process.env.GYOSHU_PROJECT_ROOT;
    process.env.GYOSHU_PROJECT_ROOT = tempDir;
    clearProjectRootCache();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GYOSHU_PROJECT_ROOT = originalEnv;
    } else {
      delete process.env.GYOSHU_PROJECT_ROOT;
    }
    clearProjectRootCache();
    
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function createReportDir(reportTitle: string): string {
    const reportDir = path.join(tempDir, "reports", reportTitle);
    fs.mkdirSync(reportDir, { recursive: true });
    return reportDir;
  }

  function createReportFile(reportTitle: string, content: string): void {
    const reportDir = createReportDir(reportTitle);
    fs.writeFileSync(path.join(reportDir, "README.md"), content);
  }

  function createArtifact(reportTitle: string, relativePath: string): void {
    const reportDir = path.join(tempDir, "reports", reportTitle);
    const fullPath = path.join(reportDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "artifact content");
  }

  describe("validateSections", () => {
    test("detects all required sections", () => {
      const content = `
# Research Report

## Executive Summary
This is the summary.

## Key Findings
1. Finding one

## Conclusion
The conclusion.
`;
      const result = validateSections(content);
      expect(result.hasExecutiveSummary).toBe(true);
      expect(result.hasKeyFindings).toBe(true);
      expect(result.hasConclusion).toBe(true);
    });

    test("detects missing Executive Summary", () => {
      const content = `
# Research Report

## Key Findings
1. Finding one

## Conclusion
The conclusion.
`;
      const result = validateSections(content);
      expect(result.hasExecutiveSummary).toBe(false);
      expect(result.hasKeyFindings).toBe(true);
      expect(result.hasConclusion).toBe(true);
    });

    test("detects alternative section names", () => {
      const content = `
## Summary
Brief summary.

## Findings
Some findings.

## Conclusions
Multiple conclusions.
`;
      const result = validateSections(content);
      expect(result.hasExecutiveSummary).toBe(true);
      expect(result.hasKeyFindings).toBe(true);
      expect(result.hasConclusion).toBe(true);
    });

    test("detects 'Verified Findings' variant", () => {
      const content = `
## Executive Summary
Summary.

## Key Findings (Verified)
Verified finding.

## Conclusion
Done.
`;
      const result = validateSections(content);
      expect(result.hasKeyFindings).toBe(true);
    });

    test("is case insensitive", () => {
      const content = `
## EXECUTIVE SUMMARY
Summary.

## KEY FINDINGS
Finding.

## CONCLUSION
Done.
`;
      const result = validateSections(content);
      expect(result.hasExecutiveSummary).toBe(true);
      expect(result.hasKeyFindings).toBe(true);
      expect(result.hasConclusion).toBe(true);
    });

    test("returns sections found list", () => {
      const content = `
## Executive Summary
## Methodology
## Key Findings
## Limitations
## Conclusion
`;
      const result = validateSections(content);
      expect(result.sectionsFound.length).toBe(5);
    });
  });

  describe("countFindings", () => {
    test("counts single finding in Key Findings section", () => {
      const content = `
## Key Findings
1. Treatment shows effect
`;
      expect(countFindings(content)).toBe(1);
    });

    test("counts multiple findings", () => {
      const content = `
## Key Findings
1. First finding
2. Second finding
3. Third finding
`;
      expect(countFindings(content)).toBe(3);
    });

    test("counts findings in Verified Findings section", () => {
      const content = `
## Key Findings (Verified)
1. First verified finding
2. Second verified finding
`;
      expect(countFindings(content)).toBe(2);
    });

    test("counts findings across multiple finding sections", () => {
      const content = `
## Key Findings (Verified)
1. Verified one
2. Verified two

## Findings (Partial Evidence)
1. Partial one

## Exploratory Observations
1. Exploratory one
2. Exploratory two
`;
      expect(countFindings(content)).toBe(5);
    });

    test("returns zero for no findings", () => {
      const content = "No findings here, just text";
      expect(countFindings(content)).toBe(0);
    });

    test("returns zero when Key Findings has no numbered items", () => {
      const content = `
## Key Findings
Nothing to report here.
`;
      expect(countFindings(content)).toBe(0);
    });

    test("stops counting at next non-findings section", () => {
      const content = `
## Key Findings
1. Real finding

## Limitations
1. This is a limitation, not a finding
`;
      expect(countFindings(content)).toBe(1);
    });

    test("handles alternative Findings section name", () => {
      const content = `
## Findings
1. A finding
`;
      expect(countFindings(content)).toBe(1);
    });
  });

  describe("extractArtifactRefs", () => {
    test("extracts image references", () => {
      const content = "![Figure 1](figures/plot.png)";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("figures/plot.png");
    });

    test("extracts link references with extensions", () => {
      const content = "[Download model](models/classifier.pkl)";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("models/classifier.pkl");
    });

    test("extracts backtick paths", () => {
      const content = "The data is saved at `exports/data.csv`";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("exports/data.csv");
    });

    test("ignores URLs", () => {
      const content = "[Link](https://example.com/image.png)";
      const refs = extractArtifactRefs(content);
      expect(refs.length).toBe(0);
    });

    test("ignores anchors", () => {
      const content = "[Section](#section-name)";
      const refs = extractArtifactRefs(content);
      expect(refs.length).toBe(0);
    });

    test("deduplicates references", () => {
      const content = `
![Plot](figures/plot.png)
See [figure](figures/plot.png) again.
`;
      const refs = extractArtifactRefs(content);
      expect(refs.filter(r => r === "figures/plot.png").length).toBe(1);
    });

    test("extracts multiple different types", () => {
      const content = `
![Figure](figures/plot.png)
[Model](models/model.pkl)
Data at \`exports/data.csv\`
`;
      const refs = extractArtifactRefs(content);
      expect(refs.length).toBe(3);
    });

    test("extracts path from image with title", () => {
      const content = '![Figure 1](figures/plot.png "The plot title")';
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("figures/plot.png");
      expect(refs.some(r => r.includes("title"))).toBe(false);
    });

    test("extracts path from image with single-quoted title", () => {
      const content = "![Figure 1](figures/plot.png 'The plot title')";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("figures/plot.png");
      expect(refs.some(r => r.includes("title"))).toBe(false);
    });

    test("extracts path with whitespace trimmed", () => {
      const content = "![Figure]( figures/plot.png )";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("figures/plot.png");
    });

    test("extracts path with leading whitespace trimmed", () => {
      const content = "![Figure](  figures/plot.png)";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("figures/plot.png");
    });

    test("extracts paths with uppercase extensions", () => {
      const content = "[Download](models/model.PKL)";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("models/model.PKL");
    });

    test("extracts paths with mixed case extensions", () => {
      const content = "![Image](figures/photo.Png)";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("figures/photo.Png");
    });

    test("extracts backtick paths with uppercase extensions", () => {
      const content = "Model saved at `models/classifier.Pkl`";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("models/classifier.Pkl");
    });

    test("handles combined whitespace and title", () => {
      const content = '![Plot](  figures/correlation.png  "Correlation Matrix")';
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("figures/correlation.png");
      expect(refs.some(r => r.includes("Correlation"))).toBe(false);
    });

    test("extracts path from link with title", () => {
      const content = '[Download model](models/model.pkl "The trained model")';
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("models/model.pkl");
      expect(refs.some(r => r.includes("trained"))).toBe(false);
    });

    test("extracts path from link with single-quoted title", () => {
      const content = "[Download model](models/model.pkl 'The trained model')";
      const refs = extractArtifactRefs(content);
      expect(refs).toContain("models/model.pkl");
      expect(refs.some(r => r.includes("trained"))).toBe(false);
    });
  });

  describe("validateArtifacts", () => {
    // Check symlink support once at the start to enable explicit test skipping
    // instead of silent early returns
    const symlinkSupported = (() => {
      try {
        const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-test-"));
        const target = path.join(testDir, "target");
        const link = path.join(testDir, "link");
        fs.writeFileSync(target, "test");
        fs.symlinkSync(target, link);
        fs.rmSync(testDir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    })();

    test("reports existing artifacts", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);
      createArtifact(reportTitle, "figures/plot.png");
      
      const result = validateArtifacts(reportTitle, ["figures/plot.png"]);
      expect(result.existing).toContain("figures/plot.png");
      expect(result.missing.length).toBe(0);
    });

    test("reports missing artifacts", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);
      
      const result = validateArtifacts(reportTitle, ["figures/missing.png"]);
      expect(result.missing).toContain("figures/missing.png");
      expect(result.existing.length).toBe(0);
    });

    test("handles mixed existing and missing", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);
      createArtifact(reportTitle, "models/model.pkl");
      
      const result = validateArtifacts(reportTitle, [
        "models/model.pkl",
        "figures/missing.png",
      ]);
      expect(result.existing).toContain("models/model.pkl");
      expect(result.missing).toContain("figures/missing.png");
    });

    test("rejects absolute paths", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);

      const result = validateArtifacts(reportTitle, ["/etc/passwd"]);
      expect(result.missing).toContain("/etc/passwd");
      expect(result.existing.length).toBe(0);
    });

    test("rejects path traversal with ../", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);

      const result = validateArtifacts(reportTitle, ["../../../etc/passwd"]);
      expect(result.missing).toContain("../../../etc/passwd");
      expect(result.existing.length).toBe(0);
    });

    test("rejects path traversal in middle of path", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);

      const result = validateArtifacts(reportTitle, ["figures/../../../etc/passwd"]);
      expect(result.missing).toContain("figures/../../../etc/passwd");
      expect(result.existing.length).toBe(0);
    });

    test("rejects multiple malicious paths while accepting valid ones", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);
      createArtifact(reportTitle, "figures/valid.png");

      const result = validateArtifacts(reportTitle, [
        "/etc/passwd",
        "../secret.txt",
        "figures/valid.png",
        "figures/../../../etc/shadow",
      ]);
      expect(result.existing).toContain("figures/valid.png");
      expect(result.missing).toContain("/etc/passwd");
      expect(result.missing).toContain("../secret.txt");
      expect(result.missing).toContain("figures/../../../etc/shadow");
      expect(result.existing.length).toBe(1);
      expect(result.missing.length).toBe(3);
    });

    test("accepts legitimate filenames with double dots", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);
      createArtifact(reportTitle, "figure..png");
      createArtifact(reportTitle, "data..v2..csv");
      createArtifact(reportTitle, "sub/nested..file.txt");

      const result = validateArtifacts(reportTitle, [
        "figure..png",
        "data..v2..csv",
        "sub/nested..file.txt",
      ]);
      expect(result.existing).toContain("figure..png");
      expect(result.existing).toContain("data..v2..csv");
      expect(result.existing).toContain("sub/nested..file.txt");
      expect(result.missing.length).toBe(0);
    });

    test("accepts filenames starting with double dots (not traversal)", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);
      createArtifact(reportTitle, "..foo.png");
      createArtifact(reportTitle, "..data/file.txt");

      const result = validateArtifacts(reportTitle, [
        "..foo.png",
        "..data/file.txt",
      ]);
      expect(result.existing).toContain("..foo.png");
      expect(result.existing).toContain("..data/file.txt");
      expect(result.missing.length).toBe(0);
    });

    test.skipIf(!symlinkSupported)("rejects symlinks pointing outside report directory", () => {
      const reportTitle = "test-report";
      const reportDir = createReportDir(reportTitle);
      const symlinkPath = path.join(reportDir, "escape.txt");

      fs.symlinkSync("/etc/passwd", symlinkPath);

      try {
        const result = validateArtifacts(reportTitle, ["escape.txt"]);
        expect(result.missing).toContain("escape.txt");
        expect(result.existing.length).toBe(0);
      } finally {
        fs.unlinkSync(symlinkPath);
      }
    });

    test.skipIf(!symlinkSupported)("rejects symlinks even if pointing within report directory", () => {
      // FIX-177: All symlinks are now rejected for defense-in-depth
      const reportTitle = "test-report";
      const reportDir = createReportDir(reportTitle);

      const realFile = path.join(reportDir, "real-file.txt");
      fs.writeFileSync(realFile, "real content");

      const symlinkPath = path.join(reportDir, "link-to-real.txt");
      fs.symlinkSync(realFile, symlinkPath);

      try {
        const result = validateArtifacts(reportTitle, ["link-to-real.txt"]);
        expect(result.missing).toContain("link-to-real.txt");
        expect(result.existing.length).toBe(0);
      } finally {
        fs.unlinkSync(symlinkPath);
      }
    });

    test("rejects directory references as artifacts", () => {
      const reportTitle = "test-report";
      createReportDir(reportTitle);
      fs.mkdirSync(path.join(tempDir, "reports", reportTitle, "figures"), { recursive: true });

      const result = validateArtifacts(reportTitle, [".", "figures", "figures/"]);
      expect(result.missing).toContain(".");
      expect(result.missing).toContain("figures");
      expect(result.missing).toContain("figures/");
      expect(result.existing.length).toBe(0);
    });
  });

  describe("reportDirExists", () => {
    test("returns true for existing directory", () => {
      createReportDir("test-report");
      expect(reportDirExists("test-report")).toBe(true);
    });

    test("returns false for missing directory", () => {
      expect(reportDirExists("nonexistent")).toBe(false);
    });
  });

  describe("reportFileExists", () => {
    test("returns true for existing file", () => {
      createReportFile("test-report", "# Report");
      expect(reportFileExists("test-report")).toBe(true);
    });

    test("returns false for missing file", () => {
      createReportDir("test-report");
      expect(reportFileExists("test-report")).toBe(false);
    });
  });

  describe("evaluateReportGate", () => {
    test("passes for complete report", () => {
      const content = `
# Test Report

## Executive Summary
This is a summary.

## Key Findings
1. Important discovery

## Conclusion
Research complete.
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(true);
      expect(result.overallStatus).toBe("COMPLETE");
      expect(result.score).toBe(100);
      expect(result.violations.length).toBe(0);
    });

    test("fails for missing report directory", () => {
      const result = evaluateReportGate("nonexistent");
      
      expect(result.passed).toBe(false);
      expect(result.overallStatus).toBe("MISSING");
      expect(result.violations.some(v => v.type === "REPORT_DIR_MISSING")).toBe(true);
    });

    test("fails for missing report file", () => {
      createReportDir("test-report");
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(false);
      expect(result.overallStatus).toBe("MISSING");
      expect(result.violations.some(v => v.type === "REPORT_FILE_MISSING")).toBe(true);
    });

    test("fails for missing Executive Summary", () => {
      const content = `
## Key Findings
1. Something

## Conclusion
Done.
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(false);
      expect(result.overallStatus).toBe("INCOMPLETE");
      expect(result.violations.some(v => v.type === "SECTION_MISSING_EXEC_SUMMARY")).toBe(true);
    });

    test("fails for missing Key Findings section", () => {
      const content = `
## Executive Summary
Summary.

## Conclusion
Done.
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "SECTION_MISSING_KEY_FINDINGS")).toBe(true);
    });

    test("fails for missing Conclusion section", () => {
      const content = `
## Executive Summary
Summary.

## Key Findings
1. Something
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "SECTION_MISSING_CONCLUSION")).toBe(true);
    });

    test("fails for no findings", () => {
      const content = `
## Executive Summary
Summary.

## Key Findings
Nothing to report.

## Conclusion
Done.
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "NO_FINDINGS")).toBe(true);
    });

    test("fails for missing artifacts", () => {
      const content = `
## Executive Summary
Summary.

## Key Findings
1. See ![plot](figures/missing.png)

## Conclusion
Done.
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "ARTIFACT_MISSING")).toBe(true);
      expect(result.missingArtifacts).toContain("figures/missing.png");
    });

    test("passes with existing artifacts", () => {
      const content = `
## Executive Summary
Summary.

## Key Findings
1. See ![plot](figures/plot.png)

## Conclusion
Done.
`;
      createReportFile("test-report", content);
      createArtifact("test-report", "figures/plot.png");
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(true);
      expect(result.missingArtifacts).toBeUndefined();
    });

    test("calculates correct score with multiple violations", () => {
      const content = `
## Key Findings
No actual findings here.
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.score).toBeLessThan(100);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    test("score minimum is 0", () => {
      const result = evaluateReportGate("nonexistent");
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    test("returns finding count", () => {
      const content = `
## Executive Summary
Summary.

## Key Findings
1. First
2. Second
3. Third

## Conclusion
Done.
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.findingCount).toBe(3);
    });

    test("returns artifact count", () => {
      const content = `
## Executive Summary
Summary.

## Key Findings
1. Important

## Conclusion
Done.
`;
      createReportFile("test-report", content);
      createArtifact("test-report", "figures/plot1.png");
      createArtifact("test-report", "figures/plot2.png");
      createArtifact("test-report", "models/model.pkl");
      
      const result = evaluateReportGate("test-report");
      expect(result.artifactCount).toBe(3);
    });

    test("returns report path when file exists", () => {
      const content = `
## Executive Summary
## Key Findings
1. Test
## Conclusion
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.reportPath).toBeDefined();
      expect(result.reportPath).toContain("README.md");
    });

    test("provides section validation details", () => {
      const content = `
## Executive Summary
## Key Findings
1. Test
## Conclusion
`;
      createReportFile("test-report", content);
      
      const result = evaluateReportGate("test-report");
      expect(result.sectionValidation.hasExecutiveSummary).toBe(true);
      expect(result.sectionValidation.hasKeyFindings).toBe(true);
      expect(result.sectionValidation.hasConclusion).toBe(true);
    });

    test("fails for malicious reportTitle with path traversal", () => {
      const result = evaluateReportGate("../../../etc");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "REPORT_TITLE_INVALID")).toBe(true);
      expect(result.score).toBe(0);
      expect(result.overallStatus).toBe("MISSING");
    });

    test("fails for absolute path reportTitle", () => {
      const result = evaluateReportGate("/etc/passwd");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "REPORT_TITLE_INVALID")).toBe(true);
      expect(result.score).toBe(0);
    });

    test("fails for reportTitle with forward slash", () => {
      const result = evaluateReportGate("foo/bar");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "REPORT_TITLE_INVALID")).toBe(true);
    });

    test("fails for reportTitle with backslash", () => {
      const result = evaluateReportGate("foo\\bar");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "REPORT_TITLE_INVALID")).toBe(true);
    });

    test("fails for empty reportTitle", () => {
      const result = evaluateReportGate("");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "REPORT_TITLE_INVALID")).toBe(true);
      expect(result.score).toBe(0);
    });

    test("fails for reportTitle with double dots", () => {
      const result = evaluateReportGate("report..escape");
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === "REPORT_TITLE_INVALID")).toBe(true);
    });

    test("fails for empty README.md", () => {
      createReportFile("test-report", "");
      
      const result = evaluateReportGate("test-report");
      expect(result.passed).toBe(false);
      expect(result.overallStatus).toBe("INCOMPLETE");
      expect(result.violations.some(v => v.type === "SECTION_MISSING_EXEC_SUMMARY")).toBe(true);
      expect(result.violations.some(v => v.type === "SECTION_MISSING_KEY_FINDINGS")).toBe(true);
      expect(result.violations.some(v => v.type === "SECTION_MISSING_CONCLUSION")).toBe(true);
      expect(result.violations.some(v => v.type === "NO_FINDINGS")).toBe(true);
      expect(result.violations.some(v => v.type === "REPORT_FILE_MISSING")).toBe(false);
      expect(result.score).toBe(10);
    });

    // POSIX-only test: chmod 000 is ignored when running as root
    // Skip on Windows (no chmod support) and when running as root (chmod 000 has no effect)
    const isRootUser = process.getuid?.() === 0;
    test.skipIf(os.platform() === "win32" || isRootUser)("fails for unreadable README.md (POSIX only)", () => {
      const reportDir = createReportDir("test-report");
      const readmePath = path.join(reportDir, "README.md");
      fs.writeFileSync(readmePath, "# Report\n## Executive Summary\n## Key Findings\n1. Test\n## Conclusion");

      // Remove read permissions
      fs.chmodSync(readmePath, 0o000);

      try {
        const result = evaluateReportGate("test-report");
        expect(result.passed).toBe(false);
        expect(result.violations.some(v => v.type === "REPORT_FILE_UNREADABLE")).toBe(true);
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(readmePath, 0o644);
      }
    });
  });

  describe("isReportReady", () => {
    test("returns true for valid report", () => {
      const content = `
## Executive Summary
## Key Findings
1. Test
## Conclusion
`;
      createReportFile("test-report", content);
      expect(isReportReady("test-report")).toBe(true);
    });

    test("returns false for missing directory", () => {
      expect(isReportReady("nonexistent")).toBe(false);
    });

    test("returns false for missing file", () => {
      createReportDir("test-report");
      expect(isReportReady("test-report")).toBe(false);
    });

    test("returns false for no findings", () => {
      const content = `
## Executive Summary
## Key Findings
Nothing here
## Conclusion
`;
      createReportFile("test-report", content);
      expect(isReportReady("test-report")).toBe(false);
    });

    test("returns false for malicious reportTitle with path traversal", () => {
      expect(isReportReady("../../../etc")).toBe(false);
    });

    test("returns false for malicious reportTitle with absolute path", () => {
      expect(isReportReady("/etc/passwd")).toBe(false);
    });

    test("returns false for reportTitle with forward slash", () => {
      expect(isReportReady("foo/bar")).toBe(false);
    });

    test("returns false for empty reportTitle", () => {
      expect(isReportReady("")).toBe(false);
    });
  });
});
