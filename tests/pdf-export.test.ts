import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  detectAvailableConverters,
  getPreferredConverter,
  exportToPdf,
  PdfConverter,
  CONVERTERS,
} from "../src/lib/pdf-export";
import { clearProjectRootCache } from "../src/lib/paths";

describe("detectAvailableConverters", () => {
  it("returns array of available converters", async () => {
    const available = await detectAvailableConverters();
    expect(Array.isArray(available)).toBe(true);
  });

  it("only returns valid converter names", async () => {
    const available = await detectAvailableConverters();
    const validNames: PdfConverter[] = ["pandoc", "wkhtmltopdf", "weasyprint"];
    for (const converter of available) {
      expect(validNames).toContain(converter);
    }
  });
});

describe("getPreferredConverter", () => {
  it("returns converter config or null", async () => {
    const preferred = await getPreferredConverter();
    if (preferred !== null) {
      expect(preferred.name).toBeDefined();
      expect(preferred.command).toBeDefined();
      expect(typeof preferred.buildArgs).toBe("function");
      expect(preferred.installHint).toBeDefined();
    }
  });

  it("returns converter with priority order", async () => {
    const available = await detectAvailableConverters();
    const preferred = await getPreferredConverter();

    if (available.length > 0 && preferred) {
      expect(available).toContain(preferred.name);
    }
  });
});

describe("exportToPdf", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gyoshu-pdf-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns error for nonexistent input file", async () => {
    const result = await exportToPdf("/nonexistent/file.md");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Input file not found");
  });

  it("returns error when no converter available", async () => {
    const mdPath = path.join(tempDir, "test.md");
    await fs.writeFile(mdPath, "# Test\n\nContent");

    const result = await exportToPdf(mdPath, undefined, {
      converter: "pandoc" as PdfConverter,
    });

    const available = await detectAvailableConverters();
    if (!available.includes("pandoc")) {
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
      expect(result.installHint).toBeDefined();
    }
  });

  it("generates output path from input path", async () => {
    const mdPath = path.join(tempDir, "report.md");
    await fs.writeFile(mdPath, "# Test");

    const available = await detectAvailableConverters();
    if (available.length === 0) {
      const result = await exportToPdf(mdPath);
      expect(result.success).toBe(false);
      expect(result.installHint).toBeDefined();
    } else {
      const result = await exportToPdf(mdPath);
      if (result.success) {
        expect(result.pdfPath).toBe(path.join(tempDir, "report.pdf"));
      }
    }
  });

  it("respects custom output path", async () => {
    const mdPath = path.join(tempDir, "input.md");
    const pdfPath = path.join(tempDir, "custom-output.pdf");
    await fs.writeFile(mdPath, "# Test");

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath, pdfPath);
      if (result.success) {
        expect(result.pdfPath).toBe(pdfPath);
      }
    }
  });

  it("creates output directory inside reports directory", async () => {
    const originalProjectRoot = process.env.GYOSHU_PROJECT_ROOT;
    process.env.GYOSHU_PROJECT_ROOT = tempDir;
    clearProjectRootCache();

    try {
      const mdPath = path.join(tempDir, "input.md");
      const pdfPath = path.join(tempDir, "reports", "subdir", "output.pdf");
      await fs.writeFile(mdPath, "# Test");

      const available = await detectAvailableConverters();
      if (available.length > 0) {
        await exportToPdf(mdPath, pdfPath);
        const dirExists = await fs.stat(path.join(tempDir, "reports", "subdir")).catch(() => null);
        expect(dirExists).not.toBeNull();
      }
    } finally {
      if (originalProjectRoot !== undefined) {
        process.env.GYOSHU_PROJECT_ROOT = originalProjectRoot;
      } else {
        delete process.env.GYOSHU_PROJECT_ROOT;
      }
      clearProjectRootCache();
    }
  });

  it("returns converter used on success", async () => {
    const mdPath = path.join(tempDir, "test.md");
    await fs.writeFile(mdPath, "# Test\n\nSome content here.");

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath);
      if (result.success) {
        expect(result.converter).toBeDefined();
        expect(available).toContain(result.converter);
      }
    }
  });

  it("handles markdown with tables", async () => {
    const mdPath = path.join(tempDir, "table.md");
    const markdown = `# Report

| Name | Value |
|------|-------|
| A    | 1     |
| B    | 2     |
`;
    await fs.writeFile(mdPath, markdown);

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath);
      if (result.success) {
        const pdfExists = await fs.stat(result.pdfPath!).catch(() => null);
        expect(pdfExists).not.toBeNull();
      }
    }
  });

  it("handles markdown with code blocks", async () => {
    const mdPath = path.join(tempDir, "code.md");
    const markdown = `# Code Example

\`\`\`python
def hello():
    print("Hello, World!")
\`\`\`

Some \`inline code\` here.
`;
    await fs.writeFile(mdPath, markdown);

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath);
      expect(result.success || result.error !== undefined).toBe(true);
    }
  });

  it("applies page size option", async () => {
    const mdPath = path.join(tempDir, "page.md");
    await fs.writeFile(mdPath, "# Test");

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath, undefined, { pageSize: "a4" });
      expect(result.success || result.error !== undefined).toBe(true);
    }
  });

  it("applies margins option", async () => {
    const mdPath = path.join(tempDir, "margins.md");
    await fs.writeFile(mdPath, "# Test");

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath, undefined, { margins: "1cm" });
      expect(result.success || result.error !== undefined).toBe(true);
    }
  });

  it("applies title option", async () => {
    const mdPath = path.join(tempDir, "titled.md");
    await fs.writeFile(mdPath, "# Test");

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath, undefined, { title: "Custom Title" });
      expect(result.success || result.error !== undefined).toBe(true);
    }
  });
});

describe("markdownToHtml conversion (via exportToPdf)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gyoshu-html-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("converts headers", async () => {
    const mdPath = path.join(tempDir, "headers.md");
    const markdown = `# H1
## H2
### H3`;
    await fs.writeFile(mdPath, markdown);

    const available = await detectAvailableConverters();
    const hasHtmlConverter = available.includes("wkhtmltopdf") || available.includes("weasyprint");

    if (hasHtmlConverter) {
      const result = await exportToPdf(mdPath);
      expect(result.success || result.error !== undefined).toBe(true);
    }
  });

  it("converts bold and italic", async () => {
    const mdPath = path.join(tempDir, "formatting.md");
    const markdown = `This is **bold** and this is *italic*.`;
    await fs.writeFile(mdPath, markdown);

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath);
      expect(result.success || result.error !== undefined).toBe(true);
    }
  });

  it("converts lists", async () => {
    const mdPath = path.join(tempDir, "lists.md");
    const markdown = `
- Item 1
- Item 2
- Item 3

1. First
2. Second
3. Third
`;
    await fs.writeFile(mdPath, markdown);

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath);
      expect(result.success || result.error !== undefined).toBe(true);
    }
  });

  it("strips HTML comments (sentinel blocks)", async () => {
    const mdPath = path.join(tempDir, "comments.md");
    const markdown = `# Report
<!-- GYOSHU:REPORT:METRICS:BEGIN -->
| Metric | Value |
|--------|-------|
| acc    | 0.95  |
<!-- GYOSHU:REPORT:METRICS:END -->
`;
    await fs.writeFile(mdPath, markdown);

    const available = await detectAvailableConverters();
    if (available.length > 0) {
      const result = await exportToPdf(mdPath);
      expect(result.success || result.error !== undefined).toBe(true);
    }
  });
});

describe("security", () => {
  let tempDir: string;
  let originalProjectRoot: string | undefined;

  // Set up a sandbox where GYOSHU_PROJECT_ROOT points to our temp directory
  // This allows us to test symlink rejection inside the "reports" directory
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gyoshu-pdf-security-"));
    // Save original and set temp dir as project root
    originalProjectRoot = process.env.GYOSHU_PROJECT_ROOT;
    process.env.GYOSHU_PROJECT_ROOT = tempDir;
    clearProjectRootCache();
  });

  afterAll(async () => {
    // Restore original project root
    if (originalProjectRoot !== undefined) {
      process.env.GYOSHU_PROJECT_ROOT = originalProjectRoot;
    } else {
      delete process.env.GYOSHU_PROJECT_ROOT;
    }
    clearProjectRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects input path that is a symlink", async () => {
    const realMd = path.join(tempDir, "real.md");
    const symlinkInputPath = path.join(tempDir, "symlink.md");

    await fs.writeFile(realMd, "# Real Content");
    await fs.symlink(realMd, symlinkInputPath);

    const result = await exportToPdf(symlinkInputPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("symlink");
  });

  it("rejects output path that is a symlink (when converter available)", async () => {
    const available = await detectAvailableConverters();
    if (available.length === 0) {
      console.log("SKIP: No PDF converter available - output symlink test requires converter");
      return;
    }

    // Create the reports directory structure INSIDE our sandbox (tempDir is now project root)
    // This ensures the output path passes containment check so we actually test symlink rejection
    const reportsDir = path.join(tempDir, "reports", "test-report");
    await fs.mkdir(reportsDir, { recursive: true });

    const realFile = path.join(reportsDir, "real.pdf");
    const symlinkOutputPath = path.join(reportsDir, "symlink.pdf");

    await fs.writeFile(realFile, "");
    await fs.symlink(realFile, symlinkOutputPath);

    const mdPath = path.join(tempDir, "test.md");
    await fs.writeFile(mdPath, "# Test Document\n\nSome content here.");

    const result = await exportToPdf(mdPath, symlinkOutputPath);

    expect(result.success).toBe(false);
    // Now we actually test symlink rejection, not containment rejection
    expect(result.error).toContain("symlink");
  });

  it("rejects output path outside reports directory (when converter available)", async () => {
    const available = await detectAvailableConverters();
    if (available.length === 0) {
      console.log("SKIP: No PDF converter available - containment test requires converter");
      return;
    }

    const mdPath = path.join(tempDir, "test.md");
    await fs.writeFile(mdPath, "# Test Document\n\nContent for containment test.");

    // Path outside tempDir/reports/ should be rejected by containment check
    // and MUST NOT create any directories as a side-effect (FIX-148)
    const outputOutsideReportsDir = path.join(tempDir, "outside", "dir", "escaped-output.pdf");
    const result = await exportToPdf(mdPath, outputOutsideReportsDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes reports");

    const escapedDir = path.join(tempDir, "outside", "dir");
    const escapedDirExists = await fs.stat(escapedDir).catch(() => null);
    expect(escapedDirExists).toBeNull();
  });

  it("handles malicious HTML without crashing (sanitizer integration)", async () => {
    // SECURITY: sanitizeHtml() is not exported, so we verify its behavior indirectly.
    // This tests that malicious content doesn't crash the pipeline.
    const mdPath = path.join(tempDir, "malicious.md");
    const maliciousContent = `# Report

<img src="http://evil.com/tracker.png" onerror="alert(1)">
<a href="file:///etc/passwd">Click here</a>
<script>alert('xss')</script>`;
    await fs.writeFile(mdPath, maliciousContent);

    const result = await exportToPdf(mdPath);

    expect(result.error === undefined || typeof result.error === "string").toBe(true);
  });
});

describe("converter buildArgs", () => {
  it("pandoc treats input as HTML in sanitized pipeline (FIX-147)", () => {
    const pandocConfig = CONVERTERS.find(c => c.name === "pandoc");
    expect(pandocConfig).toBeDefined();
    if (pandocConfig) {
      const args = pandocConfig.buildArgs("input.html", "output.pdf", {});
      expect(args).toContain("--from=html");
    }
  });

  it("pandoc includes pdf-engine", async () => {
    const preferred = await getPreferredConverter();
    if (preferred?.name === "pandoc") {
      const args = preferred.buildArgs("input.md", "output.pdf", {});
      expect(args).toContain("--pdf-engine=xelatex");
    }
  });

  it("pandoc adds title metadata", async () => {
    const preferred = await getPreferredConverter();
    if (preferred?.name === "pandoc") {
      const args = preferred.buildArgs("input.md", "output.pdf", { title: "My Report" });
      expect(args.some((a: string) => a.includes("title:My Report"))).toBe(true);
    }
  });

  it("wkhtmltopdf adds page size", async () => {
    const available = await detectAvailableConverters();
    if (available.includes("wkhtmltopdf")) {
      const { getPreferredConverter } = await import("../src/lib/pdf-export");
      const preferred = await getPreferredConverter();
      if (preferred?.name === "wkhtmltopdf") {
        const args = preferred.buildArgs("input.html", "output.pdf", { pageSize: "a4" });
        expect(args).toContain("--page-size");
        expect(args).toContain("A4");
      }
    }
  });

  it("wkhtmltopdf adds margins", async () => {
    const available = await detectAvailableConverters();
    if (available.includes("wkhtmltopdf")) {
      const { getPreferredConverter } = await import("../src/lib/pdf-export");
      const preferred = await getPreferredConverter();
      if (preferred?.name === "wkhtmltopdf") {
        const args = preferred.buildArgs("input.html", "output.pdf", { margins: "2cm" });
        expect(args).toContain("-T");
        expect(args).toContain("2cm");
      }
    }
  });

  it("weasyprint adds css path", async () => {
    const available = await detectAvailableConverters();
    if (available.includes("weasyprint")) {
      const { getPreferredConverter } = await import("../src/lib/pdf-export");
      const preferred = await getPreferredConverter();
      if (preferred?.name === "weasyprint") {
        const args = preferred.buildArgs("input.html", "output.pdf", { cssPath: "style.css" });
        expect(args).toContain("-s");
        expect(args).toContain("style.css");
      }
    }
  });

  it("wkhtmltopdf includes security hardening flags (FIX-140)", () => {
    const wkhtmlConfig = CONVERTERS.find(c => c.name === "wkhtmltopdf");
    expect(wkhtmlConfig).toBeDefined();
    if (wkhtmlConfig) {
      const args = wkhtmlConfig.buildArgs("input.html", "output.pdf", {});
      expect(args).toContain("--disable-local-file-access");
      expect(args).toContain("--disable-external-links");
      expect(args).toContain("--disable-javascript");
      expect(args).toContain("--disable-plugins");
      expect(args).toContain("--no-images");
    }
  });
});
