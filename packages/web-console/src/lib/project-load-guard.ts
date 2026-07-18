export type ProjectLoadToken = Readonly<{
  projectRef: string;
  revision: number;
}>;

export function createProjectLoadToken(projectRef: string, revision: number): ProjectLoadToken {
  return { projectRef, revision };
}

export function isCurrentProjectLoad(
  token: ProjectLoadToken,
  activeProjectRef: string,
  activeRevision: number,
): boolean {
  return token.projectRef === activeProjectRef && token.revision === activeRevision;
}
