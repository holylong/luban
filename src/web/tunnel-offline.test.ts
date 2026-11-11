import { expect, it } from "vitest";
import { TunnelClient } from "./tunnel.js";

/**
 * The relay is an optional convenience: a phone on the internet reaching this
 * machine. When it is unreachable, nothing about the local workflow may change,
 * so `start()` must return at once and the retry loop must stay in the
 * background. Port 1 is guaranteed to refuse the connection.
 */
it("a dead relay never blocks the caller or throws", async () => {
  const states: string[] = [];
  const logs: string[] = [];
  const client = new TunnelClient({
    relayUrl: "http://127.0.0.1:1",
    nodeToken: "node-token",
    localPort: 1,
    name: "offline-test",
    version: "0.0.0",
    workspace: "/tmp",
    onState: (state) => states.push(state),
    log: (message) => logs.push(message),
  });

  const started = Date.now();
  await client.start();
  expect(Date.now() - started).toBeLessThan(500);

  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(states).toContain("offline");
  expect(logs.join("\n")).toMatch(/relay unavailable/);
  expect(client.nodeId).toBeUndefined();

  client.stop();
  expect(client.currentState).not.toBe("online");
});
