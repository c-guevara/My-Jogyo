/**
 * Report Markdown Library - Generate publication-quality research reports.
 *
 * Features:
 * - Parse markers from notebook cell outputs
 * - Scan outputs directory for artifacts
 * - Generate markdown reports with sentinel blocks
 * - VibeQuant-style report format
 *
 * Report Structure:
 * - Executive Summary (objective, metrics, status)
 * - Methodology
 * - Performance Metrics table
 * - Key Findings
 * - Output Files
 * - Conclusion
 *
 * @module report-markdown
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { parseMarkers, ParsedMarker, getMarkersByType } from "./marker-parser";
import { durableAtomicWrite, readFileNoFollow } from "./atomic-write";
import { Notebook, NotebookCell } from "./cell-identity";
import { extractFrontmatter, GyoshuFrontmatter } from "./notebook-frontmatter";
import { getNotebookPath, getReportDir, getReportReadmePath, getReportsRootDir, ensureDirSync } from "./paths";
// Literature client deprecated - citations now use fallback identifiers only
// TODO: Re-enable when a reliable citation API is available

/**
 * Minimal citation interface for fallback mode.
 */
interface Citation {
  doi?: string;
  arxivId?: string;
  title?: string;
  authors?: string[];
  year?: number;
}

// =============================================================================
// FINDING VERIFICATION - Separate verified vs unverified findings
// =============================================================================

/**
 * Number of lines to look back for statistical evidence before a finding.
 */
const STAT_LOOKBACK_LINES = 10;

/**
 * Findings separated by verification status.
 */
export interface SeparatedFindings {
  /** Findings with both [STAT:ci] and [STAT:effect_size] nearby */
  verified: ParsedMarker[];
  /** Findings with partial evidence (one of CI or effect_size) */
  partial: ParsedMarker[];
  /** Findings without statistical evidence */
  exploratory: ParsedMarker[];
}

/**
 * Check if a STAT marker with specific subtype exists within N lines before a given line.
 *
 * @param markers - All parsed markers
 * @param targetLine - Line number of the finding
 * @param statSubtype - The STAT subtype to look for (e.g., 'ci', 'effect_size')
 * @param lookback - Number of lines to look back (default: 10)
 * @returns true if the required STAT marker exists within the lookback window
 */
function hasStatMarkerBefore(
  markers: ParsedMarker[],
  targetLine: number,
  statSubtype: string,
  lookback: number = STAT_LOOKBACK_LINES
): boolean {
  const minLine = Math.max(1, targetLine - lookback);

  return markers.some(
    (m) =>
      m.type === "STAT" &&
      m.subtype === statSubtype &&
      m.lineNumber >= minLine &&
      m.lineNumber < targetLine
  );
}

/**
 * Separate findings into verified, partial, and exploratory categories.
 *
 * The "Finding Gating Rule" categorizes findings based on statistical evidence:
 * - Verified: Has both [STAT:ci] and [STAT:effect_size] within 10 lines before
 * - Partial: Has one of [STAT:ci] or [STAT:effect_size]
 * - Exploratory: Missing statistical evidence
 *
 * @param markers - Array of all parsed markers from notebook output
 * @returns SeparatedFindings with verified, partial, and exploratory arrays
 *
 * @example
 * ```typescript
 * const markers = extractMarkersFromNotebook(notebook);
 * const { verified, partial, exploratory } = separateFindings(markers);
 * console.log(`Verified: ${verified.length}, Exploratory: ${exploratory.length}`);
 * ```
 */
export function separateFindings(markers: ParsedMarker[]): SeparatedFindings {
  const findings = getMarkersByType(markers, "FINDING");
  const verified: ParsedMarker[] = [];
  const partial: ParsedMarker[] = [];
  const exploratory: ParsedMarker[] = [];

  for (const finding of findings) {
    const hasCI = hasStatMarkerBefore(markers, finding.lineNumber, "ci");
    const hasEffectSize = hasStatMarkerBefore(markers, finding.lineNumber, "effect_size");

    if (hasCI && hasEffectSize) {
      verified.push(finding);
    } else if (hasCI || hasEffectSize) {
      partial.push(finding);
    } else {
      exploratory.push(finding);
    }
  }

  return { verified, partial, exploratory };
}

/**
 * Required sections for IMRAD report structure validation.
 */
export interface RequiredSection {
  /** Marker type to check for */
  marker: string;
  /** Report section name */
  section: string;
  /** Description of what's missing */
  description: string;
}

/**
 * IMRAD sections and their corresponding markers.
 */
const REQUIRED_IMRAD_SECTIONS: RequiredSection[] = [
  { marker: "OBJECTIVE", section: "Introduction", description: "No research objective defined" },
  { marker: "EXPERIMENT", section: "Methods", description: "No experimental methodology described" },
  { marker: "FINDING", section: "Results", description: "No findings reported" },
  { marker: "CONCLUSION", section: "Conclusion", description: "No conclusions drawn" },
];

/**
 * Validate that required IMRAD sections are present.
 *
 * @param markers - Array of all parsed markers
 * @returns Array of missing section info (empty if all sections present)
 */
export function validateIMRADSections(
  markers: ParsedMarker[]
): RequiredSection[] {
  const missing: RequiredSection[] = [];

  for (const req of REQUIRED_IMRAD_SECTIONS) {
    const found = getMarkersByType(markers, req.marker);
    if (found.length === 0) {
      missing.push(req);
    }
  }

  return missing;
}

// =============================================================================
// CITATION SUPPORT - Collect and resolve literature citations
// =============================================================================

/**
 * A resolved citation ready for the References section.
 */
export interface ResolvedCitation {
  /** Original identifier from the marker (DOI or arXiv ID) */
  identifier: string;
  /** Citation number in the report (1-indexed) */
  number: number;
  /** Resolved citation metadata (null if resolution failed) */
  citation: Citation | null;
  /** Formatted APA string (or fallback if resolution failed) */
  formatted: string;
}

/**
 * Determines if an identifier is an arXiv ID.
 * arXiv IDs are typically: YYMM.NNNNN or older format like hep-ph/9901234
 */
function isArxivId(identifier: string): boolean {
  // New format: YYMM.NNNNN (e.g., 2301.12345)
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(identifier)) {
    return true;
  }
  // Old format: category/YYMMNNN (e.g., hep-ph/9901234)
  if (/^[a-z-]+\/\d{7}$/i.test(identifier)) {
    return true;
  }
  return false;
}

/**
 * Extract citation markers and their identifiers from parsed markers.
 *
 * @param markers - Array of parsed markers
 * @returns Array of unique citation identifiers in order of first appearance
 */
export function collectCitationIdentifiers(markers: ParsedMarker[]): string[] {
  const citationMarkers = getMarkersByType(markers, "CITATION");
  const identifiers: string[] = [];
  const seen = new Set<string>();

  for (const marker of citationMarkers) {
    // The identifier is in the subtype (e.g., [CITATION:10.1145/2939672.2939785])
    const identifier = marker.subtype?.trim();
    if (identifier && !seen.has(identifier)) {
      seen.add(identifier);
      identifiers.push(identifier);
    }
  }

  return identifiers;
}

export async function resolveCitations(identifiers: string[]): Promise<ResolvedCitation[]> {
  return identifiers.map((identifier, i) => ({
    identifier,
    number: i + 1,
    citation: null,
    formatted: isArxivId(identifier)
      ? `arXiv:${identifier}`
      : `https://doi.org/${identifier}`,
  }));
}

export interface ArtifactEntry {
  filename: string;
  relativePath: string;
  sizeBytes: number;
  sizeFormatted: string;
  type: "figure" | "model" | "export" | "other";
  description?: string;
}

/**
 * Context object containing all research data suitable for AI report generation.
 * This structured format allows the AI paper writer to generate narrative reports.
 */
export interface ReportContext {
  /** Research title derived from reportTitle or slug */
  title: string;
  /** Primary research objective */
  objective: string;
  /** List of hypotheses tested */
  hypotheses: string[];
  /** Description of methodology used (if available) */
  methodology: string;
  /** Key findings discovered during research */
  findings: string[];
  /** Named metrics with values */
  metrics: Array<{ name: string; value: string }>;
  /** Known limitations of the research */
  limitations: string[];
  /** Suggested next steps */
  nextSteps: string[];
  /** Artifacts created during research */
  artifacts: ArtifactEntry[];
  /** Combined raw cell outputs for additional context */
  rawOutputs: string;
  /** Notebook frontmatter metadata */
  frontmatter?: GyoshuFrontmatter;
  /** Conclusion statement if available */
  conclusion?: string;
}

export interface MetricEntry {
  name: string;
  value: string;
  subtype?: string;
}

export interface ExecutionHistoryEntry {
  stageId: string;
  status: "completed" | "interrupted" | "failed";
  duration?: string;
  startedAt?: string;
}

export interface ReportModel {
  title: string;
  objective?: string;
  hypotheses: string[];
  methodology?: string;
  metrics: MetricEntry[];
  findings: string[];
  separatedFindings?: SeparatedFindings;
  limitations: string[];
  nextSteps: string[];
  conclusion?: string;
  artifacts: ArtifactEntry[];
  frontmatter?: GyoshuFrontmatter;
  generatedAt: string;
  executionHistory?: ExecutionHistoryEntry[];
  missingSections?: RequiredSection[];
  citations?: ResolvedCitation[];
}

const SENTINEL_BEGIN = (name: string) => `<!-- GYOSHU:REPORT:${name}:BEGIN -->`;
const SENTINEL_END = (name: string) => `<!-- GYOSHU:REPORT:${name}:END -->`;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function inferArtifactType(filepath: string): ArtifactEntry["type"] {
  const dir = path.dirname(filepath);
  const ext = path.extname(filepath).toLowerCase();

  if (dir.includes("figures") || dir.includes("plots")) return "figure";
  if (dir.includes("models")) return "model";
  if (dir.includes("exports") || dir.includes("data")) return "export";

  if ([".png", ".jpg", ".jpeg", ".svg", ".pdf"].includes(ext)) return "figure";
  if ([".pkl", ".joblib", ".pt", ".h5", ".onnx"].includes(ext)) return "model";
  if ([".csv", ".parquet", ".json", ".xlsx"].includes(ext)) return "export";

  return "other";
}

export function extractMarkersFromNotebook(notebook: Notebook): ParsedMarker[] {
  const allText: string[] = [];

  for (const cell of notebook.cells) {
    if (cell.cell_type !== "code" || !cell.outputs) continue;

    for (const output of cell.outputs as Array<Record<string, unknown>>) {
      if (output.output_type === "stream" && output.name === "stdout") {
        const text = Array.isArray(output.text)
          ? (output.text as string[]).join("")
          : String(output.text || "");
        allText.push(text);
      }
    }
  }

  return parseMarkers(allText.join("\n")).markers;
}

export async function scanOutputsDirectory(outputsDir: string): Promise<ArtifactEntry[]> {
  const artifacts: ArtifactEntry[] = [];

  async function scanDir(dir: string, basePath: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(basePath, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath, relativePath);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.lstat(fullPath);
            if (stat.isSymbolicLink()) {
              continue; // Skip symlinks for security
            }
            artifacts.push({
              filename: entry.name,
              relativePath,
              sizeBytes: stat.size,
              sizeFormatted: formatBytes(stat.size),
              type: inferArtifactType(relativePath),
            });
          } catch {
            // Skip files we can't stat
          }
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }
  }

  await scanDir(outputsDir, "");
  return artifacts;
}

export function buildReportModel(
  frontmatter: GyoshuFrontmatter | undefined,
  markers: ParsedMarker[],
  artifacts: ArtifactEntry[]
): ReportModel {
  const objectives = getMarkersByType(markers, "OBJECTIVE");
  const hypotheses = getMarkersByType(markers, "HYPOTHESIS");
  const findings = getMarkersByType(markers, "FINDING");
  const conclusions = getMarkersByType(markers, "CONCLUSION");
  const metrics = getMarkersByType(markers, "METRIC");
  const limitations = getMarkersByType(markers, "LIMITATION");
  const nextSteps = getMarkersByType(markers, "NEXT_STEP");

  const titleSource = frontmatter?.reportTitle || frontmatter?.slug;
  const title = titleSource
    ? titleSource
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
    : "Research";

  const stageMarkers = getMarkersByType(markers, "STAGE");
  const executionHistory: ExecutionHistoryEntry[] = [];

  for (const marker of stageMarkers) {
    if (marker.subtype === "end" && marker.attributes) {
      executionHistory.push({
        stageId: marker.attributes.id || "unknown",
        status: marker.attributes.status === "interrupted" ? "interrupted" : "completed",
        duration: marker.attributes.duration,
      });
    }
  }

  const separated = separateFindings(markers);
  const missingSections = validateIMRADSections(markers);

  return {
    title,
    objective: objectives[0]?.content,
    hypotheses: hypotheses.map((m) => m.content),
    methodology: undefined,
    metrics: metrics.map((m) => ({
      name: m.subtype || "metric",
      value: m.content,
      subtype: m.subtype,
    })),
    findings: findings.map((m) => m.content),
    separatedFindings: separated,
    limitations: limitations.map((m) => m.content),
    nextSteps: nextSteps.map((m) => m.content),
    conclusion: conclusions[conclusions.length - 1]?.content,
    artifacts,
    frontmatter,
    generatedAt: new Date().toISOString(),
    executionHistory: executionHistory.length > 0 ? executionHistory : undefined,
    missingSections: missingSections.length > 0 ? missingSections : undefined,
  };
}

export function renderReportMarkdown(model: ReportModel): string {
  const lines: string[] = [];

  lines.push(`# ${model.title} Research Report`);
  lines.push("");

  lines.push(SENTINEL_BEGIN("EXEC_SUMMARY"));
  lines.push("## Executive Summary");
  lines.push("");
  if (model.objective) {
    lines.push(`**Research Goal**: ${model.objective}`);
  }
  if (model.metrics.length > 0) {
    const metricSummary = model.metrics
      .slice(0, 3)
      .map((m) => `${m.name}=${m.value}`)
      .join(", ");
    lines.push(`**Key Metrics**: ${metricSummary}`);
  }
  const status = model.frontmatter?.status || "active";
  lines.push(`**Status**: ${status.charAt(0).toUpperCase() + status.slice(1)}`);
  lines.push("");
  lines.push(SENTINEL_END("EXEC_SUMMARY"));
  lines.push("");

  if (model.hypotheses.length > 0) {
    lines.push(SENTINEL_BEGIN("HYPOTHESES"));
    lines.push("## Hypotheses");
    lines.push("");
    for (const h of model.hypotheses) {
      lines.push(`- ${h}`);
    }
    lines.push("");
    lines.push(SENTINEL_END("HYPOTHESES"));
    lines.push("");
  }

  if (model.metrics.length > 0) {
    lines.push(SENTINEL_BEGIN("METRICS"));
    lines.push("## Performance Metrics");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    for (const m of model.metrics) {
      lines.push(`| ${m.name} | ${m.value} |`);
    }
    lines.push("");
    lines.push(SENTINEL_END("METRICS"));
    lines.push("");
  }

  if (model.separatedFindings) {
    const { verified, partial, exploratory } = model.separatedFindings;

    if (verified.length > 0) {
      lines.push(SENTINEL_BEGIN("VERIFIED_FINDINGS"));
      lines.push("## Key Findings (Verified)");
      lines.push("");
      lines.push("*These findings have full statistical evidence (CI + effect size).*");
      lines.push("");
      for (let i = 0; i < verified.length; i++) {
        lines.push(`${i + 1}. ${verified[i].content}`);
      }
      lines.push("");
      lines.push(SENTINEL_END("VERIFIED_FINDINGS"));
      lines.push("");
    }

    if (partial.length > 0) {
      lines.push(SENTINEL_BEGIN("PARTIAL_FINDINGS"));
      lines.push("## Findings (Partial Evidence)");
      lines.push("");
      lines.push("*These findings have partial statistical evidence.*");
      lines.push("");
      for (let i = 0; i < partial.length; i++) {
        lines.push(`${i + 1}. ${partial[i].content}`);
      }
      lines.push("");
      lines.push(SENTINEL_END("PARTIAL_FINDINGS"));
      lines.push("");
    }

    if (exploratory.length > 0) {
      lines.push(SENTINEL_BEGIN("EXPLORATORY"));
      lines.push("## Exploratory Observations");
      lines.push("");
      lines.push("*These observations lack full statistical evidence and should be verified.*");
      lines.push("");
      for (let i = 0; i < exploratory.length; i++) {
        lines.push(`${i + 1}. ${exploratory[i].content}`);
      }
      lines.push("");
      lines.push(SENTINEL_END("EXPLORATORY"));
      lines.push("");
    }
  } else if (model.findings.length > 0) {
    lines.push(SENTINEL_BEGIN("FINDINGS"));
    lines.push("## Key Findings");
    lines.push("");
    for (let i = 0; i < model.findings.length; i++) {
      lines.push(`${i + 1}. ${model.findings[i]}`);
    }
    lines.push("");
    lines.push(SENTINEL_END("FINDINGS"));
    lines.push("");
  }

  if (model.limitations.length > 0) {
    lines.push(SENTINEL_BEGIN("LIMITATIONS"));
    lines.push("## Limitations");
    lines.push("");
    for (const l of model.limitations) {
      lines.push(`- ${l}`);
    }
    lines.push("");
    lines.push(SENTINEL_END("LIMITATIONS"));
    lines.push("");
  }

  if (model.artifacts.length > 0) {
    lines.push(SENTINEL_BEGIN("ARTIFACTS"));
    lines.push("## Output Files");
    lines.push("");

    const sorted = [...model.artifacts].sort((a, b) => {
      const order = { figure: 0, export: 1, model: 2, other: 3 };
      return order[a.type] - order[b.type];
    });

    for (const a of sorted) {
      if (a.type === "figure") {
        // Embed figures as images for direct viewing in markdown
        const altText = a.description || path.basename(a.filename, path.extname(a.filename));
        lines.push(`![${altText}](${a.relativePath})`);
        lines.push(`*${a.filename} (${a.sizeFormatted})*`);
        lines.push("");
      } else {
        // Keep other artifacts as file links
        const desc = a.description || `${a.type} file`;
        lines.push(`- \`${a.relativePath}\` (${a.sizeFormatted}) - ${desc}`);
      }
    }
    lines.push("");
    lines.push(SENTINEL_END("ARTIFACTS"));
    lines.push("");
  }

  if (model.nextSteps.length > 0) {
    lines.push(SENTINEL_BEGIN("NEXT_STEPS"));
    lines.push("## Recommended Next Steps");
    lines.push("");
    for (const n of model.nextSteps) {
      lines.push(`- ${n}`);
    }
    lines.push("");
    lines.push(SENTINEL_END("NEXT_STEPS"));
    lines.push("");
  }

  if (model.executionHistory && model.executionHistory.length > 0) {
    lines.push(SENTINEL_BEGIN("EXECUTION_HISTORY"));
    lines.push("## Execution History");
    lines.push("");
    lines.push("| Stage | Status | Duration |");
    lines.push("|-------|--------|----------|");
    for (const entry of model.executionHistory) {
      const status = entry.status === "completed" ? "✅" : "⚠️";
      lines.push(`| ${entry.stageId} | ${status} ${entry.status} | ${entry.duration || "-"} |`);
    }
    lines.push("");

    const interrupts = model.executionHistory.filter(e => e.status === "interrupted");
    if (interrupts.length > 0) {
      lines.push(`*Note: ${interrupts.length} stage(s) were interrupted and resumed.*`);
      lines.push("");
    }

    lines.push(SENTINEL_END("EXECUTION_HISTORY"));
    lines.push("");
  }

  if (model.missingSections && model.missingSections.length > 0) {
    lines.push(SENTINEL_BEGIN("MISSING_SECTIONS"));
    lines.push("## Missing IMRAD Sections");
    lines.push("");
    lines.push("*The following required report sections are missing:*");
    lines.push("");
    for (const section of model.missingSections) {
      lines.push(`- **${section.section}**: [SECTION MISSING: No [${section.marker}] marker found]`);
    }
    lines.push("");
    lines.push(SENTINEL_END("MISSING_SECTIONS"));
    lines.push("");
  }

  if (model.citations && model.citations.length > 0) {
    lines.push(SENTINEL_BEGIN("REFERENCES"));
    lines.push("## References");
    lines.push("");
    for (const citation of model.citations) {
      lines.push(`${citation.number}. ${citation.formatted}`);
    }
    lines.push("");
    lines.push(SENTINEL_END("REFERENCES"));
    lines.push("");
  }

  if (model.conclusion) {
    lines.push(SENTINEL_BEGIN("CONCLUSION"));
    lines.push("## Conclusion");
    lines.push("");
    lines.push(model.conclusion);
    lines.push("");
    lines.push(SENTINEL_END("CONCLUSION"));
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Generated: ${model.generatedAt}*`);
  lines.push("");

  return lines.join("\n");
}

export async function generateReport(
  reportTitle: string
): Promise<{ reportPath: string; model: ReportModel }> {
  const notebookPath = getNotebookPath(reportTitle);
  const reportDir = getReportDir(reportTitle);
  const reportPath = getReportReadmePath(reportTitle);

  let notebook: Notebook;
  try {
    const content = await readFileNoFollow(notebookPath);
    notebook = JSON.parse(content) as Notebook;
  } catch (e) {
    throw new Error(`Failed to read notebook: ${(e as Error).message}`);
  }

  const frontmatter = extractFrontmatter(notebook);
  const markers = extractMarkersFromNotebook(notebook);

  // FIX-176: Validate reportDir is not a symlink before scanning
  let artifacts: ArtifactEntry[] = [];
  try {
    const stat = fsSync.lstatSync(reportDir);
    if (!stat.isSymbolicLink() && stat.isDirectory()) {
      artifacts = await scanOutputsDirectory(reportDir);
    }
  } catch {
    // Directory doesn't exist yet, empty artifacts
  }

  const model = buildReportModel(frontmatter, markers, artifacts);

  const citationIdentifiers = collectCitationIdentifiers(markers);
  if (citationIdentifiers.length > 0) {
    model.citations = await resolveCitations(citationIdentifiers);
  }

  const markdown = renderReportMarkdown(model);

  ensureDirSync(reportDir, 0o755);
  await durableAtomicWrite(reportPath, markdown);

  return { reportPath, model };
}

export async function readExistingReport(reportPath: string): Promise<string | null> {
  try {
    return await readFileNoFollow(reportPath);
  } catch {
    return null;
  }
}

function extractRawOutputsFromNotebook(notebook: Notebook): string {
  const outputs: string[] = [];

  for (const cell of notebook.cells) {
    if (cell.cell_type !== "code" || !cell.outputs) continue;

    for (const output of cell.outputs as Array<Record<string, unknown>>) {
      if (output.output_type === "stream" && output.name === "stdout") {
        const text = Array.isArray(output.text)
          ? (output.text as string[]).join("")
          : String(output.text || "");
        outputs.push(text);
      }
    }
  }

  return outputs.join("\n");
}

function formatTitleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function gatherReportContext(reportTitle: string): Promise<ReportContext> {
  const notebookPath = getNotebookPath(reportTitle);
  const reportDir = getReportDir(reportTitle);

  let notebook: Notebook;
  try {
    const content = await readFileNoFollow(notebookPath);
    notebook = JSON.parse(content) as Notebook;
  } catch (e) {
    throw new Error(`Failed to read notebook for context: ${(e as Error).message}`);
  }

  const frontmatter = extractFrontmatter(notebook);
  const markers = extractMarkersFromNotebook(notebook);

  // FIX-176: Validate reportDir is not a symlink before scanning
  let artifacts: ArtifactEntry[] = [];
  try {
    const stat = fsSync.lstatSync(reportDir);
    if (!stat.isSymbolicLink() && stat.isDirectory()) {
      artifacts = await scanOutputsDirectory(reportDir);
    }
  } catch {
    // Directory doesn't exist yet
  }

  // SECURITY: rawOutputs is untrusted notebook output - do not execute as code.
  // Limit size to prevent memory issues with large outputs.
  const MAX_RAW_OUTPUT_LENGTH = 10000;
  const allOutputText = extractRawOutputsFromNotebook(notebook);
  const rawOutputs = allOutputText.slice(0, MAX_RAW_OUTPUT_LENGTH);

  const objectives = getMarkersByType(markers, "OBJECTIVE");
  const hypotheses = getMarkersByType(markers, "HYPOTHESIS");
  const findings = getMarkersByType(markers, "FINDING");
  const conclusions = getMarkersByType(markers, "CONCLUSION");
  const metrics = getMarkersByType(markers, "METRIC");
  const limitations = getMarkersByType(markers, "LIMITATION");
  const nextSteps = getMarkersByType(markers, "NEXT_STEP");
  const experiments = getMarkersByType(markers, "EXPERIMENT");
  const analyses = getMarkersByType(markers, "ANALYSIS");

  const titleSource = frontmatter?.reportTitle || frontmatter?.slug || reportTitle;
  const title = formatTitleFromSlug(titleSource);

  const methodologyParts: string[] = [];
  if (experiments.length > 0) {
    methodologyParts.push(...experiments.map((m) => m.content));
  }
  if (analyses.length > 0 && methodologyParts.length === 0) {
    methodologyParts.push(analyses[0]?.content || "");
  }

  return {
    title,
    objective: objectives[0]?.content || "",
    hypotheses: hypotheses.map((m) => m.content),
    methodology: methodologyParts.join(" "),
    findings: findings.map((m) => m.content),
    metrics: metrics.map((m) => ({
      name: m.subtype || "metric",
      value: m.content,
    })),
    limitations: limitations.map((m) => m.content),
    nextSteps: nextSteps.map((m) => m.content),
    artifacts,
    rawOutputs,
    frontmatter,
    conclusion: conclusions[conclusions.length - 1]?.content,
  };
}

export function upsertSentinelBlock(
  existingContent: string,
  blockName: string,
  newContent: string
): string {
  const beginMarker = SENTINEL_BEGIN(blockName);
  const endMarker = SENTINEL_END(blockName);

  const pattern = new RegExp(
    `${beginMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${endMarker.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    )}`,
    "g"
  );

  if (pattern.test(existingContent)) {
    return existingContent.replace(pattern, `${beginMarker}\n${newContent}\n${endMarker}`);
  }

  return existingContent + `\n${beginMarker}\n${newContent}\n${endMarker}\n`;
}
