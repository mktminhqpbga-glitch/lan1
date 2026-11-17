import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { JSDOM } from "jsdom";
const content = fs.readFileSync(
  new URL("../extension/content.js", import.meta.url),
  "utf8",
);
const background = fs.readFileSync(
  new URL("../extension/background.js", import.meta.url),
  "utf8",
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await pause(5);
  }
  throw new Error("Fixture did not reach expected state.");
}
function domFixture(
  c,
  html = '<textarea></textarea><button aria-label="Send">Send</button>',
) {
  const dom = new JSDOM(html, {
      url: "https://muse.ai/chat/test",
      runScripts: "outside-only",
    }),
    w = dom.window,
    listeners = [],
    events = [];
  let clock = 0;
  w.Date.now = () => clock;
  w.setTimeout = (fn, ms) =>
    setTimeout(() => {
      clock += ms;
      fn();
    }, 0);
  w.clearTimeout = clearTimeout;
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 10, height: 10 }];
  };
  w.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        events.push(msg.message);
        return { ok: true };
      },
    },
  };
  w.eval(content);
  c.after(() => dom.window.close());
  const probe = () => {
    let result;
    listeners[0]({ type: "bridge:probe" }, {}, (r) => (result = r));
    return result;
  };
  const run = (overrides = {}) => {
    let result;
    listeners[0](
      {
        type: "bridge:run",
        id: randomUUID(),
        kind: "text",
        documentSessionId: probe().documentSessionId,
        expectedUrl: w.location.href,
        prompt: "new task prompt",
        ...overrides,
      },
      {},
      (r) => (result = r),
    );
    return result;
  };
  return { dom, w, events, probe, run };
}

test("DOM probe distinguishes detected text and experimental Muse modes; stale document does not send", (c) => {
  const f = domFixture(c);
  assert.deepEqual(Array.from(f.probe().supported), ["text"]);
  const toggle = f.w.document.createElement("button");
  toggle.setAttribute("aria-pressed", "true");
  toggle.textContent = "Video";
  f.w.document.body.append(toggle);
  assert.deepEqual(Array.from(f.probe().supported), ["video"]);
  assert.equal(f.run({ documentSessionId: "stale-document" }).ok, false);
  assert.equal(f.events.length, 0);
});

test("DOM never overwrites a user draft or sends while the website is generating", async (c) => {
  const f = domFixture(c);
  f.w.document.querySelector("textarea").value = "private unsent draft";
  assert.equal(f.run().ok, true);
  await until(() => f.events.some((e) => e.type === "bridge:error"));
  assert.equal(
    f.events.find((e) => e.type === "bridge:error").beforeSubmission,
    true,
  );
  assert.equal(
    f.w.document.querySelector("textarea").value,
    "private unsent draft",
  );
  const stop = f.w.document.createElement("button");
  stop.setAttribute("aria-label", "Stop");
  f.w.document.body.append(stop);
  assert.equal(f.probe().ready, false);
});

test("DOM text completes only for a new matching user turn and its following assistant response", async (c) => {
  const f = domFixture(
    c,
    '<div data-message-author-role="user">old prompt</div><div data-message-author-role="assistant">old answer</div><textarea></textarea><button aria-label="Send">Send</button>',
  );
  f.w.document.querySelector("button").addEventListener("click", () => {
    const user = f.w.document.createElement("div");
    user.dataset.messageAuthorRole = "user";
    user.textContent = "new task prompt";
    const answer = f.w.document.createElement("div");
    answer.dataset.messageAuthorRole = "assistant";
    answer.textContent = "new answer";
    f.w.document.body.append(user, answer);
  });
  assert.equal(f.run().ok, true);
  await until(() => f.events.some((e) => e.type === "bridge:complete"));
  assert.equal(
    f.events.find((e) => e.type === "bridge:chunk").text,
    "new answer",
  );
  assert.ok(f.events.find((e) => e.type === "bridge:complete").turnId);
});

test("DOM rejects unrelated new turns and never reuses historical or thumbnail media", async (c) => {
  const f = domFixture(
    c,
    '<div data-message-author-role="assistant"><a download href="/old.png">old</a></div><textarea></textarea><button aria-label="Send">Send</button>',
  );
  const root = f.w.document.querySelector("div");
  assert.equal(
    f.w.originalMedia(root, "image", new Set(["https://muse.ai/old.png"])),
    null,
  );
  root.replaceChildren(f.w.document.createElement("img"));
  root.firstChild.src = "https://muse.ai/thumbnail.png";
  assert.equal(f.w.originalMedia(root, "image", new Set()), null);
  f.w.document.querySelector("button").addEventListener("click", () => {
    for (const text of ["new task prompt", "a different human prompt"]) {
      const n = f.w.document.createElement("div");
      n.dataset.messageAuthorRole = "user";
      n.textContent = text;
      f.w.document.body.append(n);
    }
  });
  f.run();
  await until(() => f.events.some((e) => e.type === "bridge:error"));
  assert.equal(
    f.events.some((e) => e.type === "bridge:complete"),
    false,
  );
  assert.equal(
    f.events.find((e) => e.type === "bridge:error").beforeSubmission,
    false,
  );
});

test("DOM media collector streams original bytes with ordered offsets and a turn ID", async (c) => {
  const f = domFixture(c);
  const bytes = new Uint8Array(300000).map((_, i) => i % 256);
  f.w.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  });
  const nativeTimeout = f.w.setTimeout;
  f.w.setTimeout = (fn, ms) =>
    ms > 10000 ? setTimeout(fn, ms) : nativeTimeout(fn, ms);
  await f.w.streamMedia(
    { id: "sample-task" },
    "https://muse.ai/original.png",
    "new-response",
  );
  const chunks = f.events.filter((e) => e.type === "bridge:media-chunk");
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].offset, 0);
  assert.equal(chunks[1].offset, 128 * 1024);
  assert.deepEqual(
    Buffer.concat(chunks.map((e) => Buffer.from(e.data, "base64"))),
    Buffer.from(bytes),
  );
  assert.equal(f.events.at(-1).bytes, 300000);
  assert.equal(f.events.at(-1).turnId, "new-response");
});

test("background dispatch uses exact tab/session, refuses duplicates, and never opens/focuses Chrome", async () => {
  const messages = [],
    storage = {
      serverUrl: "http://127.0.0.1:4317",
      token: "fixture-token",
      profileInstanceId: "profile-00001",
      displayName: "fixture",
    },
    listeners = [];
  const forbidden = () => {
    throw new Error("Forbidden Chrome mutation was called.");
  };
  const chrome = {
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...storage }),
        set: async (value) => Object.assign(storage, value),
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      getManifest: () => ({ version: "0.5.0" }),
    },
    action: { setBadgeText() {} },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, url: "https://muse.ai/chat/test" }),
      sendMessage: async (id, msg) => {
        messages.push({ id, msg });
        return msg.type === "bridge:probe"
          ? {
              documentSessionId: "document-0001",
              ready: true,
              supported: ["text"],
            }
          : { ok: true };
      },
      create: forbidden,
      update: forbidden,
      remove: forbidden,
      reload: forbidden,
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    windows: { update: forbidden, create: forbidden },
  };
  const wires = [];
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
    }
    send(raw) {
      wires.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
    }
  }
  const context = vm.createContext({
    chrome,
    WebSocket: Socket,
    URL,
    crypto: { randomUUID },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });
  vm.runInContext(background, context);
  await until(
    () =>
      storage.profileInstanceId && vm.runInContext("socket !== null", context),
  );
  const run = {
    type: "bridge:run",
    id: "task-00001",
    profileInstanceId: storage.profileInstanceId,
    tabId: 17,
    documentSessionId: "document-0001",
    expectedUrl: "https://muse.ai/chat/test",
    kind: "text",
    prompt: "test",
    dispatchToken: "nonce",
  };
  await vm.runInContext(`handleServer(${JSON.stringify(run)})`, context);
  assert.equal(messages.filter((e) => e.msg.type === "bridge:run").length, 1);
  assert.equal(messages.at(-1).id, 17);
  await vm.runInContext(`handleServer(${JSON.stringify(run)})`, context);
  assert.equal(messages.filter((e) => e.msg.type === "bridge:run").length, 1);
  await vm.runInContext(
    `handleServer(${JSON.stringify({ ...run, id: "task-00002", documentSessionId: "wrong-document" })})`,
    context,
  );
  assert.equal(messages.filter((e) => e.msg.type === "bridge:run").length, 1);
  assert.ok(wires.some((e) => e.type === "bridge:error"));
  assert.ok(storage.dispatchedTaskIds.includes(run.id));
  const upload = vm.runInContext(
    `fromContent(${JSON.stringify({ id: run.id, type: "bridge:media-start", turnId: "upload-turn", original: true, documentSessionId: run.documentSessionId })},${JSON.stringify({ tab: { id: run.tabId, url: run.expectedUrl } })})`,
    context,
  );
  const rejected = assert.rejects(upload, /Connection lost/);
  vm.runInContext("socket.onclose(); clearTimeout(reconnect);", context);
  await rejected;
  assert.equal(vm.runInContext("acknowledgements.size", context), 0);
});
