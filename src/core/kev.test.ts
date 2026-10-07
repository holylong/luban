import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { buildKevRequest, createKevTool, describeAnswer, KevClient, parseKevQuestions } from "./kev.js";
import type { KevSettings } from "./types.js";

const settings = (url: string, apiKey = ""): KevSettings => ({ mode: "kev", url, apiKey, model: "kev-latest", timeoutSeconds: 30 });

describe("decision engine switch", () => {
  it("only adds the Kev prompt rule when the engine is kev", async () => {
    const { systemPrompt } = await import("./agent.js");
    expect(systemPrompt("auto", "kev")).toContain("kev_decide");
    expect(systemPrompt("auto", "model")).not.toContain("kev_decide");
    // The default engine keeps the historical prompt byte for byte.
    expect(systemPrompt("auto", "model")).toBe(systemPrompt("auto"));
  });
});

describe("Kev request building", () => {
  it("maps noul/choice/score onto the /v1/systemone shape", () => {
    const body = buildKevRequest("the ticket", {
      escalate: { type: "noul", instructions: "urgent?" },
      department: { type: "choice", options: { returns: "refunds", billing: null } },
      frustration: { type: "score", options: ["Calm", "Angry"] },
    }, "kev-latest");
    expect(body).toMatchObject({
      state: "the ticket",
      model: "kev-latest",
      questions: {
        escalate: { type: "noul", criteria: {}, instructions: "urgent?" },
        department: { type: "choice", criteria: { returns: "refunds", billing: null } },
        frustration: { type: "score", criteria: ["Calm", "Angry"] },
      },
    });
  });

  it("rejects empty state, empty questions and optionless choice questions", () => {
    expect(() => buildKevRequest("  ", { a: { type: "noul" } }, "kev-latest")).toThrow(/non-empty state/);
    expect(() => buildKevRequest("s", {}, "kev-latest")).toThrow(/at least one question/);
    expect(() => buildKevRequest("s", { a: { type: "choice", options: {} } }, "kev-latest")).toThrow(/at least one option/);
    expect(() => buildKevRequest("s", { a: { type: "score", options: [] } }, "kev-latest")).toThrow(/ordered `options`/);
  });

  it("parses tool arguments into questions", () => {
    const questions = parseKevQuestions({ a: { type: "noul" }, b: { type: "choice", options: { x: "one", y: null } }, c: { type: "score", options: ["lo", "hi"] } });
    expect(questions.a.type).toBe("noul");
    expect(questions.b.options).toEqual({ x: "one", y: null });
    expect(questions.c.options).toEqual(["lo", "hi"]);
    expect(() => parseKevQuestions({ a: { type: "nope" } })).toThrow(/noul, choice or score/);
  });
});

describe("KevClient against a fake /v1/systemone", () => {
  it("posts the body and normalizes the answer shapes", async () => {
    let seen: { url?: string; auth?: string; body: Record<string, unknown> } = { body: {} };
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          model: "kev-latest",
          answers: {
            go: { type: "noul", noul: 0.82 },
            where: { type: "choice", choice: "b", confidence: 0.31, probabilities: { a: 0.4, b: 0.6 } },
            how: { type: "score", score: 1.2, confidence: 0.5, legend: { "0": "lo", "1": "hi" }, probabilities: { "0": 0.3, "1": 0.7 } },
          },
          usage: { input_tokens: 10, output_tokens: 20 },
          latency_ms: 42,
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const client = new KevClient(settings(url, "secret"));
      const response = await client.decide("state text", { go: { type: "noul" }, where: { type: "choice", options: { a: null, b: null } }, how: { type: "score", options: ["lo", "hi"] } });
      expect(seen.url).toBe("/v1/systemone");
      expect(seen.auth).toBe("Bearer secret");
      expect((seen.body.questions as Record<string, unknown>).where).toMatchObject({ type: "choice", criteria: { a: null, b: null } });
      expect(response.answers.go.probability).toBeCloseTo(0.82);
      expect(response.answers.where.choice).toBe("b");
      expect(response.answers.how.legend).toEqual({ "0": "lo", "1": "hi" });
      expect(response.latency_ms).toBe(42);
      expect(describeAnswer("where", response.answers.where)).toContain("b");
    } finally {
      server.close();
    }
  });

  it("surfaces HTTP errors and refuses when unconfigured", async () => {
    const server = createServer((_req, res) => { res.writeHead(422, { "content-type": "application/json" }); res.end('{"detail":"too long"}'); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      await expect(new KevClient(settings(url)).decide("s", { a: { type: "noul" } })).rejects.toThrow(/kev HTTP 422/);
      await expect(new KevClient(settings("")).decide("s", { a: { type: "noul" } })).rejects.toThrow(/not configured/);
    } finally {
      server.close();
    }
  });

  it("exposes a kev_decide tool that renders answers", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "kev-latest", answers: { go: { type: "noul", noul: 0.9 } }, latency_ms: 7 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const tool = createKevTool(settings(url));
      expect(tool.name).toBe("kev_decide");
      expect(tool.risk).toBe("network");
      const text = await tool.execute({ state: "s", questions: { go: { type: "noul" } } }, new AbortController().signal);
      expect(text).toContain("go: yes 90.0%");
      expect(text).toContain('"model": "kev-latest"');
    } finally {
      server.close();
    }
  });
});
