export function parsePostgresUrl(input: string): {
  hostname: string;
  port: number;
  database: string;
  username: string;
  password: string;
} {
  try {
    const url = new URL(input);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || "5432");
    if (!username || !database || !hostname || url.hash
      || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    for (const value of [username, password, database, hostname]) {
      if (value.includes("\0")) throw new Error();
    }
    // Keep structured metadata and driver connections pointed at the same database.
    for (const key of ["host", "hostname", "port", "user", "username", "password", "database", "dbname"]) {
      if (url.searchParams.has(key)) throw new Error();
    }
    return { hostname, port, database, username, password };
  } catch {
    throw new Error("Invalid PostgreSQL connection URL");
  }
}

export function withPostgresDatabase(
  input: string, database: string, username?: string, password?: string,
): string {
  const current = parsePostgresUrl(input);
  const url = new URL(input);
  url.pathname = `/${encodeURIComponent(database)}`;
  url.username = encodeURIComponent(username ?? current.username);
  url.password = encodeURIComponent(password ?? current.password);
  const result = url.toString();
  parsePostgresUrl(result);
  return result;
}
