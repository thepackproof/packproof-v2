export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let inDollar: string | null = null;
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += char;
      i += 1;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }

    if (inDollar) {
      if (sql.startsWith(inDollar, i)) {
        current += inDollar;
        i += inDollar.length;
        inDollar = null;
        continue;
      }
      current += char;
      i += 1;
      continue;
    }

    if (inSingle) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        i += 2;
        continue;
      }
      if (char === "'") {
        inSingle = false;
      }
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      current += "--";
      i += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      current += "/*";
      i += 2;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      current += char;
      i += 1;
      continue;
    }

    if (char === "$") {
      const match = sql.slice(i).match(/^(\$[a-zA-Z0-9_]*\$)/);
      if (match) {
        inDollar = match[1];
        current += match[1];
        i += match[1].length;
        continue;
      }
    }

    if (char === ";") {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = "";
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }
  return statements;
}
