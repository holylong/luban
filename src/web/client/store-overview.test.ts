import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => unknown>, values: [] as unknown[], setters: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = hooks.values.length;
    hooks.values.push(initial);
    const setter = vi.fn((value: unknown) => { hooks.values[index] = value; });
    hooks.setters.push(setter);
    return [initial, setter];
  },
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));
vi.mock("./api", () => ({ api: { node: vi.fn(), peers: vi.fn(), jobs: vi.fn(), inbox: vi.fn() }, ApiError: class extends Error {} }));
import { api } from "./api";
import { useWorkbench } from "./store";

beforeEach(() => {
  hooks.effects.length = 0;
  hooks.values.length = 0;
  hooks.setters.length = 0;
  vi.clearAllMocks();
  vi.mocked(api.peers).mockRejectedValue(new Error("peers unavailable"));
  vi.mocked(api.jobs).mockResolvedValue([]);
  vi.mocked(api.inbox).mockResolvedValue([]);
});

it("publishes node/model availability even while another overview request hangs or fails", async () => {
  const node = { models: [{ id: "test/model" }], projects: {} } as Awaited<ReturnType<typeof api.node>>;
  vi.mocked(api.node).mockResolvedValue(node);
  vi.mocked(api.inbox).mockReturnValue(new Promise(() => undefined));
  useWorkbench();
  hooks.effects[0]!(); // initial overview load; do not install timers/streams
  await vi.waitFor(() => expect(hooks.setters[0]).toHaveBeenCalledWith(node));
  expect(hooks.setters[1]).toHaveBeenCalledWith(true);
  expect(hooks.setters[1]).not.toHaveBeenCalledWith(false);
});

it("preserves the node request's error for the visible model control status", async () => {
  vi.mocked(api.node).mockRejectedValue(new Error("missing or invalid access token"));
  useWorkbench();
  hooks.effects[0]!();
  await vi.waitFor(() => expect(hooks.setters[2]).toHaveBeenCalledWith("missing or invalid access token"));
  expect(hooks.setters[1]).toHaveBeenCalledWith(false);
});
