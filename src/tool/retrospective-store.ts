/**
 * Retrospective Store Tool - Manages feedback storage and retrieval for cross-session learning.
 * 
 * Storage: {project}/.gyoshu/retrospectives/feedback.jsonl
 * Actions: append, list, query, top, stats
 * 
 * @module retrospective-store
 */

import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  getRetrospectivesDir,
  getRetrospectivesFeedbackPath,
  ensureDirSync,
} from "../lib/paths";
import { openNoFollowSync, readFileNoFollowSync } from "../lib/atomic-write";

interface RetrospectiveFeedback {
  id: string;
  timestamp: string;
  task_context: string;
  observation: string;
  learning: string;
  recommendation: string;
  impact_score: number;
  tags: string[];
  source_session_id?: string;
  run_id?: string;
  dedupe_key: string;
}

interface StoreIndex {
  lastUpdated: string;
  count: number;
  tagHistogram: Record<string, number>;
}

function getRetroDir(): string {
  return getRetrospectivesDir();
}

function getFeedbackFile(): string {
  return getRetrospectivesFeedbackPath();
}

function getIndexPath(): string {
  return path.join(getRetroDir(), "index.json");
}

function ensureRetroDir(): void {
  ensureDirSync(getRetroDir());
}

function generateDedupeKey(taskContext: string, learning: string): string {
  const content = `${taskContext}:${learning}`;
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function generateId(): string {
  return `fb_${crypto.randomUUID().slice(0, 8)}`;
}

function loadAllFeedback(): RetrospectiveFeedback[] {
  const filePath = getFeedbackFile();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  try {
    const lines = readFileNoFollowSync(filePath).split("\n").filter(l => l.trim());
    const feedback: RetrospectiveFeedback[] = [];
    
    for (const line of lines) {
      try {
        feedback.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
    
    return feedback;
  } catch {
    return [];
  }
}

function appendFeedback(feedback: RetrospectiveFeedback): void {
  ensureRetroDir();
  const filePath = getFeedbackFile();
  
  // Security: Validate parent directory is not a symlink (prevents escape attacks)
  const parentDir = path.dirname(filePath);
  const parentStat = fs.lstatSync(parentDir);
  if (parentStat.isSymbolicLink()) {
    throw new Error(`Security: parent directory ${parentDir} is a symlink`);
  }
  
  // Security: Use O_NOFOLLOW to atomically reject symlinks (no TOCTOU race)
  // Two-step approach: try open existing, then create with O_EXCL if missing
  let fd: number;
  try {
    // Try opening existing file - O_NOFOLLOW will cause ELOOP if symlink
    fd = openNoFollowSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist - create with O_EXCL (fails if anything exists, including symlinks)
      fd = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600
      );
    } else {
      throw err;
    }
  }
  
  try {
    // Defense-in-depth: verify we opened a regular file
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile()) {
      throw new Error(`Security: opened target is not a regular file`);
    }
    fs.writeSync(fd, JSON.stringify(feedback) + "\n");
  } finally {
    fs.closeSync(fd);
  }
  updateIndex(feedback);
}

function loadIndex(): StoreIndex {
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) {
    return {
      lastUpdated: new Date().toISOString(),
      count: 0,
      tagHistogram: {},
    };
  }
  
  try {
    return JSON.parse(readFileNoFollowSync(indexPath));
  } catch {
    return {
      lastUpdated: new Date().toISOString(),
      count: 0,
      tagHistogram: {},
    };
  }
}

function saveIndex(index: StoreIndex): void {
  ensureRetroDir();
  const indexPath = getIndexPath();
  const tempPath = `${indexPath}.tmp.${process.pid}`;
  
  try {
    // Use 'wx' for exclusive creation (won't follow symlinks)
    fs.writeFileSync(tempPath, JSON.stringify(index, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, indexPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Temp file may already be renamed
    }
  }
}

function updateIndex(feedback: RetrospectiveFeedback): void {
  const index = loadIndex();
  index.lastUpdated = new Date().toISOString();
  index.count += 1;
  
  for (const tag of feedback.tags) {
    index.tagHistogram[tag] = (index.tagHistogram[tag] || 0) + 1;
  }
  
  saveIndex(index);
}

function calculateRecencyWeight(timestamp: string): number {
  const now = Date.now();
  const feedbackTime = new Date(timestamp).getTime();
  const daysSince = (now - feedbackTime) / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - daysSince / 30);
}

function calculateScore(feedback: RetrospectiveFeedback): number {
  const recency = calculateRecencyWeight(feedback.timestamp);
  return feedback.impact_score * 0.7 + recency * 0.3;
}

function matchesQuery(feedback: RetrospectiveFeedback, query: string): boolean {
  const lowerQuery = query.toLowerCase();
  return (
    feedback.task_context.toLowerCase().includes(lowerQuery) ||
    feedback.observation.toLowerCase().includes(lowerQuery) ||
    feedback.learning.toLowerCase().includes(lowerQuery) ||
    feedback.recommendation.toLowerCase().includes(lowerQuery) ||
    feedback.tags.some(t => t.toLowerCase().includes(lowerQuery))
  );
}

export default tool({
  description:
    "Manage retrospective feedback for cross-session learning. " +
    "Actions: append (add feedback), list (get recent), query (search), top (ranked), stats (counts).",

  args: {
    action: tool.schema
      .enum(["append", "list", "query", "top", "stats"])
      .describe(
        "append: Add new feedback, " +
        "list: Get recent feedback, " +
        "query: Search feedback by text, " +
        "top: Get top-ranked feedback, " +
        "stats: Get storage statistics"
      ),
    feedback: tool.schema
      .any()
      .optional()
      .describe(
        "Feedback record for append action. Object with: " +
        "task_context (required), observation (required), learning (required), " +
        "recommendation (required), impact_score (0-1), tags (array), " +
        "source_session_id, run_id"
      ),
    query: tool.schema
      .string()
      .optional()
      .describe("Search text for query action"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum results to return (default: 10)"),
    tags: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Filter by tags"),
    since: tool.schema
      .string()
      .optional()
      .describe("ISO timestamp to filter from"),
  },

  async execute(args) {
    const { action, limit = 10 } = args;

    try {
      switch (action) {
        case "append": {
          if (!args.feedback) {
            return JSON.stringify({
              success: false,
              error: "feedback object required for append action",
            });
          }

          const feedback: RetrospectiveFeedback = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            task_context: args.feedback.task_context,
            observation: args.feedback.observation,
            learning: args.feedback.learning,
            recommendation: args.feedback.recommendation,
            impact_score: Math.max(0, Math.min(1, args.feedback.impact_score ?? 0.5)),
            tags: args.feedback.tags ?? [],
            source_session_id: args.feedback.source_session_id,
            run_id: args.feedback.run_id,
            dedupe_key: generateDedupeKey(
              args.feedback.task_context,
              args.feedback.learning
            ),
          };

          appendFeedback(feedback);

          return JSON.stringify({
            success: true,
            feedback_id: feedback.id,
            dedupe_key: feedback.dedupe_key,
          });
        }

        case "list": {
          let allFeedback = loadAllFeedback();

          if (args.since) {
            const sinceTime = new Date(args.since).getTime();
            allFeedback = allFeedback.filter(
              f => new Date(f.timestamp).getTime() >= sinceTime
            );
          }

          if (args.tags?.length) {
            allFeedback = allFeedback.filter(f =>
              args.tags!.some(t => f.tags.includes(t))
            );
          }

          allFeedback.sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );

          return JSON.stringify({
            success: true,
            count: Math.min(limit, allFeedback.length),
            total: allFeedback.length,
            feedback: allFeedback.slice(0, limit),
          });
        }

        case "query": {
          if (!args.query) {
            return JSON.stringify({
              success: false,
              error: "query string required for query action",
            });
          }

          let allFeedback = loadAllFeedback();
          const matches = allFeedback.filter(f => matchesQuery(f, args.query!));
          matches.sort((a, b) => calculateScore(b) - calculateScore(a));

          return JSON.stringify({
            success: true,
            query: args.query,
            count: Math.min(limit, matches.length),
            total_matches: matches.length,
            feedback: matches.slice(0, limit),
          });
        }

        case "top": {
          let allFeedback = loadAllFeedback();

          if (args.tags?.length) {
            allFeedback = allFeedback.filter(f =>
              args.tags!.some(t => f.tags.includes(t))
            );
          }

          const scored = allFeedback.map(f => ({
            feedback: f,
            score: calculateScore(f),
          }));

          scored.sort((a, b) => b.score - a.score);

          const seenKeys = new Set<string>();
          const dedupedTop: Array<{ feedback: RetrospectiveFeedback; score: number }> = [];

          for (const item of scored) {
            if (!seenKeys.has(item.feedback.dedupe_key)) {
              seenKeys.add(item.feedback.dedupe_key);
              dedupedTop.push(item);
              if (dedupedTop.length >= limit) break;
            }
          }

          return JSON.stringify({
            success: true,
            count: dedupedTop.length,
            feedback: dedupedTop.map(item => ({
              ...item.feedback,
              _score: Math.round(item.score * 100) / 100,
            })),
          });
        }

        case "stats": {
          const index = loadIndex();
          const topTags = Object.entries(index.tagHistogram)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

          return JSON.stringify({
            success: true,
            last_updated: index.lastUpdated,
            total_feedback: index.count,
            top_tags: Object.fromEntries(topTags),
          });
        }

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown action: ${action}`,
          });
      }
    } catch (e) {
      return JSON.stringify({
        success: false,
        error: (e as Error).message,
      });
    }
  },
});
