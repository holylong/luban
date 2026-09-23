import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "./tools.js";
import type { LubanConfig } from "./types.js";

describe("web_fetch tool", () => {
  it("fetches HTML and removes scripts and markup", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><style>.x{}</style><body><h1>Hello &amp; world</h1><script>bad()</script></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no test address");
      const workspace = await mkdtemp(join(tmpdir(), "luban-web-fetch-"));
      const tools = createTools({ workspace, home: workspace, project: "test" } as LubanConfig);
      const output = await tools.get("web_fetch")!.execute({ url: `http://127.0.0.1:${address.port}/page` }, new AbortController().signal);
      expect(output).toContain("Hello & world");
      expect(output).not.toContain("bad()");
      expect(output).not.toContain("<h1>");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
