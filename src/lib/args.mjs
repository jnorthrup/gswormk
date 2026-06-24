export function parseArgs(argv) {
  const result = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split('=');
    const next = argv[index + 1];
    const hasValue = inlineValue !== undefined || (next && !next.startsWith('--'));
    const value = inlineValue ?? (hasValue ? next : true);
    result[rawKey] = value;

    if (inlineValue === undefined && hasValue && next && !next.startsWith('--')) {
      index += 1;
    }
  }

  return result;
}