import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export const TERMINAL = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);
export const PROVIDERS = {
  chatgpt: ["chatgpt.com"],
  gemini: ["gemini.google.com"],
  claude: ["claude.ai"],
  deepseek: ["chat.deepseek.com"],
  grok: ["grok.com"],
  perplexity: ["www.perplexity.ai"],
  qwen: ["chat.qwen.ai", "chat.qwenlm.ai"],
  kimi: ["www.kimi.com"],
  zai: ["chat.z.ai"],
  muse: ["muse.ai", "www.muse.ai"],
};
export function providerForUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:"
      ? Object.keys(PROVIDERS).find((p) => PROVIDERS[p].includes(u.hostname))
      : null;
  } catch {
    return null;
  }
}
export function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
const now = () => new Date().toISOString();
const tabKey = (p, t) => `${p}:${t}`;
const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
function acquireLock(directory) {
  const file = path.join(directory, "server.lock"),
    owner = { pid: process.pid, nonce: crypto.randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(owner), {
        flag: "wx",
        mode: 0o600,
      });
      return () => {
        if (
          fs.existsSync(file) &&
          JSON.parse(fs.readFileSync(file, "utf8")).nonce === owner.nonce
        )
          fs.unlinkSync(file);
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const previous = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(previous.pid) || previous.pid <= 0)
        throw new Error("Invalid data-directory lock; inspect it manually.");
      try {
        process.kill(previous.pid, 0);
      } catch (check) {
        if (check.code === "ESRCH") {
          fs.unlinkSync(file);
          continue;
        }
        throw check;
      }
      throw new Error(
        "Another Bridge instance owns this data directory. Use one server per directory.",
      );
    }
  }
  throw new Error("Could not acquire data-directory lock.");
}

export class BridgeState extends EventEmitter {
  constructor(directory, { timeoutMs = 15 * 60_000, maxQueue = 100 } = {}) {
    super();
    this.directory = directory;
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.releaseLock = acquireLock(directory);
    this.file = path.join(directory, "state.json");
    try {
      this.data = fs.existsSync(this.file)
        ? JSON.parse(fs.readFileSync(this.file, "utf8"))
        : {
            version: 2,
            profiles: {},
            tabs: {},
            tasks: {},
            media: {},
            defaults: {},
          };
      if (this.data.version !== 2)
        throw new Error(
          "Unsupported state version; preserve state before migrating.",
        );
    } catch (e) {
      this.releaseLock();
      throw e;
    }
    this.clients = new Map();
    this.timers = new Map();
    for (const p of Object.values(this.data.profiles)) p.online = false;
    for (const t of Object.values(this.data.tabs)) {
      t.online = false;
      t.enabled = [];
    }
    for (const task of Object.values(this.data.tasks)) {
      if (["DISPATCHED", "RUNNING"].includes(task.status)) {
        task.status = "UNKNOWN";
        task.error =
          "Server restarted after dispatch; never retried automatically.";
        const tab = this.data.tabs[tabKey(task.profileInstanceId, task.tabId)];
        if (tab) tab.uncertain = true;
      }
    }
    this.save();
  }
  save() {
    const temp = `${this.file}.tmp`;
    const fd = fs.openSync(temp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.file);
    // Directory fsync is supported on Unix; Windows does not expose it reliably.
    if (process.platform !== "win32") {
      const dir = fs.openSync(this.directory, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    }
  }
  register(socket, hello) {
    const id = hello.profileInstanceId;
    if (hello.protocol !== 2 || !validId(id))
      throw problem(
        "protocol_required",
        "Extension protocol 2 and stable Profile ID are required.",
      );
    if (socket.profileInstanceId && socket.profileInstanceId !== id)
      throw problem(
        "profile_mismatch",
        "A connection cannot change Profile ID.",
      );
    const previous = this.clients.get(id);
    if (previous && previous !== socket)
      throw problem(
        "profile_collision",
        "This Profile ID is already connected. Disconnect it or reset a copied extension identity.",
        409,
      );
    socket.profileInstanceId = id;
    socket.lastSeen = Date.now();
    this.clients.set(id, socket);
    this.data.profiles[id] = {
      ...this.data.profiles[id],
      profileInstanceId: id,
      displayName: String(
        this.data.profiles[id]?.displayName ||
          hello.displayName ||
          "Unnamed profile",
      ).slice(0, 80),
      online: true,
      lastSeen: now(),
    };
    this.inventory(id, hello.tabs || []);
  }
  inventory(id, tabs) {
    this.data.profiles[id].lastSeen = now();
    if (!Array.isArray(tabs) || tabs.length > 200)
      throw problem("invalid_inventory", "At most 200 tabs per profile.");
    const seen = new Set();
    for (const entry of tabs) {
      if (
        !Number.isInteger(entry.tabId) ||
        !validId(entry.documentSessionId) ||
        !providerForUrl(entry.url)
      )
        continue;
      const provider = providerForUrl(entry.url),
        key = tabKey(id, entry.tabId),
        old = this.data.tabs[key];
      seen.add(key);
      const same =
        old?.documentSessionId === entry.documentSessionId &&
        old?.url === entry.url;
      const supported = [
        ...new Set(
          (Array.isArray(entry.supported) ? entry.supported : []).filter((k) =>
            ["text", "image", "video"].includes(k),
          ),
        ),
      ];
      this.data.tabs[key] = {
        profileInstanceId: id,
        tabId: entry.tabId,
        documentSessionId: entry.documentSessionId,
        url: entry.url,
        provider,
        online: true,
        ready: entry.ready === true,
        supported,
        enabled: same ? old.enabled.filter((k) => supported.includes(k)) : [],
        verified: same ? old.verified || {} : {},
        uncertain: old?.uncertain || false,
      };
      if (old && !same) this.invalidateTab(old, "Tab navigated or reloaded.");
    }
    for (const [key, tab] of Object.entries(this.data.tabs)) {
      if (tab.profileInstanceId === id && !seen.has(key)) {
        tab.online = false;
        tab.enabled = [];
        this.invalidateTab(tab, "Tab closed or content script unavailable.");
      }
    }
    this.save();
    this.pump();
  }
  configureTab(profile, id, input) {
    const tab = this.data.tabs[tabKey(profile, Number(id))];
    if (!tab || !tab.online)
      throw problem("tab_offline", "Tab is offline.", 409);
    if (input.documentSessionId !== tab.documentSessionId)
      throw problem(
        "stale_document",
        "Refresh inventory and explicitly select the current document.",
        409,
      );
    if (input.releaseUnknown === true) {
      if (this.busy(tab))
        throw problem(
          "tab_busy",
          "Cannot release a tab with an active task.",
          409,
        );
      tab.uncertain = false;
    }
    if (input.enabled !== undefined) {
      if (
        !Array.isArray(input.enabled) ||
        input.enabled.some((k) => !tab.supported.includes(k))
      )
        throw problem(
          "unsupported_capability",
          "The current adapter has not detected that capability.",
          422,
        );
      tab.enabled = [...new Set(input.enabled)];
    }
    this.save();
    this.pump();
    return tab;
  }
  busy(tab) {
    return Object.values(this.data.tasks).some(
      (t) =>
        t.profileInstanceId === tab.profileInstanceId &&
        t.tabId === tab.tabId &&
        ["DISPATCHED", "RUNNING"].includes(t.status),
    );
  }
  create(kind, body, key) {
    if (!["text", "image", "video"].includes(kind))
      throw problem("unsupported_kind", "Unsupported task kind.");
    if (
      !body ||
      typeof body.prompt !== "string" ||
      !body.prompt.trim() ||
      body.prompt.length > 100_000
    )
      throw problem(
        "invalid_prompt",
        "Prompt must contain 1–100000 characters.",
      );
    if (
      key !== undefined &&
      (typeof key !== "string" || key.length < 1 || key.length > 160)
    )
      throw problem(
        "invalid_idempotency_key",
        "Idempotency-Key must contain 1–160 characters.",
      );
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ kind, body }))
      .digest("hex");
    if (key) {
      const existing = Object.values(this.data.tasks).find(
        (t) => t.idempotencyKey === key,
      );
      if (existing) {
        if (existing.requestHash !== hash)
          throw problem(
            "idempotency_conflict",
            "The same key was used for a different request.",
            409,
          );
        return existing;
      }
    }
    if (
      Object.values(this.data.tasks).filter((t) => !TERMINAL.has(t.status))
        .length >= this.maxQueue
    )
      throw problem("queue_full", "Task queue is full.", 429);
    const target = body.target || this.data.defaults[kind];
    if (
      !target?.profileInstanceId ||
      !Number.isInteger(target.tabId) ||
      !target.documentSessionId
    )
      throw problem(
        "target_required",
        "Select an explicit Profile, tab and document session, or set a default target.",
        422,
      );
    const tab = this.data.tabs[tabKey(target.profileInstanceId, target.tabId)];
    this.checkTarget(tab, target, kind, body.provider);
    const task = {
      id: crypto.randomUUID(),
      kind,
      prompt: body.prompt,
      provider: tab.provider,
      profileInstanceId: tab.profileInstanceId,
      tabId: tab.tabId,
      documentSessionId: tab.documentSessionId,
      url: tab.url,
      status: "QUEUED",
      createdAt: now(),
      updatedAt: now(),
      idempotencyKey: key,
      requestHash: hash,
      text: "",
      media: [],
      model: body.model || `bridge-${tab.provider}`,
      tools: body.tools || [],
    };
    this.data.tasks[task.id] = task;
    this.save();
    this.pump();
    return task;
  }
  checkTarget(tab, target, kind, provider) {
    if (!tab?.online || !this.clients.has(target.profileInstanceId))
      throw problem("tab_offline", "Selected Profile/tab is offline.", 409);
    if (this.data.profiles[target.profileInstanceId]?.enabled === false)
      throw problem("profile_disabled", "Selected Profile is disabled.", 409);
    if (tab.documentSessionId !== target.documentSessionId)
      throw problem(
        "stale_document",
        "Document session changed. Select the tab again.",
        409,
      );
    if (!tab.ready || tab.uncertain)
      throw problem(
        "tab_not_ready",
        "Tab is not ready or has an unresolved UNKNOWN task.",
        409,
      );
    if (provider && provider !== tab.provider)
      throw problem(
        "provider_mismatch",
        "Selected provider does not match selected tab.",
        422,
      );
    if (!tab.supported.includes(kind) || !tab.enabled.includes(kind))
      throw problem(
        "capability_disabled",
        "Capability must be detected and explicitly enabled for this tab.",
        422,
      );
  }
  pump() {
    for (const task of Object.values(this.data.tasks)) {
      if (task.status !== "QUEUED") continue;
      const tab = this.data.tabs[tabKey(task.profileInstanceId, task.tabId)];
      try {
        this.checkTarget(tab, task, task.kind, task.provider);
      } catch (e) {
        this.transition(task, "FAILED", e.message);
        continue;
      }
      if (this.busy(tab)) continue;
      task.dispatchToken = crypto.randomBytes(24).toString("hex");
      this.transition(task, "DISPATCHED"); // Durable before any side effect.
      const socket = this.clients.get(task.profileInstanceId);
      try {
        socket.send(
          JSON.stringify({
            type: "bridge:run",
            ...this.envelope(task),
            kind: task.kind,
            prompt: task.prompt,
            expectedUrl: task.url,
          }),
        );
      } catch {
        this.unknown(task, "Dispatch failed after durable intent.");
        continue;
      }
      this.timers.set(
        task.id,
        setTimeout(() => {
          this.unknown(task, "Task deadline exceeded after dispatch.");
          this.pump();
        }, this.timeoutMs),
      );
    }
  }
  envelope(t) {
    return {
      id: t.id,
      profileInstanceId: t.profileInstanceId,
      tabId: t.tabId,
      documentSessionId: t.documentSessionId,
      dispatchToken: t.dispatchToken,
    };
  }
  match(socket, msg) {
    const t = this.data.tasks[msg.id];
    if (
      !t ||
      this.clients.get(t.profileInstanceId) !== socket ||
      socket.profileInstanceId !== t.profileInstanceId ||
      msg.tabId !== t.tabId ||
      msg.documentSessionId !== t.documentSessionId ||
      msg.dispatchToken !== t.dispatchToken ||
      TERMINAL.has(t.status)
    )
      throw problem(
        "stale_event",
        "Event does not match an active task/session.",
        409,
      );
    return t;
  }
  checkTurn(task, turnId) {
    if (typeof turnId !== "string" || !turnId || turnId.length > 100)
      throw problem("invalid_turn", "Response turn ID is required.", 422);
    if (
      Object.values(this.data.tasks).some(
        (t) =>
          t.id !== task.id &&
          t.profileInstanceId === task.profileInstanceId &&
          t.documentSessionId === task.documentSessionId &&
          t.turnId === turnId,
      )
    )
      throw problem(
        "reused_turn",
        "A previous task already owns that response turn.",
        409,
      );
  }
  transition(task, status, error) {
    task.status = status;
    task.updatedAt = now();
    if (error) task.error = error;
    if (TERMINAL.has(status)) {
      clearTimeout(this.timers.get(task.id));
      this.timers.delete(task.id);
    }
    this.save();
    this.emit("task", task);
  }
  unknown(t, reason) {
    const tab = this.data.tabs[tabKey(t.profileInstanceId, t.tabId)];
    if (tab) tab.uncertain = true;
    this.transition(t, "UNKNOWN", reason);
  }
  event(socket, msg) {
    const t = this.match(socket, msg);
    if (msg.type === "bridge:started" && t.status === "DISPATCHED")
      this.transition(t, "RUNNING");
    if (
      msg.type === "bridge:chunk" &&
      t.kind === "text" &&
      t.status === "RUNNING"
    ) {
      if (
        typeof msg.text !== "string" ||
        t.text.length + msg.text.length > 1_000_000
      )
        throw problem("text_limit", "Text output exceeds limit.");
      t.text += msg.text;
      this.emit("chunk", t, msg.text);
    }
    if (msg.type === "bridge:complete") {
      if (
        t.kind !== "text" ||
        t.status !== "RUNNING" ||
        typeof msg.turnId !== "string" ||
        !msg.turnId ||
        !t.text
      )
        throw problem(
          "invalid_completion",
          "Text completion requires a new matched response; media requires validated files.",
          409,
        );
      this.checkTurn(t, msg.turnId);
      t.turnId = msg.turnId;
      this.complete(t);
    }
    if (msg.type === "bridge:error") {
      // Only pre-submission refusals are definite failures. Any possible submission is UNKNOWN.
      if (t.status === "DISPATCHED" && msg.beforeSubmission === true)
        this.transition(
          t,
          "FAILED",
          String(msg.message || "Preflight rejected.").slice(0, 300),
        );
      else
        this.unknown(
          t,
          String(msg.message || "Browser result is unknown.").slice(0, 300),
        );
      this.pump();
    }
    // Cancellation is never inferred from a lost connection or a local stop button.
  }
  complete(t) {
    const tab = this.data.tabs[tabKey(t.profileInstanceId, t.tabId)];
    if (
      !tab?.online ||
      tab.documentSessionId !== t.documentSessionId ||
      tab.url !== t.url
    ) {
      this.unknown(t, "Document changed before completion.");
      return;
    }
    tab.verified[t.kind] = {
      taskId: t.id,
      at: now(),
      evidence: "adapter-reported-session-result",
    };
    this.transition(t, "COMPLETED");
    this.pump();
  }
  invalidateTab(tab, reason) {
    for (const t of Object.values(this.data.tasks))
      if (
        t.profileInstanceId === tab.profileInstanceId &&
        t.tabId === tab.tabId &&
        ["DISPATCHED", "RUNNING"].includes(t.status)
      ) {
        this.unknown(t, reason);
        const current = this.data.tabs[tabKey(t.profileInstanceId, t.tabId)];
        if (current) current.uncertain = true;
      }
  }
  disconnect(socket) {
    const id = socket.profileInstanceId;
    if (!id || this.clients.get(id) !== socket) return;
    this.clients.delete(id);
    this.data.profiles[id].online = false;
    for (const tab of Object.values(this.data.tabs))
      if (tab.profileInstanceId === id) {
        tab.online = false;
        tab.enabled = [];
        this.invalidateTab(
          tab,
          "Profile disconnected; submission was not retried.",
        );
      }
    this.save();
    this.pump();
  }
  cancel(id) {
    const t = this.getTask(id);
    if (t.status === "QUEUED") {
      this.transition(t, "CANCELLED");
      return t;
    }
    if (TERMINAL.has(t.status)) return t;
    throw problem(
      "cancel_unconfirmed",
      "The website has not confirmed cancellation. Task remains active; no false CANCELLED state.",
      409,
    );
  }
  getTask(id) {
    const t = this.data.tasks[id];
    if (!t) throw problem("task_not_found", "Task not found.", 404);
    return t;
  }
  publicTask(t) {
    const {
      prompt,
      dispatchToken,
      requestHash,
      idempotencyKey,
      tools,
      ...safe
    } = t;
    return safe;
  }
  close() {
    for (const t of Object.values(this.data.tasks))
      if (["DISPATCHED", "RUNNING"].includes(t.status))
        this.unknown(t, "Bridge shut down after dispatch.");
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.releaseLock();
  }
}
