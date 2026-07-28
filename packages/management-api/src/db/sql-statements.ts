import type { SQL } from "bun";

function startsEscapeString(sql: string, quoteIndex: number): boolean {
  const prefixIndex = quoteIndex - 1;
  const prefix = sql[prefixIndex] || "";
  const preceding = sql[prefixIndex - 1] || "";
  return /[eE]/.test(prefix) && !/[A-Za-z0-9_$]/.test(preceding);
}

function dollarQuoteTagAt(sql: string, index: number): string {
  const previous = sql[index - 1] || "";
  if (/[A-Za-z0-9_$]/.test(previous)) return "";
  return sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0] || "";
}

class PostgreSqlStatementScanner {
  private readonly statements: string[] = [];
  private statementBuffer = "";
  private containsSql = false;
  private index = 0;
  private inSingleQuote = false;
  private singleQuoteUsesBackslashEscapes = false;
  private inDoubleQuote = false;
  private inLineComment = false;
  private blockCommentDepth = 0;
  private dollarQuoteTag = "";

  constructor(private readonly sql: string) {}

  scan(): string[] {
    for (this.index = 0; this.index < this.sql.length; this.index += 1) {
      if (this.consumeActiveConstruct()) continue;
      this.consumeTopLevelCharacter();
    }

    this.assertComplete();
    this.pushStatement();
    return this.statements;
  }

  private get character(): string {
    return this.sql[this.index]!;
  }

  private get nextCharacter(): string {
    return this.sql[this.index + 1] || "";
  }

  private consumeActiveConstruct(): boolean {
    return this.consumeActiveComment() || this.consumeActiveQuotedConstruct();
  }

  private consumeActiveComment(): boolean {
    if (this.inLineComment) {
      this.consumeLineComment();
      return true;
    }
    if (this.blockCommentDepth > 0) {
      this.consumeBlockComment();
      return true;
    }
    return false;
  }

  private consumeActiveQuotedConstruct(): boolean {
    if (this.inSingleQuote) {
      this.consumeSingleQuotedString();
      return true;
    }
    if (this.inDoubleQuote) {
      this.consumeDoubleQuotedIdentifier();
      return true;
    }
    if (this.dollarQuoteTag) {
      this.consumeDollarQuotedBody();
      return true;
    }
    return false;
  }

  private consumeLineComment(): void {
    this.statementBuffer += this.character;
    if (this.character === "\n") this.inLineComment = false;
  }

  private consumeBlockComment(): void {
    this.statementBuffer += this.character;
    if (this.matchesPair("/", "*")) {
      this.appendNextCharacter();
      this.blockCommentDepth += 1;
    } else if (this.matchesPair("*", "/")) {
      this.appendNextCharacter();
      this.blockCommentDepth -= 1;
    }
  }

  private consumeSingleQuotedString(): void {
    this.statementBuffer += this.character;
    if (this.singleQuoteUsesBackslashEscapes && this.character === "\\" && this.nextCharacter) {
      this.appendNextCharacter();
    } else if (this.matchesPair("'", "'")) {
      this.appendNextCharacter();
    } else if (this.character === "'") {
      this.inSingleQuote = false;
      this.singleQuoteUsesBackslashEscapes = false;
    }
  }

  private consumeDoubleQuotedIdentifier(): void {
    this.statementBuffer += this.character;
    if (this.matchesPair('"', '"')) {
      this.appendNextCharacter();
    } else if (this.character === '"') {
      this.inDoubleQuote = false;
    }
  }

  private consumeDollarQuotedBody(): void {
    if (this.sql.startsWith(this.dollarQuoteTag, this.index)) {
      this.statementBuffer += this.dollarQuoteTag;
      this.index += this.dollarQuoteTag.length - 1;
      this.dollarQuoteTag = "";
      return;
    }
    this.statementBuffer += this.character;
  }

  private consumeTopLevelCharacter(): void {
    if (this.beginComment() || this.beginQuotedConstruct()) return;
    if (this.character === ";") {
      this.pushStatement();
      return;
    }
    this.statementBuffer += this.character;
    if (!/\s/.test(this.character)) this.containsSql = true;
  }

  private beginComment(): boolean {
    if (this.matchesPair("-", "-")) {
      this.appendCharacterPair();
      this.inLineComment = true;
      return true;
    }
    if (this.matchesPair("/", "*")) {
      this.appendCharacterPair();
      this.blockCommentDepth = 1;
      return true;
    }
    return false;
  }

  private beginQuotedConstruct(): boolean {
    if (this.character === "'") {
      this.statementBuffer += this.character;
      this.containsSql = true;
      this.inSingleQuote = true;
      this.singleQuoteUsesBackslashEscapes = startsEscapeString(this.sql, this.index);
      return true;
    }
    if (this.character === '"') {
      this.statementBuffer += this.character;
      this.containsSql = true;
      this.inDoubleQuote = true;
      return true;
    }
    return this.beginDollarQuote();
  }

  private beginDollarQuote(): boolean {
    if (this.character !== "$") return false;
    const quoteTag = dollarQuoteTagAt(this.sql, this.index);
    if (!quoteTag) return false;
    this.statementBuffer += quoteTag;
    this.index += quoteTag.length - 1;
    this.dollarQuoteTag = quoteTag;
    this.containsSql = true;
    return true;
  }

  private matchesPair(first: string, second: string): boolean {
    return this.character === first && this.nextCharacter === second;
  }

  private appendCharacterPair(): void {
    this.statementBuffer += this.character + this.nextCharacter;
    this.index += 1;
  }

  private appendNextCharacter(): void {
    this.statementBuffer += this.nextCharacter;
    this.index += 1;
  }

  private assertComplete(): void {
    if (this.blockCommentDepth > 0 || this.inSingleQuote || this.inDoubleQuote || this.dollarQuoteTag) {
      throw new Error("Unterminated SQL comment, quoted literal, or dollar-quoted body");
    }
  }

  private pushStatement(): void {
    const statement = this.statementBuffer.trim();
    if (this.containsSql && statement) this.statements.push(statement);
    this.statementBuffer = "";
    this.containsSql = false;
  }
}

/**
 * Split PostgreSQL statements without treating semicolons inside SQL literals,
 * comments, or dollar-quoted PL/pgSQL bodies as statement boundaries.
 */
export function splitSqlStatements(sql: string): string[] {
  return new PostgreSqlStatementScanner(sql).scan();
}

function normalizedTransactionStatement(statement: string): string {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*(?:\n|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The executor owns the atomic transaction for a batch. Remove a matching
 * outer BEGIN/COMMIT pair so pasted migration files cannot commit early.
 */
export function stripOuterTransactionStatements(statements: readonly string[]): string[] {
  if (statements.length < 2) return [...statements];
  const first = normalizedTransactionStatement(statements[0]!);
  const last = normalizedTransactionStatement(statements[statements.length - 1]!);
  const hasOuterTransaction = /^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION)$/i.test(first)
    && /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i.test(last);
  return hasOuterTransaction ? statements.slice(1, -1) : [...statements];
}

/**
 * Execute a SQL batch on the caller-owned transaction so adjacent migrations
 * can share one atomic boundary without nesting `begin` calls.
 */
export async function executeSqlStatements(transaction: SQL, sql: string): Promise<void> {
  const statements = stripOuterTransactionStatements(splitSqlStatements(sql));
  if (statements.length === 0) throw new Error("SQL migration contains no executable statements");

  for (const statement of statements) await transaction.unsafe(statement);
}
