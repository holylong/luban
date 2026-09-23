export function executionPreview(entries: Array<{ name: string; detail: string; editPreview?: string }>, budget: number): string[] {
  const result: string[] = [];
  for (let index = entries.length - 1; index >= 0 && result.length < budget; index--) {
    const entry = entries[index]!;
    const lines = (entry.editPreview || `${entry.name} ${entry.detail}`).split("\n");
    const remaining = budget - result.length;
    const selected = lines.length <= remaining ? lines : remaining > 1
      ? [...lines.slice(0, remaining - 1), "    … /details 查看其余改动"] : [lines[0]!];
    result.unshift(...selected);
  }
  return result;
}
