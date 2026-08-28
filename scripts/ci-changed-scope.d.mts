export type ChangedScope = {
  runNode: boolean;
  runMacos: boolean;
  runAndroid: boolean;
  runWindows: boolean;
};

export function detectChangedScope(changedPaths: string[]): ChangedScope;
export function formatChangedScopeOutput(scope: ChangedScope): string;
export function listChangedPaths(base: string, head?: string): string[];
export function writeGitHubOutput(scope: ChangedScope, outputPath?: string): void;
