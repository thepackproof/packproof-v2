export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let inDollar: string | null = null;
  let inSingle = false;

  while (i < sql.length) {
    const char = sql[i];

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
      if (char === "'" && sql[i + 1] === "'") {
        current += sql[i + 1];
        i += 2;
        continue;
      }
      if (char === "'") {
        inSingle = false;
      }
      i += 1;
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
