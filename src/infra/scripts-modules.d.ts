declare module "../../scripts/watch-node.mjs" {
  export function runWatchMain(params?: {
    spawn?: (
      cmd: string,
      args: string[],
      options: unknown,
    ) => { on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void };
    process?: NodeJS.Process;
    cwd?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    now?: () => number;
  }): Promise<number>;
}

declare module "../../scripts/ci-changed-scope.mjs" {
  export type ChangedScope = {
    runNode: boolean;
    runMacos: boolean;
    runAndroid: boolean;
    runWindows: boolean;
  };

  export function detectChangedScope(paths: string[]): ChangedScope;
  export function formatChangedScopeOutput(scope: ChangedScope): string;
  export function listChangedPaths(base: string, head?: string): string[];
  export function writeGitHubOutput(scope: ChangedScope, outputPath?: string): void;
}
