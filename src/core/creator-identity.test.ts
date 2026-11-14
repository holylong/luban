import { mkdtemp, readFile, writeFile, stat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { creatorIdentityFile, creatorSelfDescription, readCreatorIdentity, updateCreatorIdentity } from "./creator-identity.js";
import { createTools } from "./tools.js";
import { scheduledMessages } from "./bot-command.js";
import { enforceAgentIdentity } from "./reasoning.js";
import { loadConfig } from "./config.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "creator-identity-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
describe("global Creator identity", () => {
  it("has defaults without creating a file, persists patches and allows clearing preferences", async () => {
    expect(readCreatorIdentity(home).name).toBe("造物主");
    await expect(readFile(creatorIdentityFile(home))).rejects.toThrow();
    await updateCreatorIdentity(home, { name: "小鲁", personality: "温柔简洁", userName: "小林" });
    await updateCreatorIdentity(home, { name: "阿鲁" });
    expect(readCreatorIdentity(home)).toEqual({ name: "阿鲁", personality: "温柔简洁", userName: "小林" });
    await updateCreatorIdentity(home, { userName: "", personality: "" });
    expect(readCreatorIdentity(home).userName).toBe("");
    expect((await stat(creatorIdentityFile(home))).mode & 0o777).toBe(0o600);
  });
  it("rejects invalid fields and preserves the previous identity", async () => {
    await updateCreatorIdentity(home, { name: "小鲁" });
    for (const patch of [{ name: "" }, { name: "x".repeat(61) }, { userName: "a\nb" }, { permissions: "allow" }, { toString: "x" }, {}]) {
      await expect(updateCreatorIdentity(home, patch)).rejects.toThrow();
    }
    expect(readCreatorIdentity(home).name).toBe("小鲁");
  });
  it("does not overwrite a corrupt file or ignore an active lock", async () => {
    await writeFile(creatorIdentityFile(home), "broken");
    await expect(updateCreatorIdentity(home, { name: "小鲁" })).rejects.toThrow();
    expect(await readFile(creatorIdentityFile(home), "utf8")).toBe("broken");
    await mkdir(`${creatorIdentityFile(home)}.lock`);
    await expect(updateCreatorIdentity(home, { name: "小鲁" })).rejects.toThrow("正在更新");
  });
  it("exposes an explicit-confirmation tool only to Creator and feeds its saved identity to other workspaces", async () => {
    const config = loadConfig({ workspace: home, mesh: false, seedDefaults: false });
    config.home = home;
    expect(createTools(config).has("update_creator_identity")).toBe(false);
    const tool = createTools({ ...config, creatorIdentity: true }).get("update_creator_identity")!;
    expect(tool.approvalOnceOnly).toBe(true);
    const output = await tool.execute({ name: "小鲁", userName: "老板" }, new AbortController().signal);
    expect(output).toContain("已保存");
    const messages = scheduledMessages({ ...config, workspace: join(home, "another-project") }, "你是谁");
    expect(String(messages[0]!.content)).toContain('"name":"小鲁"');
    expect(String(messages[0]!.content)).toContain('"userName":"老板"');
    expect(String(messages[0]!.content)).not.toContain("say you are luban");
    expect(enforceAgentIdentity("你是谁", "我是 ChatGPT。", creatorSelfDescription(home))).toBe("我是小鲁，你的 Creator 助手。");
    await updateCreatorIdentity(home, { name: "阿鲁" });
    expect(creatorSelfDescription(home).zh).toContain("阿鲁");
  });
});
