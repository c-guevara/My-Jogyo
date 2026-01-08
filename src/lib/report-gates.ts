/**
 * Report Gates Library - Validate report completeness before SUCCESS.
 *
 * This module implements the "Report Gate" (RGEP v1) component of the
 * completion system. It ensures reports are complete and well-formed
 * before research can be marked as SUCCESS.
 *
 * Report Gate Rules:
 * - Report directory must exist: reports/{reportTitle}/
 * - Report file must exist: README.md (the main report)
 * - Required sections must be present: Executive Summary, Key Findings, Conclusion
 * - At least one finding must exist (numbered item in any findings section)
 * - Referenced artifact paths must exist on disk
 *
 * Penalties:
 * - REPORT_DIR_MISSING: -100 (blocks completion)
 * - REPORT_FILE_MISSING: -100 (blocks completion)
 * - SECTION_MISSING: -20 per missing section
 * - NO_FINDINGS: -30
 * - ARTIFACT_MISSING: -10 per missing artifact
 *
 * @module report-gates
 */

import * as fs from "fs";
import * as path from "path";
import { getReportDir, getReportReadmePath, getReportsRootDir, validatePathSegment } from "./paths";
import { readFileNoFollowSync } from "./atomic-write";

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

/**
 * Types of report gate violations.
 */
export type ReportViolationType =
  | "REPORT_TITLE_INVALID"
  | "REPORT_DIR_MISSING"
  | "REPORT_FILE_MISSING"
  | "REPORT_FILE_UNREADABLE"
  | "SECTION_MISSING_EXEC_SUMMARY"
  | "SECTION_MISSING_KEY_FINDINGS"
  | "SECTION_MISSING_CONCLUSION"
  | "NO_FINDINGS"
  | "ARTIFACT_MISSING";

/**
 * A single report gate violation.
 */
export interface ReportViolation {
  /** Type of violation */
  type: ReportViolationType;
  /** Human-readable message */
  message: string;
  /** Score penalty for this violation */
  penalty: number;
  /** Additional details (e.g., missing artifact path) */
  details?: string;
}

/**
 * Overall status of the report gate.
 */
export type ReportGateStatus = "COMPLETE" | "INCOMPLETE" | "MISSING";

/**
 * Summary of sections found in the report.
 */
export interface SectionValidation {
  /** Whether Executive Summary section exists */
  hasExecutiveSummary: boolean;
  /** Whether Key Findings section exists */
  hasKeyFindings: boolean;
  /** Whether Conclusion section exists */
  hasConclusion: boolean;
  /** List of all sections found (for debugging) */
  sectionsFound: string[];
}

/**
 * Result of evaluating the report gate.
 */
export interface ReportGateResult {
  /** Whether all report gate checks passed */
  passed: boolean;
  /** Overall status of the report gate */
  overallStatus: ReportGateStatus;
  /** List of violations found */
  violations: ReportViolation[];
  /** Report completeness score (100 - sum of penalties, min 0) */
  score: number;
  /** Path to the report file (if exists) */
  reportPath?: string;
  /** Summary of sections validation */
  sectionValidation: SectionValidation;
  /** Number of findings (numbered list items in findings sections) */
  findingCount: number;
  /** Number of artifacts found in report directory */
  artifactCount: number;
  /** List of missing artifact paths */
  missingArtifacts?: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Penalty values for each violation type.
 */
const PENALTIES: Record<ReportViolationType, number> = {
  REPORT_TITLE_INVALID: 100,
  REPORT_DIR_MISSING: 100,
  REPORT_FILE_MISSING: 100,
  REPORT_FILE_UNREADABLE: 100,
  SECTION_MISSING_EXEC_SUMMARY: 20,
  SECTION_MISSING_KEY_FINDINGS: 20,
  SECTION_MISSING_CONCLUSION: 20,
  NO_FINDINGS: 30,
  ARTIFACT_MISSING: 10,
};

/**
 * Required section headers (case-insensitive matching).
 */
const REQUIRED_SECTIONS = {
  EXEC_SUMMARY: ["## executive summary", "## exec summary", "## summary"],
  KEY_FINDINGS: ["## key findings", "## findings", "## verified findings", "## key findings (verified)"],
  CONCLUSION: ["## conclusion", "## conclusions"],
};

/**
 * Patterns for findings section headers (case-insensitive).
 * These match the sections where findings are written as numbered list items.
 */
const FINDINGS_SECTION_PATTERNS = [
  /^##\s+key\s+findings/i,
  /^##\s+findings/i,
  /^##\s+verified\s+findings/i,
  /^##\s+key\s+findings\s*\(verified\)/i,
  /^##\s+findings\s*\(partial\s+evidence\)/i,
  /^##\s+exploratory\s+observations/i,
];

/**
 * Pattern to match numbered list items (e.g., "1. Finding content").
 */
const NUMBERED_LIST_PATTERN = /^\d+\.\s+/;

/**
 * Pattern to match any section header.
 */
const SECTION_HEADER_PATTERN = /^##\s+/;

/**
 * Pattern to extract artifact references from markdown.
 * Matches: ![alt](path), [text](path.ext), `path/file.ext`
 * Note: Extensions are case-insensitive (e.g., .PNG, .Pkl are valid)
 */
const ARTIFACT_REF_PATTERN = /!\[[^\]]*\]\(([^)]+)\)|\[[^\]]*\]\(([^\s"']+\.[a-zA-Z0-9]+)[^)]*\)|`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)`/gi;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Validate reportTitle is safe (no path traversal).
 *
 * Security checks (delegated to validatePathSegment):
 * - Must not be empty/whitespace
 * - Must not contain ".." or "." (path traversal)
 * - Must not contain path separators (/, \)
 * - Must not contain null bytes
 * - Must not exceed 255 bytes
 * - Must not be a Windows reserved name (CON, PRN, NUL, COM1-9, LPT1-9, etc.)
 * - Must not have trailing dots or spaces
 *
 * FIX-133: Uses validatePathSegment for comprehensive validation.
 *
 * @param reportTitle - The report title to validate
 * @returns true if the reportTitle is safe, false otherwise
 */
export function isValidReportTitle(reportTitle: string): boolean {
  try {
    validatePathSegment(reportTitle, "reportTitle");
    return true;
  } catch {
    return false;
  }
}

/**
 * FIX-185: Check if any path component between targetPath and rootPath is a symlink.
 */
function hasSymlinkInPath(targetPath: string, rootPath: string): boolean {
  let current = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);

  while (current !== resolvedRoot && current !== path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return true;
    } catch {
      return false;
    }
    current = path.dirname(current);
  }
  return false;
}

/**
 * Check if report directory exists.
 *
 * @param reportTitle - The report title (slug)
 * @returns true if directory exists
 */
export function reportDirExists(reportTitle: string): boolean {
  const reportDir = getReportDir(reportTitle);
  const reportsRoot = getReportsRootDir();

  if (hasSymlinkInPath(reportDir, reportsRoot)) {
    return false;
  }

  try {
    const stat = fs.lstatSync(reportDir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Check if report file exists.
 *
 * @param reportTitle - The report title (slug)
 * @returns true if README.md exists
 */
export function reportFileExists(reportTitle: string): boolean {
  const reportDir = getReportDir(reportTitle);
  try {
    const parentStat = fs.lstatSync(reportDir);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  const reportPath = getReportReadmePath(reportTitle);
  try {
    const stat = fs.lstatSync(reportPath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Read report content from file.
 *
 * @param reportTitle - The report title (slug)
 * @returns Report content or null if file doesn't exist
 */
export function readReportContent(reportTitle: string): string | null {
  const reportDir = getReportDir(reportTitle);
  try {
    const parentStat = fs.lstatSync(reportDir);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  const reportPath = getReportReadmePath(reportTitle);
  try {
    return readFileNoFollowSync(reportPath);
  } catch {
    return null;
  }
}

/**
 * Validate that required sections exist in report content.
 *
 * @param content - Report markdown content
 * @returns Section validation result
 */
export function validateSections(content: string): SectionValidation {
  const contentLower = content.toLowerCase();
  const lines = contentLower.split("\n");
  
  // Find all ## headers
  const sectionsFound: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      sectionsFound.push(trimmed);
    }
  }

  // Check required sections
  const hasExecutiveSummary = REQUIRED_SECTIONS.EXEC_SUMMARY.some(
    (pattern) => sectionsFound.some((s) => s.includes(pattern.slice(3))) // Remove "## " prefix
  );
  
  const hasKeyFindings = REQUIRED_SECTIONS.KEY_FINDINGS.some(
    (pattern) => sectionsFound.some((s) => s.includes(pattern.slice(3)))
  );
  
  const hasConclusion = REQUIRED_SECTIONS.CONCLUSION.some(
    (pattern) => sectionsFound.some((s) => s.includes(pattern.slice(3)))
  );

  return {
    hasExecutiveSummary,
    hasKeyFindings,
    hasConclusion,
    sectionsFound,
  };
}

/**
 * Count findings by counting numbered list items in findings sections.
 *
 * @param content - Report markdown content
 * @returns Number of findings found
 */
export function countFindings(content: string): number {
  const lines = content.split("\n");
  let inFindingsSection = false;
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    const isFindingsHeader = FINDINGS_SECTION_PATTERNS.some((p) =>
      p.test(trimmed)
    );

    if (isFindingsHeader) {
      inFindingsSection = true;
      continue;
    }

    if (inFindingsSection && SECTION_HEADER_PATTERN.test(trimmed)) {
      inFindingsSection = false;
      continue;
    }

    if (inFindingsSection && NUMBERED_LIST_PATTERN.test(trimmed)) {
      count++;
    }
  }

  return count;
}

/**
 * Extract artifact references from report content.
 *
 * Handles:
 * - Image refs with optional titles: ![alt](path.png "title") -> path.png
 * - Whitespace around paths: ![alt]( path.png ) -> path.png
 * - Case-insensitive extensions: .PNG, .Pkl
 *
 * @param content - Report markdown content
 * @returns Array of artifact relative paths
 */
export function extractArtifactRefs(content: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  
  let match;
  ARTIFACT_REF_PATTERN.lastIndex = 0;
  
  while ((match = ARTIFACT_REF_PATTERN.exec(content)) !== null) {
    let ref = match[1] || match[2] || match[3];
    if (ref) {
      // Trim whitespace (handles " path.png " -> "path.png")
      ref = ref.trim();
      
      // Remove optional title from image refs (handles 'path.png "title"' -> 'path.png')
      // Markdown titles start with space followed by single or double quote
      const titleMatch = ref.match(/^([^\s"']+)/);
      if (titleMatch) {
        ref = titleMatch[1];
      }
      
      // Skip URLs, anchors, and already-seen refs
      if (!seen.has(ref) && !ref.startsWith("http") && !ref.startsWith("#") && !ref.startsWith("mailto:")) {
        seen.add(ref);
        refs.push(ref);
      }
    }
  }
  
  return refs;
}

/**
 * Validate that artifact references exist on disk.
 *
 * Security:
 * - Rejects absolute paths
 * - Rejects path traversal attempts (../) using path.normalize()
 * - Handles symlink escapes using fs.realpathSync()
 *
 * Note: Legitimate filenames containing ".." (like "figure..png") are allowed.
 * Invalid paths are treated as missing (added to missing array).
 *
 * @param reportTitle - The report title (slug)
 * @param artifactRefs - Array of artifact relative paths
 * @returns Object with existing and missing artifact lists
 */
export function validateArtifacts(
  reportTitle: string,
  artifactRefs: string[]
): { existing: string[]; missing: string[] } {
  const reportDir = getReportDir(reportTitle);
  const existing: string[] = [];
  const missing: string[] = [];

  // Resolve reportDir to absolute path for security comparison
  const resolvedReportDir = path.resolve(reportDir);

  // Pre-compute realReportDir once outside loop for efficiency
  let realReportDir: string;
  try {
    realReportDir = fs.realpathSync(resolvedReportDir);
  } catch {
    // Report directory doesn't exist - all artifacts are missing
    return { existing: [], missing: [...artifactRefs] };
  }

  for (const ref of artifactRefs) {
    // Security: Reject absolute paths
    if (path.isAbsolute(ref)) {
      missing.push(ref);
      continue;
    }

    // Security: Check for actual parent traversal using path.normalize()
    // This correctly handles:
    // - "figure..png" -> "figure..png" (OK - not traversal, just double dots in filename)
    // - "..foo.png" -> "..foo.png" (OK - filename starting with "..", not traversal)
    // - "../etc/passwd" -> "../etc/passwd" (BLOCKED - ".." followed by path separator)
    // - "figures/../../../etc/passwd" -> "../../etc/passwd" (BLOCKED - starts with ".." segment)
    // - ".." -> ".." (BLOCKED - exact parent directory reference)
    const normalizedRef = path.normalize(ref);
    // Only reject actual ".." segment (exact match or followed by path separator), not filenames starting with ".."
    if (normalizedRef === ".." || normalizedRef.startsWith(".." + path.sep) || path.isAbsolute(normalizedRef)) {
      missing.push(ref);
      continue;
    }

    // Resolve to absolute path
    const fullPath = path.resolve(reportDir, normalizedRef);

    // Security: Ensure resolved path is still under reportDir
    // This catches edge cases where traversal might not use literal ".."
    if (!fullPath.startsWith(resolvedReportDir + path.sep) && fullPath !== resolvedReportDir) {
      missing.push(ref);
      continue;
    }

    // FIX-177: Check if artifact path itself is a symlink BEFORE resolving
    try {
      const artifactStat = fs.lstatSync(fullPath);
      if (artifactStat.isSymbolicLink()) {
        missing.push(ref);
        continue;
      }
    } catch {
      missing.push(ref);
      continue;
    }

    // Security: Handle symlinks - use realpathSync to resolve actual location
    // This prevents symlink escape attacks (e.g., a symlink pointing to /etc/passwd)
    try {
      const realPath = fs.realpathSync(fullPath);

      // Ensure resolved real path is under report directory
      if (!realPath.startsWith(realReportDir + path.sep) && realPath !== realReportDir) {
        missing.push(ref);
        continue;
      }

      // Ensure it's a regular file (not a directory)
      const stat = fs.lstatSync(realPath);
      if (!stat.isFile()) {
        missing.push(ref);
        continue;
      }

      existing.push(ref);
    } catch {
      // File doesn't exist or can't be resolved (broken symlink, permission error, etc.)
      missing.push(ref);
    }
  }

  return { existing, missing };
}

/**
 * Count actual artifacts in report directory (excluding README.md).
 *
 * @param reportTitle - The report title (slug)
 * @returns Number of artifact files found
 */
export function countArtifactsInDir(reportTitle: string): number {
  const reportDir = getReportDir(reportTitle);

  // FIX-176: Reject symlinked report directories
  try {
    const dirStat = fs.lstatSync(reportDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }

  let count = 0;

  function countFiles(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          countFiles(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.toLowerCase() !== "readme.md") {
          count++;
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }
  }

  countFiles(reportDir);
  return count;
}

// =============================================================================
// MAIN EVALUATION FUNCTION
// =============================================================================

/**
 * Evaluate report gate for a given report.
 *
 * Validates:
 * 1. Report directory exists
 * 2. Report file (README.md) exists
 * 3. Required sections present (Executive Summary, Key Findings, Conclusion)
 * 4. At least one finding exists (numbered list item in any findings section)
 * 5. Referenced artifact paths exist on disk
 *
 * @param reportTitle - The report title (slug)
 * @returns ReportGateResult with pass/fail status, violations, and score
 *
 * @example
 * ```typescript
 * const result = evaluateReportGate("customer-churn-analysis");
 * if (!result.passed) {
 *   console.log(`Report score: ${result.score}/100`);
 *   for (const v of result.violations) {
 *     console.log(`- ${v.message} (penalty: -${v.penalty})`);
 *   }
 * }
 * ```
 */
export function evaluateReportGate(reportTitle: string): ReportGateResult {
  const violations: ReportViolation[] = [];
  let overallStatus: ReportGateStatus = "COMPLETE";

  if (!isValidReportTitle(reportTitle)) {
    violations.push({
      type: "REPORT_TITLE_INVALID",
      message: `Invalid report title: ${reportTitle || "(empty)"}`,
      penalty: PENALTIES.REPORT_TITLE_INVALID,
    });
    return {
      passed: false,
      overallStatus: "MISSING",
      violations,
      score: 0,
      sectionValidation: {
        hasExecutiveSummary: false,
        hasKeyFindings: false,
        hasConclusion: false,
        sectionsFound: [],
      },
      findingCount: 0,
      artifactCount: 0,
    };
  }

  // Initialize result fields
  let reportPath: string | undefined;
  let sectionValidation: SectionValidation = {
    hasExecutiveSummary: false,
    hasKeyFindings: false,
    hasConclusion: false,
    sectionsFound: [],
  };
  let findingCount = 0;
  let artifactCount = 0;
  let missingArtifacts: string[] = [];

  if (!reportDirExists(reportTitle)) {
    violations.push({
      type: "REPORT_DIR_MISSING",
      message: `Report directory not found: reports/${reportTitle}/`,
      penalty: PENALTIES.REPORT_DIR_MISSING,
    });
    return {
      passed: false,
      overallStatus: "MISSING",
      violations,
      score: 0,
      sectionValidation,
      findingCount: 0,
      artifactCount: 0,
    };
  }

  if (!reportFileExists(reportTitle)) {
    violations.push({
      type: "REPORT_FILE_MISSING",
      message: `Report file not found: reports/${reportTitle}/README.md`,
      penalty: PENALTIES.REPORT_FILE_MISSING,
    });
    if (overallStatus !== "MISSING") {
      overallStatus = "MISSING";
    }
  } else {
    reportPath = getReportReadmePath(reportTitle);
    
    // Read report content for further validation
    const content = readReportContent(reportTitle);
    if (content !== null) {
      // Check 3: Required sections
      sectionValidation = validateSections(content);
      
      if (!sectionValidation.hasExecutiveSummary) {
        violations.push({
          type: "SECTION_MISSING_EXEC_SUMMARY",
          message: "Report missing required section: Executive Summary",
          penalty: PENALTIES.SECTION_MISSING_EXEC_SUMMARY,
        });
        if (overallStatus === "COMPLETE") {
          overallStatus = "INCOMPLETE";
        }
      }
      
      if (!sectionValidation.hasKeyFindings) {
        violations.push({
          type: "SECTION_MISSING_KEY_FINDINGS",
          message: "Report missing required section: Key Findings",
          penalty: PENALTIES.SECTION_MISSING_KEY_FINDINGS,
        });
        if (overallStatus === "COMPLETE") {
          overallStatus = "INCOMPLETE";
        }
      }
      
      if (!sectionValidation.hasConclusion) {
        violations.push({
          type: "SECTION_MISSING_CONCLUSION",
          message: "Report missing required section: Conclusion",
          penalty: PENALTIES.SECTION_MISSING_CONCLUSION,
        });
        if (overallStatus === "COMPLETE") {
          overallStatus = "INCOMPLETE";
        }
      }

      // Check 4: At least one finding
      findingCount = countFindings(content);
      if (findingCount === 0) {
        violations.push({
          type: "NO_FINDINGS",
          message: "Report contains no findings (numbered items in findings sections)",
          penalty: PENALTIES.NO_FINDINGS,
        });
        if (overallStatus === "COMPLETE") {
          overallStatus = "INCOMPLETE";
        }
      }

      // Check 5: Artifact references exist
      const artifactRefs = extractArtifactRefs(content);
      const artifactValidation = validateArtifacts(reportTitle, artifactRefs);
      missingArtifacts = artifactValidation.missing;
      
      for (const missing of missingArtifacts) {
        violations.push({
          type: "ARTIFACT_MISSING",
          message: `Referenced artifact not found: ${missing}`,
          penalty: PENALTIES.ARTIFACT_MISSING,
          details: missing,
        });
        if (overallStatus === "COMPLETE") {
          overallStatus = "INCOMPLETE";
        }
      }
    } else {
      // File exists but couldn't be read (I/O error, permissions, etc.)
      violations.push({
        type: "REPORT_FILE_UNREADABLE",
        message: `Report file exists but could not be read: reports/${reportTitle}/README.md`,
        penalty: PENALTIES.REPORT_FILE_UNREADABLE,
      });
      if (overallStatus !== "MISSING") {
        overallStatus = "MISSING";
      }
    }
  }

  // Count artifacts in directory
  artifactCount = countArtifactsInDir(reportTitle);

  // Calculate score
  const totalPenalty = violations.reduce((sum, v) => sum + v.penalty, 0);
  const score = Math.max(0, 100 - totalPenalty);

  // Determine passed status
  const passed = violations.length === 0;

  const result: ReportGateResult = {
    passed,
    overallStatus,
    violations,
    score,
    sectionValidation,
    findingCount,
    artifactCount,
  };

  if (reportPath) {
    result.reportPath = reportPath;
  }

  if (missingArtifacts.length > 0) {
    result.missingArtifacts = missingArtifacts;
  }

  return result;
}

/**
 * Quick check if report is ready for completion.
 *
 * Performs minimal checks for fast validation:
 * - Report directory exists
 * - Report file exists
 * - Has at least one finding
 *
 * Use evaluateReportGate() for full validation with scores.
 *
 * @param reportTitle - The report title (slug)
 * @returns true if report passes quick checks
 */
export function isReportReady(reportTitle: string): boolean {
  if (!isValidReportTitle(reportTitle)) {
    return false;
  }

  if (!reportDirExists(reportTitle)) {
    return false;
  }
  
  if (!reportFileExists(reportTitle)) {
    return false;
  }
  
  const content = readReportContent(reportTitle);
  if (!content) {
    return false;
  }
  
  const findingCount = countFindings(content);
  return findingCount > 0;
}
