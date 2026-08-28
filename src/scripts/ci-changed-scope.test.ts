import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { detectChangedScope, formatChangedScopeOutput, listChangedPaths } =
  (await import("../../scripts/ci-changed-scope.mjs")) as unknown as {
    detectChangedScope: (paths: string[]) => {
      runNode: boolean;
      runMacos: boolean;
      runAndroid: boolean;
      runWindows: boolean;
    };
    formatChangedScopeOutput: (scope: {
      runNode: boolean;
      runMacos: boolean;
      runAndroid: boolean;
      runWindows: boolean;
    }) => string;
    listChangedPaths: (base: string, head?: string) => string[];
  };

const markerPaths: string[] = [];
const tempDirs: string[] = [];

const androidOnlyOutput = formatChangedScopeOutput({
  runNode: false,
  runMacos: false,
  runAndroid: true,
  runWindows: false,
});
const failSafeOutput = formatChangedScopeOutput({
  runNode: true,
  runMacos: true,
  runAndroid: true,
  runWindows: true,
});

afterEach(() => {
  for (const markerPath of markerPaths) {
    try {
      fs.unlinkSync(markerPath);
    } catch {}
  }
  markerPaths.length = 0;
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("detectChangedScope", () => {
  it("fails safe when no paths are provided", () => {
    expect(detectChangedScope([])).toEqual({
      runNode: true,
      runMacos: true,
      runAndroid: true,
      runWindows: true,
    });
  });

  it("keeps all lanes off for docs-only changes", () => {
    expect(detectChangedScope(["docs/ci.md", "README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
    });
  });

  it("enables node lane for node-relevant files", () => {
    expect(detectChangedScope(["src/plugins/runtime/index.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
    });
  });

  it("keeps node lane off for native-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: false,
      runWindows: false,
    });
    expect(detectChangedScope(["apps/shared/OpenClawKit/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: true,
      runWindows: false,
    });
  });

  it("enables android lane for Android app tooling changes", () => {
    expect(detectChangedScope(["apps/android/scripts/perf-startup-benchmark.sh"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: true,
      runWindows: false,
    });
  });

  it("enables android lane for the Android shell-tool test harness", () => {
    expect(detectChangedScope(["scripts/test-android-shell-tools.sh"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: true,
      runWindows: false,
    });
  });

  it("keeps shell-tool CI eligible for package wrapper changes", () => {
    expect(detectChangedScope(["package.json"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
    });
  });

  it("does not force macOS for generated protocol model-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/OpenClawProtocol/GatewayModels.swift"])).toEqual(
      {
        runNode: false,
        runMacos: false,
        runAndroid: false,
        runWindows: false,
      },
    );
  });

  it("enables node lane for non-native non-doc files by fallback", () => {
    expect(detectChangedScope(["README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
    });

    expect(detectChangedScope(["assets/icon.png"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
    });
  });

  it("keeps windows lane off for non-runtime GitHub metadata files", () => {
    expect(detectChangedScope([".github/labeler.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
    });
  });

  it("treats base and head as literal git args", () => {
    const markerPath = path.join(
      os.tmpdir(),
      `openclaw-ci-changed-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    markerPaths.push(markerPath);

    const injectedBase =
      process.platform === "win32"
        ? `HEAD & echo injected > "${markerPath}" & rem`
        : `HEAD; touch "${markerPath}" #`;

    expect(() => listChangedPaths(injectedBase, "HEAD")).toThrow();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("rejects option-like refs before invoking git", () => {
    const markerPath = path.join(
      os.tmpdir(),
      `openclaw-ci-changed-scope-option-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    markerPaths.push(markerPath);

    expect(() => listChangedPaths(`--output=${markerPath}`, "HEAD")).toThrow(
      "Git revisions must not be option-like arguments",
    );
    expect(() => listChangedPaths("HEAD", `--output=${markerPath}`)).toThrow(
      "Git revisions must not be option-like arguments",
    );
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});

describe("formatChangedScopeOutput", () => {
  it("emits GitHub output-compatible key-value lines", () => {
    expect(
      formatChangedScopeOutput({
        runNode: false,
        runMacos: false,
        runAndroid: true,
        runWindows: false,
      }),
    ).toBe("run_node=false\nrun_macos=false\nrun_android=true\nrun_windows=false\n");
  });
});

describe("direct CLI", () => {
  it("emits scoped stdout output for a successful diff", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ci-changed-scope-repo-"));
    tempDirs.push(repoPath);

    execFileSync("git", ["init"], { cwd: repoPath, stdio: ["ignore", "ignore", "pipe"] });
    fs.writeFileSync(path.join(repoPath, "README.md"), "initial\n", "utf8");
    execFileSync("git", ["add", "README.md"], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=openclaw-test@example.invalid",
        "commit",
        "-m",
        "Initial commit",
      ],
      { cwd: repoPath, stdio: ["ignore", "ignore", "pipe"] },
    );
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    const androidScriptPath = path.join(repoPath, "apps/android/scripts/perf-startup-benchmark.sh");
    fs.mkdirSync(path.dirname(androidScriptPath), { recursive: true });
    fs.writeFileSync(androidScriptPath, "#!/usr/bin/env bash\n", "utf8");
    execFileSync("git", ["add", androidScriptPath], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=openclaw-test@example.invalid",
        "commit",
        "-m",
        "Add Android perf helper",
      ],
      { cwd: repoPath, stdio: ["ignore", "ignore", "pipe"] },
    );

    const output = execFileSync(
      process.execPath,
      [
        path.join(__dirname, "../../scripts/ci-changed-scope.mjs"),
        "--base",
        base,
        "--head",
        "HEAD",
      ],
      {
        cwd: repoPath,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toBe(androidOnlyOutput);
  });

  it("emits fail-safe stdout output when GITHUB_OUTPUT is unset", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/ci-changed-scope.mjs", "--base", "definitely-missing-ref"],
      {
        cwd: path.join(__dirname, "../.."),
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toBe(failSafeOutput);
  });

  it("writes fail-safe output to GITHUB_OUTPUT when provided", () => {
    const outputPath = path.join(
      os.tmpdir(),
      `openclaw-ci-changed-scope-output-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    markerPaths.push(outputPath);

    const output = execFileSync(
      process.execPath,
      ["scripts/ci-changed-scope.mjs", "--base", "definitely-missing-ref"],
      {
        cwd: path.join(__dirname, "../.."),
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toBe("");
    expect(fs.readFileSync(outputPath, "utf8")).toBe(failSafeOutput);
  });
});
