export function packConsumerArtifacts(
  packageDir: string,
  packDir: string,
  run: (command: string[], cwd: string) => Promise<string>,
  npmCommand: (args: string[]) => string[],
): Promise<string[]>;
