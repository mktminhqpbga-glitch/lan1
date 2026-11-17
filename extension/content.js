const DOCUMENT_SESSION_ID = crypto.randomUUID();
const PROVIDER = detectProvider(location.hostname);
const PROVIDER_DISPLAY_NAMES = {
  grok: "Grok",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  qwen: "Qwen",
  chatgpt: "ChatGPT",
  claude: "Claude",
  zai: "Z.ai",
  kimi: "Kimi",
  muse: "Muse",
};
let runningRequest = null;
const USER_SELECTOR =
  '[data-message-author-role="user"], [data-testid="user-message"], [data-role="user"], .chat-user-bubble, .hatch-user-bubble-bg, .user-message';
const normalize = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim();
const RESPONSE_IDS = new WeakMap();
function userTurns() {
  return [...document.querySelectorAll(USER_SELECTOR)]
    .filter(isVisible)
    .filter(
      (node, _, all) =>
        !all.some((other) => other !== node && other.contains(node)),
    );
}
function responseRoots() {
  const config = SITE_CONFIG[PROVIDER];
  if (!config) return [];
  for (const selector of config.output || ['[class*="font-claude-response"]']) {
    const nodes = [...document.querySelectorAll(selector)]
      .filter(isVisible)
      .filter((n) => !n.closest(USER_SELECTOR));
    if (nodes.length)
      return nodes.filter(
        (n, _, all) => !all.some((other) => other !== n && other.contains(n)),
      );
  }
  return [];
}
function selectedMediaMode() {
  if (PROVIDER !== "muse") return null;
  const selected = [
    ...document.querySelectorAll(
      '[aria-pressed="true"], [aria-selected="true"], input:checked',
    ),
  ].filter(isVisible);
  const labels = selected.map((n) =>
    normalize(
      n.getAttribute("aria-label") || n.textContent || n.value,
    ).toLowerCase(),
  );
  if (
    labels.some((s) =>
      /^(video|create video|generate video|视频|tạo video)$/.test(s),
    )
  )
    return "video";
  if (
    labels.some((s) =>
      /^(image|images|create image|generate image|图片|图像|tạo ảnh)$/.test(s),
    )
  )
    return "image";
  return null;
}
function probe() {
  const ready = Boolean(
    PROVIDER &&
      findVisible(SITE_CONFIG[PROVIDER].input) &&
      !runningRequest &&
      !isGenerating(),
  );
  const mode = selectedMediaMode();
  return {
    documentSessionId: DOCUMENT_SESSION_ID,
    url: location.href,
    provider: PROVIDER,
    ready,
    supported: PROVIDER ? (mode ? [mode] : ["text"]) : [],
  };
}
async function report(message) {
  const result = await chrome.runtime.sendMessage({
    type: "bridge:site-message",
    message: { ...message, documentSessionId: DOCUMENT_SESSION_ID },
  });
  if (!result?.ok)
    throw new Error(result?.error || "Bridge acknowledgement missing.");
}
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "bridge:probe") {
    respond(probe());
    return;
  }
  if (msg?.type !== "bridge:run") return;
  const p = probe();
  if (
    msg.documentSessionId !== DOCUMENT_SESSION_ID ||
    msg.expectedUrl !== location.href ||
    !p.ready ||
    !p.supported.includes(msg.kind)
  ) {
    respond({ ok: false, error: "Tab/session/capability is no longer ready." });
    return;
  }
  runningRequest = msg.id;
  executeTask(msg).finally(() => {
    runningRequest = null;
  });
  respond({ ok: true });
});
async function executeTask(task) {
  let submissionStarted = false;
  try {
    const composer = findVisible(SITE_CONFIG[PROVIDER].input);
    if (!composer || normalize(composer.value || composer.textContent))
      throw new Error(
        "Composer contains a user draft or is unavailable; refusing to overwrite.",
      );
    const prompt = resolvePromptModelName(task.prompt);
    const beforeUsers = new Set(userTurns()),
      beforeResponses = new Set(responseRoots());
    const beforeMedia = new Set(
      [...document.querySelectorAll("img,video,source,a[download]")]
        .map((n) => n.currentSrc || n.src || n.href)
        .filter(Boolean),
    );
    if (location.href !== task.expectedUrl)
      throw new Error("Page navigated before submission.");
    await report({ type: "bridge:started", id: task.id });
    submissionStarted = true;
    setComposerText(composer, prompt);
    await delay(80);
    if (location.href !== task.expectedUrl)
      throw new Error("Page navigated before send.");
    if (!clickSendButton()) {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      composer.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    const started = Date.now();
    let last = "",
      changedAt = Date.now();
    while (Date.now() - started < 14 * 60_000) {
      await delay(500);
      if (location.href !== task.expectedUrl)
        throw new Error("Task document navigated.");
      const freshUsers = userTurns().filter((n) => !beforeUsers.has(n));
      const matching = freshUsers.filter(
        (n) => normalize(n.textContent) === normalize(prompt),
      );
      if (freshUsers.length > 1)
        throw new Error(
          "Another conversation turn appeared; task ownership is ambiguous.",
        );
      if (matching.length !== 1) continue;
      const user = matching[0];
      const roots = responseRoots().filter(
        (n) =>
          !beforeResponses.has(n) &&
          !user.contains(n) &&
          user.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      if (roots.length > 1)
        throw new Error(
          "Multiple new assistant turns; cannot prove task ownership.",
        );
      if (!roots.length) continue;
      const root = roots[0];
      if (!RESPONSE_IDS.has(root)) RESPONSE_IDS.set(root, crypto.randomUUID());
      const turnId = RESPONSE_IDS.get(root);
      const current =
        task.kind === "text"
          ? markdownFromElement(root)
          : JSON.stringify(
              [...root.querySelectorAll("img,video,source,a[download]")].map(
                (n) => n.currentSrc || n.src || n.href,
              ),
            );
      if (current !== last) {
        last = current;
        changedAt = Date.now();
      }
      if (!current || isGenerating() || Date.now() - changedAt < 4000) continue;
      if (task.kind === "text") {
        await report({ type: "bridge:chunk", id: task.id, text: current });
        await report({ type: "bridge:complete", id: task.id, turnId });
        return;
      }
      const source = originalMedia(root, task.kind, beforeMedia);
      if (!source) continue;
      await streamMedia(task, source, turnId);
      return;
    }
    throw new Error("No provable new response/original media before deadline.");
  } catch (error) {
    try {
      await report({
        type: "bridge:error",
        id: task.id,
        beforeSubmission: !submissionStarted,
        message: error.message,
      });
    } catch {
      /* server marks UNKNOWN after disconnect */
    }
  }
}
function originalMedia(root, kind, old) {
  // Image thumbnails are not treated as originals. Only an explicit download link
  // or a provider-declared original URL can supply image bytes.
  const nodes =
    kind === "image"
      ? [...root.querySelectorAll("a[download][href], img[data-original]")]
      : [...root.querySelectorAll("video, video source, a[download][href]")];
  const candidates = nodes
    .map((n) => n.dataset.original || n.currentSrc || n.src || n.href)
    .filter(Boolean);
  for (const raw of candidates) {
    try {
      const u = new URL(raw, location.href);
      if (old.has(u.href)) continue;
      if (
        u.protocol === "https:" ||
        (u.protocol === "blob:" && u.origin === location.origin)
      )
        return u.href;
    } catch {}
  }
  return null;
}
async function streamMedia(task, url, turnId) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 5 * 60_000);
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok || !response.body)
      throw new Error("Website did not provide a readable original file.");
    await report({
      type: "bridge:media-start",
      id: task.id,
      turnId,
      original: true,
    });
    const reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (let start = 0; start < value.length; start += 128 * 1024) {
          const part = value.subarray(start, start + 128 * 1024);
          if (offset + part.length > 256 * 1024 * 1024)
            throw new Error("Media exceeds 256 MiB limit.");
          let binary = "";
          for (let i = 0; i < part.length; i += 8192)
            binary += String.fromCharCode(...part.subarray(i, i + 8192));
          await report({
            type: "bridge:media-chunk",
            id: task.id,
            offset,
            data: btoa(binary),
          });
          offset += part.length;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    await report({
      type: "bridge:media-end",
      id: task.id,
      bytes: offset,
      turnId,
    });
  } finally {
    clearTimeout(timeout);
  }
}
const SITE_CONFIG = {
  muse: {
    input: ['[contenteditable="true"][role="textbox"]', "textarea"],
    output: [
      '[data-message-author-role="assistant"]',
      '[data-testid="assistant-message"]',
      ".hatch-agent-bubble-bg",
    ],
  },
  grok: {
    input: [
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ],
    output: [
      "[data-testid='conversation-turn'] .markdown",
      "[data-testid='conversation-turn']",
      ".message-content",
    ],
  },
  gemini: {
    input: [
      "rich-textarea [contenteditable='true']",
      "textarea",
      "[contenteditable='true'][role='textbox']",
    ],
    output: [
      "model-response",
      "message-content",
      ".model-response",
      ".message-content",
    ],
  },
  deepseek: {
    input: [
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ],
    output: [".ds-markdown", "[class*='message-content']", ".markdown-body"],
  },
  perplexity: {
    input: [
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ],
    output: [
      "[class*='answer'] .prose",
      "[class*='prose']",
      "[data-testid*='answer']",
    ],
  },
  qwen: {
    input: [
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ],
    output: [
      "[class*='message-content']",
      ".markdown-body",
      "[class*='markdown']",
    ],
  },
  chatgpt: {
    input: [
      "#prompt-textarea",
      "textarea",
      "[contenteditable='true'][role='textbox']",
    ],
    output: ["[data-message-author-role='assistant']"],
  },
  claude: {
    input: [
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
      "textarea",
    ],
    extractor: "claude",
    streamFinalOnly: true,
  },
  zai: {
    input: [
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ],
    output: ["[class*='markdown']", "[class*='message-content']"],
  },
  kimi: {
    input: [
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ],
    output: [
      "[class*='markdown']",
      "[class*='message-content']",
      ".markdown-body",
    ],
  },
};

function resolvePromptModelName(prompt) {
  if (typeof prompt !== "string" || !prompt.includes("{{modelName}}"))
    return prompt;
  const modelName =
    PROVIDER_DISPLAY_NAMES[PROVIDER] ?? PROVIDER ?? "the assistant";
  return prompt.replaceAll("{{modelName}}", modelName);
}

function setComposerText(element, text) {
  element.focus();
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    );
    descriptor?.set?.call(element, text);
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, text);
    if (element.textContent?.trim() !== text.trim()) element.textContent = text;
  }
  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }),
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickSendButton() {
  const candidates = document.querySelectorAll(
    [
      "button[aria-label*='Send' i]",
      "button[aria-label*='Submit' i]",
      "button[aria-label*='发送']",
      "button[data-testid*='send' i]",
      "button[class*='send' i]",
    ].join(","),
  );
  const button = [...candidates].find(
    (item) =>
      isVisible(item) &&
      !item.disabled &&
      item.getAttribute("aria-disabled") !== "true",
  );
  if (!button) return false;
  button.click();
  return true;
}

function latestResponseText(config) {
  if (config.extractor === "claude") return latestClaudeResponseText();
  for (const selector of config.output) {
    const matches = [...document.querySelectorAll(selector)]
      .filter(isVisible)
      .map(markdownFromElement);
    const text = matches.at(-1);
    if (text) return text;
  }
  return "";
}

function latestClaudeResponseText() {
  const selector = "[class*='font-claude-response']";
  const blocks = [...document.querySelectorAll(selector)].filter(isVisible);
  if (blocks.length > 0) {
    const latestBlock = blocks.at(-1);
    const root =
      latestBlock.closest("[data-test-render-count]") ??
      latestBlock.parentElement;
    if (!root || root === latestBlock) return markdownFromElement(latestBlock);
    const groupedBlocks = [...root.querySelectorAll(selector)]
      .filter(isVisible)
      .filter(
        (block, _index, all) =>
          !all.some((other) => other !== block && other.contains(block)),
      );
    const text = mergeClaudeResponseBlocks(
      groupedBlocks.map(markdownFromElement),
    );
    if (text) return text;
  }

  const fallback = [...document.querySelectorAll("[data-test-render-count]")]
    .filter(isVisible)
    .at(-1);
  return fallback ? markdownFromElement(fallback) : "";
}

function mergeClaudeResponseBlocks(blocks) {
  const unique = [];
  for (const block of blocks) {
    if (!block || isClaudeInterimStatus(block)) continue;
    if (
      unique.some((existing) => existing === block || existing.includes(block))
    )
      continue;
    while (unique.length > 0 && block.includes(unique.at(-1))) unique.pop();
    unique.push(block);
  }
  return unique.join("\n\n");
}

function isClaudeInterimStatus(text) {
  return /^(?:musing|thinking|crystallizing|thought for\s+\d+s|recogniz(?:ed|ing)\b.*\b(?:question|request|attempt|integrity)\b)/i.test(
    text.trim(),
  );
}

function markdownFromElement(element) {
  const markdown = renderMarkdownNode(element);
  return cleanMarkdown(markdown) || cleanText(element.innerText);
}

function renderMarkdownNode(node) {
  if (node.nodeType === Node.TEXT_NODE)
    return node.nodeValue.replace(/\s+/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  const content = () => [...node.childNodes].map(renderMarkdownNode).join("");
  switch (tag) {
    case "br":
      return "\n";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `\n\n${"#".repeat(Number(tag[1]))} ${cleanMarkdown(content())}\n\n`;
    case "p":
    case "div":
    case "section":
    case "article":
      return `\n\n${content()}\n\n`;
    case "strong":
    case "b":
      return `**${cleanMarkdown(content())}**`;
    case "em":
    case "i":
      return `*${cleanMarkdown(content())}*`;
    case "del":
    case "s":
      return `~~${cleanMarkdown(content())}~~`;
    case "code":
      return `\`${node.textContent.replace(/`/g, "\\`")}\``;
    case "pre":
      return renderCodeBlock(node);
    case "a": {
      const label = cleanMarkdown(content());
      const href = node.getAttribute("href");
      return href && label ? `[${label}](${href})` : label;
    }
    case "blockquote":
      return `\n\n${cleanMarkdown(content())
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    case "ul":
      return renderList(node, false);
    case "ol":
      return renderList(node, true);
    case "table":
      return renderTable(node);
    case "hr":
      return "\n\n---\n\n";
    case "img": {
      const alt = node.getAttribute("alt") ?? "image";
      // Media URLs may contain upstream signatures; keep them inside the browser.
      return `[${alt}: use a media task to collect the original file]`;
    }
    default:
      return content();
  }
}

function renderCodeBlock(node) {
  const code = node.querySelector("code");
  const source = (code ?? node).textContent.replace(/^\n+|\n+$/g, "");
  const language =
    [...(code?.classList ?? [])]
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length) ?? "";
  return `\n\n\`\`\`${language}\n${source}\n\`\`\`\n\n`;
}

function renderList(list, ordered) {
  const items = [...list.children].filter(
    (child) => child.tagName?.toLowerCase() === "li",
  );
  const rendered = items.map((item, index) => {
    const body = [...item.childNodes]
      .filter((child) => !["ul", "ol"].includes(child.tagName?.toLowerCase()))
      .map(renderMarkdownNode)
      .join("");
    const nested = [...item.children]
      .filter((child) => ["ul", "ol"].includes(child.tagName.toLowerCase()))
      .map((child) => indentMarkdown(renderMarkdownNode(child), "    "))
      .join("");
    return `${ordered ? `${index + 1}.` : "-"} ${cleanMarkdown(body)}${nested ? `\n${nested}` : ""}`;
  });
  return `\n\n${rendered.join("\n")}\n\n`;
}

function renderTable(table) {
  const rows = [...table.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) =>
      cleanMarkdown(renderMarkdownNode(cell)).replace(/\|/g, "\\|"),
    ),
  );
  if (rows.length === 0 || rows[0].length === 0) return "";
  const width = rows[0].length;
  const normalized = rows.map((row) =>
    [...row, ...Array(Math.max(0, width - row.length)).fill("")].slice(
      0,
      width,
    ),
  );
  const header = normalized[0];
  const body = normalized.slice(1);
  return `\n\n| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |${body.length ? `\n${body.map((row) => `| ${row.join(" | ")} |`).join("\n")}` : ""}\n\n`;
}

function indentMarkdown(value, prefix) {
  return cleanMarkdown(value)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function cleanMarkdown(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isGenerating() {
  return [
    ...document.querySelectorAll(
      "button[aria-label*='Stop' i], button[aria-label*='停止'], button[data-testid*='stop' i]",
    ),
  ].some(isVisible);
}

function findVisible(selectors) {
  for (const selector of selectors) {
    const item = [...document.querySelectorAll(selector)].find(isVisible);
    if (item) return item;
  }
  return null;
}

function isVisible(element) {
  const style = getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}

function cleanText(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detectProvider(host) {
  if (["muse.ai", "www.muse.ai"].includes(host)) return "muse";
  if (host === "grok.com" || host.endsWith(".grok.com")) return "grok";
  if (host.endsWith("gemini.google.com")) return "gemini";
  if (host.endsWith("chat.deepseek.com")) return "deepseek";
  if (host.endsWith("www.perplexity.ai")) return "perplexity";
  if (host.endsWith("chat.qwen.ai") || host.endsWith("chat.qwenlm.ai"))
    return "qwen";
  if (host.endsWith("chatgpt.com")) return "chatgpt";
  if (host.endsWith("claude.ai")) return "claude";
  if (host.endsWith("chat.z.ai")) return "zai";
  if (host.endsWith("www.kimi.com") || host.endsWith("kimi.com")) return "kimi";
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
