import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../src/db/sql.js";

describe("SQL migration splitter", () => {
  it("does not split on semicolons inside line or block comments", () => {
    const statements = splitSqlStatements(`
      -- Protocol revisions are additive; finalized Proofs keep their meaning.
      ALTER TABLE proofs ADD COLUMN example_one INTEGER;
      /* Keep this comment; it also contains a semicolon. */
      ALTER TABLE proofs ADD COLUMN example_two INTEGER;
    `);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("ALTER TABLE proofs ADD COLUMN example_one INTEGER");
    expect(statements[1]).toContain("ALTER TABLE proofs ADD COLUMN example_two INTEGER");
  });

  it("still preserves semicolons inside strings and dollar-quoted functions", () => {
    const statements = splitSqlStatements(`
      INSERT INTO demo(value) VALUES ('one;two');
      CREATE FUNCTION demo_fn() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'still;inside';
      END;
      $$ LANGUAGE plpgsql;
    `);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'one;two'");
    expect(statements[1]).toContain("RAISE EXCEPTION 'still;inside'");
  });
});
