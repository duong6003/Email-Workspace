declare module 'papaparse' {
  export type ParseResult<T> = { data: T[]; errors: Array<{ message: string; row?: number }> };
  export function parse<T>(input: string, config: { header: boolean; skipEmptyLines: boolean }): ParseResult<T>;
}
