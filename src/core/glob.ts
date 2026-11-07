import type fgType from "fast-glob";

type GlobOptions = NonNullable<Parameters<typeof fgType>[1]>;

/**
 * fast-glob brings a directory walker, a matcher and a brace expander — about
 * a hundred module files that a cold start does not need until something
 * actually looks for files. Each Windows open pays for the antivirus filter, so
 * the import is deferred instead of being paid on every `luban` launch.
 */
export async function globFiles(pattern: string | string[], options: GlobOptions = {}): Promise<string[]> {
  const { default: fg } = await import("fast-glob");
  return fg(pattern, options);
}
