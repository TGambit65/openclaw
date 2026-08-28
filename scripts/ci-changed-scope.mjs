import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @typedef {{ runNode: boolean; runMacos: boolean; runAndroid: boolean; runWindows: boolean }} ChangedScope */

const DOCS_PATH_RE = /^(docs\/|.*\.mdx?$)/;
const MACOS_PROTOCOL_GEN_RE =
  /^(apps\/macos\/Sources\/OpenClawProtocol\/|apps\/shared\/OpenClawKit\/Sources\/OpenClawProtocol\/)/;
const MACOS_NATIVE_RE = /^(apps\/macos\/|apps\/ios\/|apps\/shared\/|Swabble\/)/;
const ANDROID_SHELL_TOOLS_TEST_RE = /^scripts\/test-android-shell-tools\.sh$/;
const ANDROID_NATIVE_RE =
  /^(apps\/android\/|apps\/shared\/|scripts\/test-android-shell-tools\.sh$)/;
const NODE_SCOPE_RE =
  /^(src\/|test\/|extensions\/|packages\/|scripts\/|ui\/|\.github\/|openclaw\.mjs$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig.*\.json$|vitest.*\.ts$|tsdown\.config\.ts$|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$)/;
const WINDOWS_SCOPE_RE =
  /^(src\/|test\/|extensions\/|packages\/|scripts\/|ui\/|openclaw\.mjs$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig.*\.json$|vitest.*\.ts$|tsdown\.config\.ts$|\.github\/workflows\/ci\.yml$|\.github\/actions\/setup-node-env\/action\.yml$|\.github\/actions\/setup-pnpm-store-cache\/action\.yml$)/;
const NATIVE_ONLY_RE =
  /^(apps\/android\/|apps\/ios\/|apps\/macos\/|apps\/shared\/|Swabble\/|appcast\.xml$|scripts\/test-android-shell-tools\.sh$)/;

/**
 * @param {string[]} changedPaths
 * @returns {ChangedScope}
 */
export function detectChangedScope(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { runNode: true, runMacos: true, runAndroid: true, runWindows: true };
  }

  let runNode = false;
  let runMacos = false;
  let runAndroid = false;
  let runWindows = false;
  let hasNonDocs = false;
  let hasNonNativeNonDocs = false;

  for (const rawPath of changedPaths) {
    const path = String(rawPath).trim();
    if (!path) {
      continue;
    }

    if (DOCS_PATH_RE.test(path)) {
      continue;
    }

    hasNonDocs = true;

    if (!MACOS_PROTOCOL_GEN_RE.test(path) && MACOS_NATIVE_RE.test(path)) {
      runMacos = true;
    }

    if (ANDROID_NATIVE_RE.test(path)) {
      runAndroid = true;
    }

    if (NODE_SCOPE_RE.test(path) && !ANDROID_SHELL_TOOLS_TEST_RE.test(path)) {
      runNode = true;
    }

    if (WINDOWS_SCOPE_RE.test(path) && !ANDROID_SHELL_TOOLS_TEST_RE.test(path)) {
      runWindows = true;
    }

    if (!NATIVE_ONLY_RE.test(path)) {
      hasNonNativeNonDocs = true;
    }
  }

  if (!runNode && hasNonDocs && hasNonNativeNonDocs) {
    runNode = true;
  }

  return { runNode, runMacos, runAndroid, runWindows };
}

/**
 * @param {string} base
 * @param {string} [head]
 * @returns {string[]}
 */
export function listChangedPaths(base, head = "HEAD") {
  if (!base) {
    return [];
  }
  if (base.startsWith("-") || head.startsWith("-")) {
    throw new Error("Git revisions must not be option-like arguments");
  }
  const output = execFileSync("git", ["diff", "--name-only", base, head], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * @param {ChangedScope} scope
 * @returns {string}
 */
export function formatChangedScopeOutput(scope) {
  return [
    `run_node=${scope.runNode}`,
    `run_macos=${scope.runMacos}`,
    `run_android=${scope.runAndroid}`,
    `run_windows=${scope.runWindows}`,
    "",
  ].join("\n");
}

/**
 * @param {ChangedScope} scope
 * @param {string} [outputPath]
 */
export function writeGitHubOutput(scope, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  appendFileSync(outputPath, formatChangedScopeOutput(scope), "utf8");
}

/**
 * @param {ChangedScope} scope
 */
function emitChangedScope(scope) {
  if (process.env.GITHUB_OUTPUT) {
    writeGitHubOutput(scope);
    return;
  }
  process.stdout.write(formatChangedScopeOutput(scope));
}

function isDirectRun() {
  const direct = process.argv[1];
  return Boolean(direct && pathToFileURL(direct).href === import.meta.url);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { base: "", head: "HEAD" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") {
      args.base = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (argv[i] === "--head") {
      args.head = argv[i + 1] ?? "HEAD";
      i += 1;
    }
  }
  return args;
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const changedPaths = listChangedPaths(args.base, args.head);
    if (changedPaths.length === 0) {
      emitChangedScope({ runNode: true, runMacos: true, runAndroid: true, runWindows: true });
      process.exit(0);
    }
    emitChangedScope(detectChangedScope(changedPaths));
  } catch {
    emitChangedScope({ runNode: true, runMacos: true, runAndroid: true, runWindows: true });
  }
}
