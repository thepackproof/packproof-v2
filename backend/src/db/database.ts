export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Database {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}
