/**
 * Claude Code Installer Module
 *
 * Handles installation of Gyoshu agents, commands, skills
 * into the Claude Code config directory (~/.claude/).
 *
 * This module reads from the plugin's root-level directories:
 * - agents/ - Agent definitions
 * - commands/ - Slash commands
 * - skills/ - Skill patterns
 *
 * Note: This installer is for manual installation. Claude Code's native
 * `/plugin install` command reads directly from the plugin structure.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  unlinkSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

/** Claude Code configuration directory */
export const CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
export const AGENTS_DIR = join(CLAUDE_CONFIG_DIR, "agents");
export const COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, "commands");
export const SKILLS_DIR = join(CLAUDE_CONFIG_DIR, "skills");
export const VERSION_FILE = join(CLAUDE_CONFIG_DIR, ".gyoshu-version.json");

/** Current version - synced from package.json */
export const VERSION = "0.4.33";

/** Installation result */
export interface InstallResult {
  success: boolean;
  message: string;
  installedAgents: string[];
  installedCommands: string[];
  installedSkills: string[];
  errors: string[];
}

/** Installation options */
export interface InstallOptions {
  force?: boolean;
  verbose?: boolean;
  skipClaudeCheck?: boolean;
}

/**
 * Check if Claude Code is installed
 */
export function isClaudeInstalled(): boolean {
  try {
    execSync("which claude", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the plugin root directory (where agents/, commands/, skills/ are located)
 */
function getPluginRootDir(): string {
  // Try to find the plugin root directory
  const possiblePaths = [
    // Relative to this file (src/claude-code/installer.ts -> root)
    join(dirname(dirname(dirname(import.meta.url.replace("file://", "")))), ""),
    // Current working directory
    process.cwd(),
    // Two levels up from __dirname
    join(dirname(dirname(__dirname)), ""),
  ];

  for (const path of possiblePaths) {
    // Check if this is the plugin root by looking for agents/ directory
    if (existsSync(join(path, "agents"))) {
      return path;
    }
  }

  throw new Error("Could not find plugin root directory (looking for agents/ directory)");
}

/**
 * Copy skill directory to destination
 */
function copySkillDirectory(
  srcDir: string,
  destDir: string,
  skillName: string,
  verbose: boolean
): boolean {
  try {
    const skillSrcPath = join(srcDir, skillName);
    const skillDestPath = join(destDir, `gyoshu-${skillName}`);

    if (!existsSync(skillSrcPath)) {
      if (verbose) {
        console.log(`  Skill source not found: ${skillSrcPath}`);
      }
      return false;
    }

    // Create destination directory
    if (!existsSync(skillDestPath)) {
      mkdirSync(skillDestPath, { recursive: true });
    }

    // Copy all files from skill directory
    const files = readdirSync(skillSrcPath);
    for (const file of files) {
      const srcFile = join(skillSrcPath, file);
      const destFile = join(skillDestPath, file);

      if (statSync(srcFile).isFile()) {
        copyFileSync(srcFile, destFile);
        if (verbose) {
          console.log(`    Copied: ${file}`);
        }
      }
    }

    return true;
  } catch (error) {
    if (verbose) {
      console.error(`  Error copying skill ${skillName}:`, error);
    }
    return false;
  }
}

/**
 * Install Gyoshu to Claude Code
 */
export async function installToClaudeCode(
  options: InstallOptions = {}
): Promise<InstallResult> {
  const { force = false, verbose = false, skipClaudeCheck = false } = options;

  const result: InstallResult = {
    success: false,
    message: "",
    installedAgents: [],
    installedCommands: [],
    installedSkills: [],
    errors: [],
  };

  // Check if Claude Code is installed
  if (!skipClaudeCheck && !isClaudeInstalled()) {
    result.message =
      "Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code";
    result.errors.push(result.message);
    return result;
  }

  // Check existing installation
  if (!force && existsSync(VERSION_FILE)) {
    try {
      const versionData = JSON.parse(readFileSync(VERSION_FILE, "utf-8"));
      if (versionData.version === VERSION) {
        result.success = true;
        result.message = `Gyoshu v${VERSION} is already installed for Claude Code`;
        return result;
      }
      if (verbose) {
        console.log(`Upgrading from v${versionData.version} to v${VERSION}`);
      }
    } catch {
      // Continue with installation
    }
  }

  // Create directories
  for (const dir of [AGENTS_DIR, COMMANDS_DIR, SKILLS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Find plugin root directory
  let pluginRoot: string;
  try {
    pluginRoot = getPluginRootDir();
  } catch (error) {
    result.errors.push(`Failed to find plugin root: ${error}`);
    result.message = "Installation failed: plugin root directory not found";
    return result;
  }

  if (verbose) {
    console.log(`\n=== Installing Gyoshu to Claude Code ===`);
    console.log(`Plugin root: ${pluginRoot}\n`);
  }

  // Install agents
  const agentsDir = join(pluginRoot, "agents");
  if (existsSync(agentsDir)) {
    if (verbose) {
      console.log("Installing agents...");
    }
    const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith(".md"));
    for (const agentFile of agentFiles) {
      const srcPath = join(agentsDir, agentFile);
      const destPath = join(AGENTS_DIR, `gyoshu-${agentFile}`);

      try {
        const content = readFileSync(srcPath, "utf-8");
        writeFileSync(destPath, content);
        result.installedAgents.push(agentFile);
        if (verbose) {
          console.log(`  Installed: ${agentFile}`);
        }
      } catch (error) {
        result.errors.push(`Failed to install agent ${agentFile}: ${error}`);
      }
    }
  }

  // Install commands
  // Claude Code command structure: ~/.claude/commands/{command-name}/skill.md
  const commandsDir = join(pluginRoot, "commands");
  if (existsSync(commandsDir)) {
    if (verbose) {
      console.log("\nInstalling commands...");
    }
    const commandFiles = readdirSync(commandsDir).filter(f => f.endsWith(".md"));
    for (const cmdFile of commandFiles) {
      // Create command directory - use the filename without .md as the command name
      // e.g., gyoshu.md -> ~/.claude/commands/gyoshu/skill.md
      const cmdName = cmdFile.replace(".md", "");
      const cmdDir = join(COMMANDS_DIR, cmdName);

      if (!existsSync(cmdDir)) {
        mkdirSync(cmdDir, { recursive: true });
      }

      const srcPath = join(commandsDir, cmdFile);
      // The file MUST be named skill.md for Claude Code to recognize it
      const destPath = join(cmdDir, "skill.md");

      try {
        const content = readFileSync(srcPath, "utf-8");
        writeFileSync(destPath, content);
        result.installedCommands.push(cmdFile);
        if (verbose) {
          console.log(`  Installed: /${cmdName}`);
        }
      } catch (error) {
        result.errors.push(`Failed to install command ${cmdFile}: ${error}`);
      }
    }
  }

  // Install skills
  const skillsDir = join(pluginRoot, "skills");
  if (existsSync(skillsDir)) {
    if (verbose) {
      console.log("\nInstalling skills...");
    }
    const skillDirs = readdirSync(skillsDir).filter(f =>
      statSync(join(skillsDir, f)).isDirectory()
    );
    for (const skillName of skillDirs) {
      if (copySkillDirectory(skillsDir, SKILLS_DIR, skillName, verbose)) {
        result.installedSkills.push(skillName);
        if (verbose) {
          console.log(`  Installed: ${skillName}`);
        }
      }
    }
  }

  // Write version file
  const versionData = {
    version: VERSION,
    installedAt: new Date().toISOString(),
    platform: "claude-code",
  };
  writeFileSync(VERSION_FILE, JSON.stringify(versionData, null, 2));

  // Build summary
  result.success = result.errors.length === 0;
  result.message = result.success
    ? `Successfully installed Gyoshu v${VERSION} to Claude Code:\n` +
      `  - ${result.installedAgents.length} agents\n` +
      `  - ${result.installedCommands.length} commands\n` +
      `  - ${result.installedSkills.length} skills`
    : `Installation completed with ${result.errors.length} errors`;

  if (verbose) {
    console.log("\n" + result.message);
    if (result.errors.length > 0) {
      console.log("\nErrors:");
      result.errors.forEach((e) => console.log(`  - ${e}`));
    }
  }

  return result;
}

/**
 * Uninstall Gyoshu from Claude Code
 */
export async function uninstallFromClaudeCode(
  verbose = false
): Promise<{ success: boolean; message: string }> {
  const removedFiles: string[] = [];
  const errors: string[] = [];

  // Remove agents
  if (existsSync(AGENTS_DIR)) {
    const agents = readdirSync(AGENTS_DIR).filter((f) => f.startsWith("gyoshu-"));
    for (const agent of agents) {
      try {
        const path = join(AGENTS_DIR, agent);
        if (statSync(path).isFile()) {
          unlinkSync(path);
          removedFiles.push(`agent/${agent}`);
        }
      } catch (error) {
        errors.push(`Failed to remove ${agent}: ${error}`);
      }
    }
  }

  // Remove commands
  if (existsSync(COMMANDS_DIR)) {
    const commands = readdirSync(COMMANDS_DIR).filter((f) => f.startsWith("gyoshu-"));
    for (const cmd of commands) {
      try {
        const path = join(COMMANDS_DIR, cmd);
        if (statSync(path).isDirectory()) {
          rmSync(path, { recursive: true });
          removedFiles.push(`command/${cmd}`);
        }
      } catch (error) {
        errors.push(`Failed to remove ${cmd}: ${error}`);
      }
    }
  }

  // Remove skills
  if (existsSync(SKILLS_DIR)) {
    const skills = readdirSync(SKILLS_DIR).filter((f) => f.startsWith("gyoshu-"));
    for (const skill of skills) {
      try {
        const path = join(SKILLS_DIR, skill);
        if (statSync(path).isDirectory()) {
          rmSync(path, { recursive: true });
          removedFiles.push(`skill/${skill}`);
        }
      } catch (error) {
        errors.push(`Failed to remove ${skill}: ${error}`);
      }
    }
  }

  // Remove version file
  if (existsSync(VERSION_FILE)) {
    try {
      unlinkSync(VERSION_FILE);
      removedFiles.push(".gyoshu-version.json");
    } catch (error) {
      errors.push(`Failed to remove version file: ${error}`);
    }
  }

  const success = errors.length === 0;
  const message = success
    ? `Successfully uninstalled Gyoshu from Claude Code (${removedFiles.length} items removed)`
    : `Uninstall completed with ${errors.length} errors`;

  if (verbose) {
    console.log(message);
    if (errors.length > 0) {
      console.log("\nErrors:");
      errors.forEach((e) => console.log(`  - ${e}`));
    }
  }

  return { success, message };
}

/**
 * Get installation status
 */
export function getInstallationStatus(): { installed: boolean; version?: string; installedAt?: string } {
  if (!existsSync(VERSION_FILE)) {
    return { installed: false };
  }

  try {
    const data = JSON.parse(readFileSync(VERSION_FILE, "utf-8"));
    return {
      installed: true,
      version: data.version,
      installedAt: data.installedAt,
    };
  } catch {
    return { installed: false };
  }
}

/**
 * CLI entry point
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "install";
  const verbose = args.includes("--verbose") || args.includes("-v");
  const force = args.includes("--force") || args.includes("-f");
  const skipCheck = args.includes("--skip-claude-check");

  switch (command) {
    case "install":
      await installToClaudeCode({ verbose, force, skipClaudeCheck: skipCheck });
      break;
    case "uninstall":
      await uninstallFromClaudeCode(verbose);
      break;
    case "status": {
      const status = getInstallationStatus();
      if (status.installed) {
        console.log(`Gyoshu v${status.version} installed for Claude Code`);
        console.log(`Installed at: ${status.installedAt}`);
      } else {
        console.log("Gyoshu is not installed for Claude Code");
      }
      break;
    }
    default:
      console.log("Usage: gyoshu-claude-code [install|uninstall|status] [--verbose] [--force]");
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
