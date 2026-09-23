/** Child-process entry for isolated code-intelligence queries.
 * argv[2] is JSON: { workspace, lspServers, args }. Prints one JSON line:
 * { ok: true, result } or { ok: false, error }. A hung service can be killed
 * by the parent without disturbing the agent process. */
async function main(): Promise<void> {
  const raw = process.argv[2] ?? "{}";
  try {
    const request = JSON.parse(raw) as {
      workspace: string;
      lspServers?: Record<string, { command: string; args: string[]; languages: string[]; enabled: boolean }>;
      args: Record<string, unknown>;
    };
    if (!request.workspace || !request.args) throw new Error("code-intel child needs { workspace, args }");
    const holdback = Number(process.env.LUBAN_CODE_CHILD_DELAY_MS || 0);
    if (Number.isFinite(holdback) && holdback > 0) await new Promise((resolve) => setTimeout(resolve, holdback));
    const { codeIntelligenceTool } = await import("./code-intelligence.js");
    const tool = codeIntelligenceTool(request.workspace, { workspace: request.workspace, lspServers: request.lspServers ?? {} } as never);
    try {
      const controller = new AbortController();
      const onSigterm = () => controller.abort(new Error("parent terminated the query"));
      process.once("SIGTERM", onSigterm);
      const result = await tool.execute(request.args, controller.signal);
      process.stdout.write(`${JSON.stringify({ ok: true as const, result })}\n`);
    } finally {
      tool.close?.();
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false as const, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

void main();
