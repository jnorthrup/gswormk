export type ParsedArgs = {
  _: string[];
} & Record<string, string | boolean | string[]>;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;

    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }

    const [rawKey = '', inlineValue] = token.slice(2).split('=');
    const next = argv[index + 1];
    const hasValue = inlineValue !== undefined || (next !== undefined && !next.startsWith('--'));
    const value = inlineValue ?? (hasValue && next !== undefined ? next : true);
    result[rawKey] = value;

    if (inlineValue === undefined && hasValue && next !== undefined && !next.startsWith('--')) {
      index += 1;
    }
  }

  return result;
}
