import { describe, expect, it } from "vitest";
import { enforceAgentIdentity, extractFinalAnswer } from "./reasoning.js";

describe("extractFinalAnswer", () => {
  it("removes tagged thinking", () => {
    expect(extractFinalAnswer("<think>private plan</think>\n<final>Visible answer.</final>"))
      .toBe("Visible answer.");
  });

  it("removes untagged Qwen meta-reasoning without discarding the answer", () => {
    const response = `The user is asking \"你叫什么名字?\" in Chinese.

According to the system reminder, I am Qwen. The user is directly asking about my identity, so I should answer.

Following the guidelines, I should respond in the same language as the user.

我叫千问（Qwen），是阿里巴巴集团自主研发的大语言模型。有什么我可以帮你的吗？`;
    expect(extractFinalAnswer(response))
      .toBe("我叫千问（Qwen），是阿里巴巴集团自主研发的大语言模型。有什么我可以帮你的吗？");
  });

  it("preserves ordinary multi-paragraph answers", () => {
    const answer = "第一段是结论。\n\n第二段是补充说明。";
    expect(extractFinalAnswer(answer)).toBe(answer);
  });
});

describe("enforceAgentIdentity", () => {
  it("replaces a leaked model brand on identity questions", () => {
    expect(enforceAgentIdentity(
      "你叫什么名字？",
      "我叫千问（Qwen），是阿里巴巴集团自主研发的大语言模型。有什么我可以帮你的吗？",
    )).toBe("我是 luban，一个直接在你的工作区里工作的编码 Agent。有什么我可以帮你的吗？");
  });

  it("answers English identity questions with the product identity", () => {
    expect(enforceAgentIdentity(
      "Who are you?",
      "I am Qwen, a large language model developed by Alibaba. How can I help you?",
    )).toBe("I am luban, a coding agent that works directly in your workspace. How can I help you?");
  });

  it("keeps honest model answers when the user asks about the model", () => {
    expect(enforceAgentIdentity("你用的什么模型？", "我当前配置的是 Qwen3 Coder。"))
      .toBe("我当前配置的是 Qwen3 Coder。");
  });

  it("leaves ordinary answers that mention a model untouched", () => {
    expect(enforceAgentIdentity("帮我写一个 Qwen 的调用示例", "Qwen 的 API 使用 OpenAI 兼容接口。"))
      .toBe("Qwen 的 API 使用 OpenAI 兼容接口。");
  });
});
