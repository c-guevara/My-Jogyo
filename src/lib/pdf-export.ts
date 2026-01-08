/**
 * PDF Export Library - Convert markdown reports to PDF format.
 *
 * Supports multiple PDF converters in priority order:
 * 1. pandoc (best quality, supports LaTeX math)
 * 2. wkhtmltopdf (good quality, widely available)
 * 3. weasyprint (Python-based, good CSS support)
 *
 * @module pdf-export
 */

import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import { realpathSync } from "fs";
import * as os from "os";
import * as path from "path";
import { atomicReplaceWindows, durableAtomicWrite, readFileNoFollow } from "./atomic-write";

let sanitizeHtmlLib: ((html: string, options: object) => string) | null = null;
try {
  sanitizeHtmlLib = require("sanitize-html");
} catch {
  // Package not available - will use fallback sanitization
}
import { isPathContainedIn } from "./path-security";
import { ensureDirSync, getReportsRootDir } from "./paths";

export type PdfConverter = "pandoc" | "wkhtmltopdf" | "weasyprint";

export interface PdfExportOptions {
  title?: string;
  author?: string;
  date?: string;
  pageSize?: "letter" | "a4";
  margins?: string;
  converter?: PdfConverter;
  cssPath?: string;
  /**
   * Maximum time for the converter subprocess.
   * Defaults to 120s; set `0` to disable timeout.
   */
  timeoutMs?: number;
}

export interface PdfExportResult {
  success: boolean;
  pdfPath?: string;
  converter?: PdfConverter;
  error?: string;
  installHint?: string;
}

interface ConverterConfig {
  name: PdfConverter;
  command: string;
  checkArgs: string[];
  buildArgs: (input: string, output: string, opts: PdfExportOptions) => string[];
  installHint: string;
}

export const CONVERTERS: ConverterConfig[] = [
  {
    name: "pandoc",
    command: "pandoc",
    checkArgs: ["--version"],
    buildArgs: (input, output, opts) => {
      // Security: pandoc reads a sanitized HTML file produced by markdownToHtml() + sanitizeHtml().
      // Use --from=html so pandoc does NOT re-interpret markdown syntax (e.g., images/links) inside text.
      const args = ["--from=html", input, "-o", output, "--pdf-engine=xelatex"];
      if (opts.title) args.push(`--metadata=title:${opts.title}`);
      if (opts.author) args.push(`--metadata=author:${opts.author}`);
      if (opts.pageSize === "a4") args.push("-V", "geometry:a4paper");
      if (opts.margins) args.push("-V", `geometry:margin=${opts.margins}`);
      return args;
    },
    installHint: "Install with: sudo apt install pandoc texlive-xetex (Ubuntu) or brew install pandoc basictex (macOS)",
  },
  {
    name: "wkhtmltopdf",
    command: "wkhtmltopdf",
    checkArgs: ["--version"],
    buildArgs: (input, output, opts) => {
      const args: string[] = [
        "--disable-local-file-access",
        "--disable-external-links",
        "--disable-javascript",
        "--disable-plugins",
        "--no-images",
      ];
      if (opts.pageSize) args.push("--page-size", opts.pageSize.toUpperCase());
      if (opts.margins) {
        args.push("-T", opts.margins, "-B", opts.margins, "-L", opts.margins, "-R", opts.margins);
      }
      if (opts.title) args.push("--title", opts.title);
      args.push(input, output);
      return args;
    },
    installHint: "Install with: sudo apt install wkhtmltopdf (Ubuntu) or brew install wkhtmltopdf (macOS)",
  },
  {
    name: "weasyprint",
    command: "weasyprint",
    checkArgs: ["--version"],
    buildArgs: (input, output, opts) => {
      // Defense-in-depth: --base-url "" provides limited protection
      // Primary SSRF defense is HTML sanitization in sanitizeHtml()
      const args = ["--base-url", "", input, output];
      if (opts.cssPath) args.push("-s", opts.cssPath);
      return args;
    },
    installHint: "Install with: pip install weasyprint",
  },
];

const COMMAND_EXISTS_TIMEOUT_MS = 5000;
const DEFAULT_CONVERTER_TIMEOUT_MS = 120000;

async function commandExists(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: "ignore" });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      resolve(false);
    }, COMMAND_EXISTS_TIMEOUT_MS);

    proc.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(false);
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

export async function detectAvailableConverters(): Promise<PdfConverter[]> {
  const available: PdfConverter[] = [];

  for (const converter of CONVERTERS) {
    if (await commandExists(converter.command, converter.checkArgs)) {
      available.push(converter.name);
    }
  }

  return available;
}

export async function getPreferredConverter(): Promise<ConverterConfig | null> {
  for (const converter of CONVERTERS) {
    if (await commandExists(converter.command, converter.checkArgs)) {
      return converter;
    }
  }
  return null;
}

// FIX-166: Clamp timeout to sane bounds to prevent DoS via infinite timeout
const MAX_TIMEOUT_MS = 3600000;  // 1 hour max
const MIN_TIMEOUT_MS = 1000;     // 1 second min

function getConverterTimeoutMs(opts: PdfExportOptions): number {
  // FIX-171: Type check opts.timeoutMs before Math.trunc (Math.trunc(null) = 0)
  if (typeof opts.timeoutMs === 'number') {
    const value = Math.trunc(opts.timeoutMs);
    // 0 means "no timeout" - allow it but clamp positive values
    if (value === 0) return 0;
    return Math.max(MIN_TIMEOUT_MS, Math.min(value, MAX_TIMEOUT_MS));
  }

  // FIX-170: Max-length guard for env var (prevents parse-time overhead DoS)
  const envValue = process.env.GYOSHU_PDF_EXPORT_TIMEOUT_MS;
  if (envValue && envValue.length <= 20) {
    const parsed = Number(envValue);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.max(MIN_TIMEOUT_MS, Math.min(Math.trunc(parsed), MAX_TIMEOUT_MS));
      }
    }

  return DEFAULT_CONVERTER_TIMEOUT_MS;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // FIX-151: Spawn in own process group on POSIX so timeout can kill entire group
    const proc = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    // FIX-152: Cap stderr at 64KB to prevent memory bloat
    const MAX_STDERR_CHARS = 64 * 1024;

    const finalize = (code: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({ code, stderr, timedOut });
    };

    proc.stderr?.on("data", (data) => {
      // FIX-152: Skip accumulation once truncated
      if (stderrTruncated) return;
      const chunk = data.toString();
      if (stderr.length + chunk.length > MAX_STDERR_CHARS) {
        stderr = stderr.slice(0, MAX_STDERR_CHARS - 20) + "\n...[truncated]";
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    proc.on("error", (err) => {
      if (!stderrTruncated) {
        stderr += err.message;
      }
      finalize(1);
    });

    proc.on("close", (code) => {
      finalize(code ?? 1);
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        if (!stderrTruncated) {
          stderr += (stderr ? "\n" : "") + `Timed out after ${timeoutMs}ms`;
        }
        try {
          // FIX-151: Kill entire process group on POSIX (e.g., pandoc spawns xelatex)
          if (process.platform === "win32") {
            proc.kill("SIGKILL");
          } else {
            // Negative PID kills the process group
            try {
              process.kill(-proc.pid!, "SIGKILL");
            } catch {
              // Fallback to just the process if group kill fails
              proc.kill("SIGKILL");
            }
          }
        } catch {
          // Ignore kill errors
        }
        finalize(124);
      }, timeoutMs);
    }
  });
}

async function convertWithHtml(
  markdownPath: string,
  pdfPath: string,
  converter: ConverterConfig,
  opts: PdfExportOptions
): Promise<PdfExportResult> {
  // Security: readFileNoFollow uses O_NOFOLLOW to atomically reject symlinks
  // at open time, preventing TOCTOU race conditions
  let markdown: string;
  try {
    markdown = await readFileNoFollow(markdownPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      return { success: false, error: "Security: markdown path is a symlink" };
    }
    throw err;
  }
  const htmlContent = markdownToHtml(markdown, opts);

  // Security: Use OS temp directory for intermediate HTML file to avoid
  // writing attacker-controlled content next to user-provided markdown paths
  // FIX-118: Use crypto.randomUUID() for unpredictable temp path (prevents race condition attacks)
  // FIX-122: Use realpathSync to resolve TMPDIR symlinks on macOS (e.g., /var -> /private/var)
  // This prevents ensureDirSync failures when TMPDIR path contains symlinks
  const tmpDir = realpathSync(os.tmpdir());
  const htmlPath = path.join(tmpDir, `gyoshu-pdf-${crypto.randomUUID()}.html`);
  await durableAtomicWrite(htmlPath, htmlContent);

  // FIX-113: Check if pdfPath already exists as symlink (prevent symlink overwrite attack)
  try {
    const outputStat = await fs.lstat(pdfPath);
    if (outputStat.isSymbolicLink()) {
      await fs.unlink(htmlPath).catch(() => {});
      return { success: false, error: "Security: output path is a symlink" };
    }
  } catch (err) {
    // ENOENT is fine - file doesn't exist yet
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      await fs.unlink(htmlPath).catch(() => {});
      throw err;
    }
  }

  // FIX-113: Write to temp output then atomic rename (prevents partial writes and symlink races)
  const tempPdfPath = `${pdfPath}.tmp.${crypto.randomUUID()}`;
  let success = false;

  try {
    const args = converter.buildArgs(htmlPath, tempPdfPath, opts);
    const timeoutMs = getConverterTimeoutMs(opts);
    const result = await runCommand(converter.command, args, timeoutMs);

    if (result.code !== 0) {
      return {
        success: false,
        converter: converter.name,
        error: result.timedOut
          ? `Conversion timed out after ${timeoutMs}ms: ${result.stderr}`
          : `Conversion failed: ${result.stderr}`,
      };
    }

    // FIX-113: Atomic rename temp to final output
    if (process.platform === "win32") {
      await atomicReplaceWindows(tempPdfPath, pdfPath);
    } else {
      await fs.rename(tempPdfPath, pdfPath);
    }

    success = true;
    return {
      success: true,
      pdfPath,
      converter: converter.name,
    };
  } finally {
    await fs.unlink(htmlPath).catch(() => {});
    if (!success) {
      // Only clean up temp output on failure (on success, it was renamed)
      await fs.unlink(tempPdfPath).catch(() => {});
    }
  }
}

/**
 * Sanitize HTML to prevent SSRF and local file disclosure.
 * This is the PRIMARY security control - converter flags are defense-in-depth only.
 *
 * Uses allowlist-based sanitization via sanitize-html library.
 * Only permits safe structural tags with no URL-bearing attributes.
 */
function sanitizeHtml(html: string): string {
  if (sanitizeHtmlLib) {
    return sanitizeHtmlLib(html, {
      allowedTags: [
        "h1", "h2", "h3", "h4", "h5", "h6",
        "p", "br", "hr",
        "ul", "ol", "li",
        "blockquote", "pre", "code",
        "table", "thead", "tbody", "tr", "th", "td",
        "strong", "em", "b", "i", "u", "s",
        "span", "div",
        "a",
      ],
      allowedAttributes: {
        a: [],
        th: ["colspan", "rowspan"],
        td: ["colspan", "rowspan"],
        "*": ["class"],
      },
      allowedSchemes: [],
      allowedSchemesByTag: {},
      allowedStyles: {},
      disallowedTagsMode: "discard",
      allowProtocolRelative: false,
    });
  }
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/\s(on\w+|href|src|style)="[^"]*"/gi, "")
    .replace(/\s(on\w+|href|src|style)='[^']*'/gi, "");
}

/**
 * Sanitize plain text to prevent HTML/template injection.
 * Used for user-provided values that go into HTML template.
 */
function sanitizeText(text: string): string {
  return text.replace(/[<>&"']/g, (c) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[c] || c;
  });
}

/**
 * Sanitize CSS value to prevent injection attacks.
 * Only allows safe characters for margin/size values.
 */
function sanitizeCssValue(value: string): string {
  // Only allow alphanumeric, dots, spaces, and common CSS units
  // Blocks: url(), expression(), @import, javascript:, etc.
  const sanitized = value.replace(/[^a-zA-Z0-9.\s%-]/g, "");
  return sanitized || "2.5cm"; // Fallback to safe default
}

function markdownToHtml(markdown: string, opts: PdfExportOptions): string {
  let html = markdown
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    .replace(/\n\n/g, "</p><p>")
    .replace(/<!--[^>]+-->/g, "");

  html = processMarkdownTables(html);
  html = sanitizeHtml(html);

  const safeTitle = sanitizeText(opts.title || "Research Report");
  const safeMargins = sanitizeCssValue(opts.margins || "2.5cm");
  const pageSize = opts.pageSize === "a4" ? "A4" : "letter";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <style>
    @page { size: ${pageSize}; margin: ${safeMargins}; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #333; padding-bottom: 10px; }
    h2 { color: #2a2a2a; margin-top: 30px; }
    table { border-collapse: collapse; width: 100%; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
    th { background-color: #f5f5f5; font-weight: 600; }
    tr:nth-child(even) { background-color: #fafafa; }
    code { background-color: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-family: 'SF Mono', Monaco, monospace; }
    ul, ol { padding-left: 25px; }
    li { margin: 5px 0; }
    hr { border: none; border-top: 1px solid #eee; margin: 30px 0; }
    em { color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
<p>${html}</p>
</body>
</html>`;
}

function processMarkdownTables(html: string): string {
  const tableRegex = /\|(.+)\|\n\|[-| ]+\|\n((?:\|.+\|\n?)+)/g;

  return html.replace(tableRegex, (match, headerRow, bodyRows) => {
    const headers = headerRow
      .split("|")
      .filter((h: string) => h.trim())
      .map((h: string) => `<th>${h.trim()}</th>`)
      .join("");

    const rows = bodyRows
      .trim()
      .split("\n")
      .map((row: string) => {
        const cells = row
          .split("|")
          .filter((c: string) => c.trim())
          .map((c: string) => `<td>${c.trim()}</td>`)
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");

    return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  });
}

export async function exportToPdf(
  markdownPath: string,
  pdfPath?: string,
  options: PdfExportOptions = {}
): Promise<PdfExportResult> {
  const inputPath = path.resolve(markdownPath);
  const outputPath = pdfPath ? path.resolve(pdfPath) : inputPath.replace(/\.md$/, ".pdf");

  try {
    await fs.access(inputPath);
  } catch {
    return {
      success: false,
      error: `Input file not found: ${markdownPath}`,
    };
  }

  // Security: reject symlinks to prevent file disclosure
  const inputStat = await fs.lstat(inputPath);
  if (inputStat.isSymbolicLink()) {
    return { success: false, error: "Security: input file is a symlink" };
  }

  let converter: ConverterConfig | null = null;

  if (options.converter) {
    converter = CONVERTERS.find((c) => c.name === options.converter) || null;
    if (converter && !(await commandExists(converter.command, converter.checkArgs))) {
      return {
        success: false,
        error: `Requested converter '${options.converter}' is not installed`,
        installHint: converter.installHint,
      };
    }
  } else {
    converter = await getPreferredConverter();
  }

  if (!converter) {
    const hints = CONVERTERS.map((c) => `  - ${c.name}: ${c.installHint}`).join("\n");
    return {
      success: false,
      error: "No PDF converter found",
      installHint: `Install one of the following:\n${hints}`,
    };
  }

  // Security: validate output path is contained within reports directory
  // Check parent directory since outputPath (PDF file) may not exist yet
  const parentDir = path.dirname(outputPath);
  const reportsRoot = getReportsRootDir();

  // FIX-148: Fail-fast with a lexical check to avoid creating directories outside reportsRoot
  if (!isPathContainedIn(parentDir, reportsRoot, { useRealpath: false })) {
    return { success: false, error: "Security: output path escapes reports directory" };
  }

  // FIX-146: Create directory first, then validate containment (dir must exist for realpath)
  try {
    ensureDirSync(parentDir);
  } catch (err) {
    return {
      success: false,
      error: `Failed to create output directory: ${(err as Error).message}`,
    };
  }

  // Symlink-aware containment check (defense against symlink-based escapes)
  if (!isPathContainedIn(parentDir, reportsRoot, { useRealpath: true })) {
    return { success: false, error: "Security: output path escapes reports directory" };
  }

  // FIX-145: Use the available converter (not just non-pandoc) for HTML-based conversion
  // All conversions go through sanitizeHtml() for security, so any converter is safe
  const htmlConverter = converter;
  return convertWithHtml(inputPath, outputPath, htmlConverter, options);
}

export async function exportReportToPdf(
  reportTitle: string,
  options: PdfExportOptions = {}
): Promise<PdfExportResult> {
  const { getReportDir, getReportReadmePath } = await import("./paths");
  
  const reportPath = getReportReadmePath(reportTitle);
  const pdfPath = path.join(getReportDir(reportTitle), "report.pdf");

  try {
    await fs.access(reportPath);
  } catch {
    return {
      success: false,
      error: `Report not found at ${reportPath}. Generate it first.`,
    };
  }

  const titleFromReportTitle = reportTitle
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return exportToPdf(reportPath, pdfPath, {
    title: options.title || `${titleFromReportTitle} Research Report`,
    pageSize: options.pageSize || "letter",
    margins: options.margins || "2.5cm",
    ...options,
  });
}
