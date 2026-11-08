import { afterEach, expect, it, vi } from "vitest";
import { api, setNodeScope } from "./api";

afterEach(() => { setNodeScope(undefined); vi.unstubAllGlobals(); });

it("pins session requests to the selected computer and rejects late responses after a switch", async () => {
  let complete!: (value: Response) => void;
  const fetcher = vi.fn((_url: string) => new Promise<Response>(resolve => { complete = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  setNodeScope("win-testbox");
  const pending = api.sessions("timeagent-cpp");
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/sessions?project=timeagent-cpp&limit=60&node=win-testbox");
  setNodeScope("linux");
  const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
  complete(new Response("[]"));
  await rejected;
});

it("returns transcripts from the requested device and project", async () => {
  const detail = { id: "s", messages: [{ role: "user", content: "hello" }] };
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify(detail)));
  vi.stubGlobal("fetch", fetcher);
  setNodeScope("win-testbox");
  expect(await api.session("s", "timeagent-cpp")).toEqual(detail);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/sessions/s?project=timeagent-cpp&node=win-testbox");
});
