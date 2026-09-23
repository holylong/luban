const META_PATTERNS = [
  /\bthe user (?:is asking|asks|wants|requested|is requesting)\b/iu,
  /\baccording to (?:the )?(?:system|developer|instructions?|reminder)\b/iu,
  /\bfollowing (?:the )?(?:guidelines?|instructions?)\b/iu,
  /\b(?:i|we) (?:need to|should|must)\b/iu,
  /^\s*(?:need to|let(?:'s| us))\b/imu,
  /(?:用户|提问者).{0,20}(?:询问|要求|希望|想要)/u,
  /根据.{0,16}(?:系统|开发者|指令|要求|提醒)/u,
  /(?:我|我们)(?:需要|应该|必须|接下来)/u,
];

function metaScore(value: string): number {
  return META_PATTERNS.reduce((score, pattern) => score + (pattern.test(value) ? 1 : 0), 0);
}

/**
 * Return only user-facing content from models that leak reasoning into content.
 * Structured tags are exact; the plain-text fallback requires multiple strong
 * meta-reasoning signals before removing anything.
 */
export function extractFinalAnswer(value: string): string {
  let text = value.trim();
  if (!text) return "";

  const finalMatches = [...text.matchAll(/<final>\s*([\s\S]*?)\s*<\/final>/giu)];
  if (finalMatches.length) return finalMatches.at(-1)![1]!.trim();

  text = text.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
  if (text.includes("</think>")) text = text.slice(text.lastIndexOf("</think>") + 8).trim();
  text = text.replace(/<\/?final>/giu, "").trim();
  if (!text) return "";

  const blocks = text.split(/\n\s*\n+/u).map((block) => block.trim()).filter(Boolean);
  if (blocks.length < 2) return text;

  let totalScore = 0;
  let lastMetaBlock = -1;
  for (let index = 0; index < blocks.length - 1; index += 1) {
    const score = metaScore(blocks[index]!);
    totalScore += score;
    if (score > 0) lastMetaBlock = index;
  }
  if (totalScore >= 2 && lastMetaBlock >= 0 && lastMetaBlock < blocks.length - 1) {
    return blocks.slice(lastMetaBlock + 1).join("\n\n").trim();
  }
  return text;
}

const BRAND_NAMES = "千问|通义|Qwen|Claude|ChatGPT|GPT|Gemini|DeepSeek|Llama|LLaMA|文心|豆包|Kimi|Grok";

const IDENTITY_QUESTIONS = [
  /你(?:叫什么|叫啥|是谁|是哪一个|是哪个|是哪位|的名字|名字是)/u,
  /你(?:是个|是一个|是什么|是)(?:助手|Agent|agent|工具|程序|机器人|AI|智能体)/u,
  /what(?:'s| is|s)?\s+your\s+name/iu,
  /who\s+are\s+you/iu,
  /what\s+are\s+you\s+(?:called|named)/iu,
];

function isModelQuestion(question: string): boolean {
  return (/model|llm/iu.test(question) && /you|power|underlying|which|what/iu.test(question))
    || (/模型/u.test(question) && /你|底层|用的|使用|基于|背后/u.test(question));
}

function claimsModelIdentity(sentence: string): boolean {
  if (new RegExp(`我(?:叫|是)\\s*(?:${BRAND_NAMES})`, "iu").test(sentence)) return true;
  if (new RegExp(`(?:I(?:'m| am)|my name is)\\s+(?:a |an |the )?(?:${BRAND_NAMES})\\b`, "iu").test(sentence)) return true;
  if (new RegExp(`(?:${BRAND_NAMES})[\\s\\S]{0,24}模型`, "u").test(sentence) && /我/.test(sentence)) return true;
  if (/(?:阿里巴巴|Alibaba)/iu.test(sentence) && /我/.test(sentence) && /模型|language model/iu.test(sentence)) return true;
  if (/I(?:'m| am)\s+(?:a |an )?(?:large |frontier )?language model/iu.test(sentence)) return true;
  return false;
}

const BRAND_ORIGINS = /(?:阿里巴巴|Alibaba|OpenAI|Anthropic|Google|Meta|DeepMind|小米|字节)/iu;

const IDENTITY_ZH = "我是 luban，一个直接在你的工作区里工作的编码 Agent。";
const IDENTITY_EN = "I am luban, a coding agent that works directly in your workspace.";

/**
 * Models tend to answer identity questions with the underlying brand (Qwen,
 * Claude, …). For explicit identity questions, replace the claim with the
 * product identity. Model questions and ordinary answers pass through.
 */
export function enforceAgentIdentity(question: string, answer: string): string {
  const q = String(question ?? "").trim();
  const text = String(answer ?? "");
  if (!q || !text.trim()) return text;
  if (!IDENTITY_QUESTIONS.some((pattern) => pattern.test(q))) return text;
  if (isModelQuestion(q)) return text;
  const canonical = /\p{Script=Han}/u.test(q) ? IDENTITY_ZH : IDENTITY_EN;
  let replaced = false;
  const next = text
    .split(/(?<=[。！？!?.\n])/u)
    .map((sentence) => {
      if (claimsModelIdentity(sentence)) {
        replaced = true;
        return canonical;
      }
      if (replaced && BRAND_ORIGINS.test(sentence) && /我|\bI\b/iu.test(sentence)) return "";
      return sentence;
    })
    .join("")
    .trim();
  return replaced ? next : text;
}
