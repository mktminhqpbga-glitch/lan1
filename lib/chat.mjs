export const PROVIDERS = [
  "auto",
  "grok",
  "gemini",
  "deepseek",
  "perplexity",
  "qwen",
  "chatgpt",
  "claude",
  "zai",
  "kimi",
  "muse",
];
export function isConversationTitleRequest(messages) {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message?.role === "user");
  if (!lastUserMessage) return false;
  const text = contentToText(lastUserMessage.content)
    .toLowerCase()
    .replace(/\s+/g, " ");
  const asksForTitle = /\b(?:title|name|summari[sz]e|label)\b/.test(text);
  const namesConversation =
    /\b(?:conversation|chat|discussion|thread|messages)\b/.test(text);
  const requestVerb =
    /\b(?:generate|create|write|provide|return|suggest|give|make|name|summari[sz]e)\b/.test(
      text,
    );
  const titleOnly =
    /\b(?:title only|only the title|just the title|no explanation)\b/.test(
      text,
    );
  return asksForTitle && requestVerb && (namesConversation || titleOnly);
}

export function makeConversationTitle(messages) {
  const lastTitleRequest = [...messages]
    .reverse()
    .find((message) => message?.role === "user");
  const sourceMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message?.role === "user" &&
        message !== lastTitleRequest &&
        !isConversationTitleRequest([message]),
    );
  const source = contentToText(sourceMessage?.content ?? "");
  const words =
    source
      .replace(/```[\s\S]*?```/g, " ")
      .match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)
      ?.filter((word) => !TITLE_STOP_WORDS.has(word.toLowerCase()))
      .slice(0, 7) ?? [];
  if (words.length === 0) return "New conversation";
  const title = words.join(" ");
  return `${title[0].toUpperCase()}${title.slice(1)}`.slice(0, 72);
}

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "please",
  "the",
  "this",
  "that",
  "to",
  "we",
  "with",
  "you",
  "your",
]);

export function formatPrompt(messages, tools) {
  const transcript = messages
    .map((message) => {
      const role =
        typeof message.role === "string" ? message.role.toUpperCase() : "USER";
      return `${role}:\n${contentToText(message.content)}`;
    })
    .join("\n\n");
  if (!Array.isArray(tools) || tools.length === 0) return transcript;
  return `${transcript}\n\nAVAILABLE TOOLS (OpenAI schema):\n${JSON.stringify(tools)}\n\nIf a tool is required, reply only with a JSON object shaped like {"name":"tool_name","arguments":{...}}. Otherwise answer normally.`;
}

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string")
        return part.text;
      if (part?.type === "input_text" && typeof part.text === "string")
        return part.text;
      return `[Unsupported content part: ${part?.type ?? "unknown"}]`;
    })
    .join("\n");
}

export function providerForModel(model) {
  const value = typeof model === "string" ? model.toLowerCase().trim() : "";
  if (!value || value === "auto" || value === "bridge-auto") return null;
  const found = PROVIDERS.slice(1).find(
    (provider) =>
      value === provider ||
      value === `bridge-${provider}` ||
      value.includes(`bridge-${provider}`) ||
      value === `bridge_${provider}` ||
      value.startsWith(`${provider}-`) ||
      value.startsWith(`${provider}_`),
  );
  return found ?? null;
}
