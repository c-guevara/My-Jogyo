/**
 * Path Security Module
 *
 * Provides security utilities for path containment verification.
 * Used to prevent path traversal attacks when performing file operations.
 *
 * @module path-security
 */

import * as fs from "fs";
import * as path from "path";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for path containment verification.
 */
export interface PathContainmentOptions {
  /**
   * Whether to resolve symlinks before comparison using fs.realpathSync.
   *
   * - `false` (default): Uses path.resolve only. Suitable for paths that may not exist yet.
   * - `true`: Uses fs.realpathSync to resolve symlinks. Recommended for existing paths
   *   to prevent symlink-based directory escape attacks.
   *
   * When `true`, if either path doesn't exist or realpathSync fails,
   * the function returns `false` for safety.
   *
   * @default false
   */
  useRealpath?: boolean;
}

// =============================================================================
// PATH CONTAINMENT VERIFICATION
// =============================================================================

/**
 * Verify that a path is contained within a parent directory.
 *
 * This function is used to prevent path traversal attacks when performing
 * operations like unlinking sockets, deleting files, or accessing artifacts.
 *
 * Security considerations:
 * - Always normalizes both paths before comparison
 * - Checks for exact match (child === parent) and containment (child starts with parent + sep)
 * - Optional symlink resolution via `useRealpath` for defense against symlink-based escapes
 *
 * @param childPath - The path to verify (potential child)
 * @param parentDir - The directory that should contain the child
 * @param options - Optional configuration for the verification
 * @returns `true` if childPath is contained within parentDir, `false` otherwise
 *
 * @example
 * // Basic usage (no symlink resolution)
 * isPathContainedIn('/home/user/project/file.txt', '/home/user/project'); // true
 * isPathContainedIn('/etc/passwd', '/home/user/project'); // false
 *
 * @example
 * // With symlink resolution (recommended for existing paths)
 * isPathContainedIn('/tmp/symlink-to-etc/passwd', '/tmp/data', { useRealpath: true }); // false
 *
 * @example
 * // Same path returns true
 * isPathContainedIn('/home/user/project', '/home/user/project'); // true
 */
export function isPathContainedIn(
  childPath: string,
  parentDir: string,
  options?: PathContainmentOptions
): boolean {
  // Handle empty strings - return false for safety
  if (!childPath || !parentDir) {
    return false;
  }

  const useRealpath = options?.useRealpath ?? false;

  let normalizedChild: string;
  let normalizedParent: string;

  if (useRealpath) {
    // Resolve symlinks for existing paths
    try {
      normalizedChild = fs.realpathSync(childPath);
      normalizedParent = fs.realpathSync(parentDir);
    } catch {
      // If either path doesn't exist or realpath fails, return false for safety
      // This prevents potential TOCTOU attacks where a path could be replaced
      // with a symlink between check and use
      return false;
    }
  } else {
    // Use path.resolve only (suitable for paths that may not exist)
    normalizedChild = path.resolve(childPath);
    normalizedParent = path.resolve(parentDir);
  }

  // Check if child equals parent (same directory)
  if (normalizedChild === normalizedParent) {
    return true;
  }

  // Check if child is under parent (starts with parent + separator)
  return normalizedChild.startsWith(normalizedParent + path.sep);
}
