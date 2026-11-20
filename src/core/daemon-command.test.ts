import { describe, expect, it } from "vitest";
import { phoneLinks } from "./daemon-command.js";
import type { DaemonState } from "../web/daemon.js";

function state(patch: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: 1, port: 8642, token: "tok en/+", workspace: "/w", host: "0.0.0.0",
    startedAt: 0, version: "9.9.9", ...patch,
  };
}

// The shape node:os returns; only IPv4 entries matter for a phone link.
const interfaces = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
  en0: [
    { address: "fe80::1", family: "IPv6", internal: false } as never,
    { address: "192.168.1.37", family: "IPv4", internal: false } as never,
  ],
  utun3: [{ address: "100.64.0.9", family: "IPv4", internal: false } as never],
};

describe("phone links", () => {
  it("offers loopback first and every LAN address, token encoded", () => {
    const links = phoneLinks(state(), interfaces);
    expect(links).toEqual([
      "http://127.0.0.1:8642/m/?token=tok%20en%2F%2B",
      "http://192.168.1.37:8642/m/?token=tok%20en%2F%2B",
      "http://100.64.0.9:8642/m/?token=tok%20en%2F%2B",
    ]);
  });

  it("never advertises an address the daemon does not listen on", () => {
    // A loopback-only daemon cannot be dialled from the phone; printing a LAN
    // URL would send it chasing a connection that always refuses.
    expect(phoneLinks(state({ host: "127.0.0.1" }), interfaces)).toEqual(["http://127.0.0.1:8642/m/?token=tok%20en%2F%2B"]);
    // A pinned interface answers on that interface only.
    expect(phoneLinks(state({ host: "192.168.1.37" }), interfaces)).toEqual([
      "http://127.0.0.1:8642/m/?token=tok%20en%2F%2B",
      "http://192.168.1.37:8642/m/?token=tok%20en%2F%2B",
    ]);
  });
});
