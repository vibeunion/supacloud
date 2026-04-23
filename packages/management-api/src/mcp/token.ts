export interface McpTokenPayload {
  role: "admin" | "project";
  ref?: string;
}

export async function verifyMcpToken(_token: string): Promise<McpTokenPayload | null> {
  return null;
}
