const HOSTS = [
  "grok.com",
  "gemini.google.com",
  "chat.deepseek.com",
  "www.perplexity.ai",
  "chat.qwen.ai",
  "chat.qwenlm.ai",
  "chatgpt.com",
  "claude.ai",
  "chat.z.ai",
  "www.kimi.com",
  "muse.ai",
  "www.muse.ai",
];
const DEFAULTS = {
  serverUrl: "http://127.0.0.1:4317",
  token: "",
  displayName: "",
  profileInstanceId: "",
  paused: false,
};
let socket = null,
  timer = null,
  reconnect = null,
  inventoryBusy = false;
let settings = { ...DEFAULTS },
  socketState = "disconnected",
  lastError = "";
const assignments = new Map(),
  acknowledgements = new Map();
let connectionQueue = Promise.resolve(),
  dispatchQueue = Promise.resolve();
function localUrl(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw new Error("Only a local loopback HTTP server is allowed.");
  return u;
}
function send(msg) {
  if (socket?.readyState !== WebSocket.OPEN)
    throw new Error("Bridge disconnected.");
  socket.send(JSON.stringify(msg));
}
function badge() {
  chrome.action.setBadgeText({
    text: socketState === "connected" ? "ON" : settings.paused ? "II" : "!",
  });
}
async function inventory() {
  if (inventoryBusy) return null;
  inventoryBusy = true;
  try {
    const tabs = await chrome.tabs.query({
        url: HOSTS.map((h) => `https://${h}/*`),
      }),
      result = [];
    for (const tab of tabs) {
      try {
        const probe = await chrome.tabs.sendMessage(tab.id, {
          type: "bridge:probe",
        });
        if (probe?.documentSessionId && probe.url === tab.url)
          result.push({ ...probe, tabId: tab.id });
      } catch {
        /* no ready content script; never inject, reload or activate */
      }
    }
    return result;
  } finally {
    inventoryBusy = false;
  }
}
async function publishInventory() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const tabs = await inventory();
  if (tabs) send({ type: "bridge:inventory", tabs });
}
function connect() {
  connectionQueue = connectionQueue.catch(() => {}).then(connectOnce);
  return connectionQueue;
}
function rejectPendingUploads() {
  for (const pending of acknowledgements.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Connection lost; result unknown."));
  }
  acknowledgements.clear();
  assignments.clear();
}
async function connectOnce() {
  rejectPendingUploads();
  clearInterval(timer);
  clearTimeout(reconnect);
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.profileInstanceId) {
    settings.profileInstanceId = crypto.randomUUID();
    await chrome.storage.local.set({
      profileInstanceId: settings.profileInstanceId,
    });
  }
  if (settings.paused || !settings.token) {
    socketState = settings.paused ? "paused" : "needs-token";
    badge();
    return;
  }
  try {
    const u = localUrl(settings.serverUrl);
    u.protocol = "ws:";
    u.pathname = "/bridge";
    u.search = "";
    u.searchParams.set("token", settings.token);
    socket = new WebSocket(u);
    socketState = "connecting";
    badge();
    socket.onopen = async () => {
      try {
        send({
          type: "bridge:hello",
          protocol: 2,
          version: chrome.runtime.getManifest().version,
          profileInstanceId: settings.profileInstanceId,
          displayName: settings.displayName,
          tabs: (await inventory()) || [],
        });
        timer = setInterval(() => {
          try {
            send({ type: "bridge:ping" });
            publishInventory().catch(() => {});
          } catch {}
        }, 20_000);
      } catch (e) {
        lastError = e.message;
        socket.close();
      }
    };
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "bridge:run")
          dispatchQueue = dispatchQueue
            .catch(() => {})
            .then(() => handleServer(msg));
        else
          handleServer(msg).catch((e) => {
            lastError = e.message;
          });
      } catch {
        lastError = "Invalid bridge response.";
      }
    };
    socket.onclose = () => {
      socket = null;
      clearInterval(timer);
      socketState = "disconnected";
      badge();
      rejectPendingUploads();
      reconnect = setTimeout(connect, 3000);
    };
    socket.onerror = () => {
      lastError = "Cannot reach the local bridge.";
    };
  } catch (e) {
    lastError = e.message;
    socketState = "disconnected";
    badge();
  }
}
async function handleServer(msg) {
  if (
    msg.type === "bridge:registered" &&
    msg.profileInstanceId === settings.profileInstanceId
  ) {
    socketState = "connected";
    lastError = "";
    badge();
    return;
  }
  if (msg.type === "bridge:media-ack" || msg.type === "bridge:protocol-error") {
    const pending = acknowledgements.get(msg.requestId);
    if (pending) {
      acknowledgements.delete(msg.requestId);
      clearTimeout(pending.timer);
      msg.ok
        ? pending.resolve({ ok: true })
        : pending.reject(new Error(msg.message));
    } else if (msg.type === "bridge:protocol-error") {
      lastError = msg.message;
      if (
        ["profile_collision", "protocol_required", "hello_required"].includes(
          msg.code,
        )
      ) {
        socketState = "rejected";
        badge();
      }
    }
    return;
  }
  if (
    msg.type !== "bridge:run" ||
    msg.profileInstanceId !== settings.profileInstanceId
  )
    return;
  let forwarded = false;
  try {
    const seen = (await chrome.storage.local.get({ dispatchedTaskIds: [] }))
      .dispatchedTaskIds;
    if (seen.includes(msg.id)) {
      forwarded = true;
      throw new Error(
        "Duplicate dispatch refused; task may already have been submitted.",
      );
    }
    const tab = await chrome.tabs.get(msg.tabId);
    if (tab.url !== msg.expectedUrl)
      throw new Error("Tab URL changed before dispatch.");
    const probe = await chrome.tabs.sendMessage(msg.tabId, {
      type: "bridge:probe",
    });
    if (
      probe.documentSessionId !== msg.documentSessionId ||
      !probe.ready ||
      !probe.supported.includes(msg.kind)
    )
      throw new Error("Document session or capability changed.");
    await chrome.storage.local.set({
      dispatchedTaskIds: [...seen, msg.id].slice(-10000),
    });
    assignments.set(msg.id, msg);
    forwarded = true;
    const response = await chrome.tabs.sendMessage(msg.tabId, msg);
    if (!response?.ok)
      throw new Error(response?.error || "Content script refused the request.");
  } catch (e) {
    try {
      send({
        ...msg,
        type: "bridge:error",
        prompt: undefined,
        message: e.message,
        beforeSubmission: !forwarded,
      });
    } catch {}
  }
}
async function fromContent(message, sender) {
  const task = assignments.get(message.id);
  if (
    !task ||
    sender.tab?.id !== task.tabId ||
    sender.tab.url !== task.expectedUrl ||
    message.documentSessionId !== task.documentSessionId
  )
    throw new Error("Unmatched task, tab or document.");
  const envelope = {
    id: task.id,
    profileInstanceId: settings.profileInstanceId,
    tabId: task.tabId,
    documentSessionId: task.documentSessionId,
    dispatchToken: task.dispatchToken,
  };
  const types = [
    "bridge:started",
    "bridge:chunk",
    "bridge:complete",
    "bridge:error",
    "bridge:media-start",
    "bridge:media-chunk",
    "bridge:media-end",
  ];
  if (!types.includes(message.type)) throw new Error("Unsupported event.");
  if (message.type.startsWith("bridge:media-")) {
    const requestId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        acknowledgements.delete(requestId);
        reject(new Error("Media acknowledgement timed out."));
      }, 180000);
      acknowledgements.set(requestId, { resolve, reject, timer: timeout });
      try {
        send({ ...message, ...envelope, requestId });
      } catch (e) {
        clearTimeout(timeout);
        acknowledgements.delete(requestId);
        reject(e);
      }
    });
  } else send({ ...message, ...envelope });
  if (
    ["bridge:complete", "bridge:error", "bridge:media-end"].includes(
      message.type,
    )
  )
    assignments.delete(task.id);
  return { ok: true };
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === "bridge:get-state" && !sender.tab) {
    respond({ settings, socketState, lastError });
    return;
  }
  if (msg?.type === "bridge:save" && !sender.tab) {
    Promise.resolve()
      .then(async () => {
        localUrl(msg.serverUrl);
        await chrome.storage.local.set({
          serverUrl: msg.serverUrl,
          token: String(msg.token || "").trim(),
          displayName: String(msg.displayName || "").slice(0, 80),
          paused: false,
        });
        await connect();
        return { ok: true };
      })
      .then(respond, (e) => respond({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "bridge:toggle-pause" && !sender.tab) {
    chrome.storage.local
      .set({ paused: !settings.paused })
      .then(connect)
      .then(() => respond({ ok: true }));
    return true;
  }
  if (msg?.type === "bridge:site-message") {
    fromContent(msg.message, sender).then(respond, (e) =>
      respond({ ok: false, error: e.message }),
    );
    return true;
  }
});
chrome.tabs.onRemoved.addListener(() => publishInventory().catch(() => {}));
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === "complete" || change.url)
    publishInventory().catch(() => {});
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
