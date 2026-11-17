import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";
import { createBridge } from "../lib/server.mjs";
import { validateMedia } from "../lib/media.mjs";

const API_KEY = "test-api-credential-not-a-real-secret",
  TOKEN = "test-extension-credential-not-a-real-secret";
const profileA = "profile_A_0001",
  profileB = "profile_B_0002",
  docA = "document_A_001",
  docB = "document_B_002";
const tab = (tabId = 7, documentSessionId = docA) => ({
  tabId,
  documentSessionId,
  url: "https://muse.ai/chat/test",
  ready: true,
  supported: ["text", "image", "video"],
});
const target = (
  profileInstanceId = profileA,
  tabId = 7,
  documentSessionId = docA,
) => ({ profileInstanceId, tabId, documentSessionId });
const png = (width, height) =>
  execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${width}x${height}:rate=1`,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "-",
  ]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await delay(10);
  }
  throw new Error("Condition was not reached.");
}
async function fixture(context, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-v2-"));
  const bridge = createBridge({
    directory,
    apiKey: API_KEY,
    bridgeToken: TOKEN,
    timeoutMs: 5000,
    waitMs: 1000,
    settings: { prePrompt: "", postPrompt: "" },
    ...options,
  });
  const base = await bridge.listen(0);
  context.after(async () => {
    await bridge.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = async (route, method = "GET", data, headers = {}) =>
    fetch(base + route, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  async function connect(id = profileA, tabs = [tab()]) {
    const socket = new WebSocket(
      base.replace("http:", "ws:") + "/bridge?token=" + TOKEN,
    );
    const events = [];
    socket.on("message", (bytes) => events.push(JSON.parse(bytes)));
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "bridge:hello",
        protocol: 2,
        profileInstanceId: id,
        displayName: id,
        tabs,
      }),
    );
    await until(() => bridge.state.clients.has(id));
    return {
      socket,
      events,
      send: (msg) => socket.send(JSON.stringify(msg)),
      run: () => events.find((e) => e.type === "bridge:run"),
    };
  }
  async function enable(t = target(), enabled = ["text", "image", "video"]) {
    const r = await request(
      `/api/bridge/tabs/${t.profileInstanceId}/${t.tabId}`,
      "PATCH",
      { documentSessionId: t.documentSessionId, enabled },
    );
    assert.equal(r.status, 200, await r.text());
  }
  async function create(kind = "text", t = target(), key) {
    const r = await request(
      "/api/bridge/tasks",
      "POST",
      { kind, prompt: "fixture prompt", target: t },
      key ? { "Idempotency-Key": key } : {},
    );
    assert.equal(r.status, 202);
    return r.json();
  }
  function event(run, type, extra = {}) {
    return {
      ...run,
      prompt: undefined,
      expectedUrl: undefined,
      kind: undefined,
      type,
      ...extra,
    };
  }
  async function finish(client, run, text = "fixture response") {
    client.send(event(run, "bridge:started"));
    client.send(event(run, "bridge:chunk", { text }));
    client.send(event(run, "bridge:complete", { turnId: "turn-" + run.id }));
    await until(() => bridge.state.data.tasks[run.id].status === "COMPLETED");
  }
  return {
    directory,
    bridge,
    base,
    request,
    connect,
    enable,
    create,
    event,
    finish,
  };
}

test("API authenticates by default, rejects foreign Origin/Host, and keeps pairing credential separate", async (c) => {
  const f = await fixture(c);
  assert.equal((await fetch(f.base + "/health")).status, 200);
  assert.equal((await fetch(f.base + "/v1/models")).status, 401);
  assert.equal(
    (
      await f.request("/v1/models", "GET", undefined, {
        Authorization: "Bearer " + TOKEN,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/v1/models", "GET", undefined, {
        Origin: "https://untrusted.example",
      })
    ).status,
    403,
  );
  const hostStatus = await new Promise((resolve, reject) => {
    http
      .get(
        f.base + "/v1/models",
        {
          headers: {
            Host: "untrusted.example",
            Authorization: `Bearer ${API_KEY}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(hostStatus, 403);
  const models = await f.request("/v1/models");
  assert.equal(models.status, 200);
  assert.equal(models.headers.get("access-control-allow-origin"), null);
  assert.ok((await models.json()).data.some((m) => m.id === "bridge-muse"));
  const preflight = await f.request(
    "/v1/chat/completions",
    "OPTIONS",
    undefined,
    { Origin: "https://untrusted.example" },
  );
  assert.equal(preflight.status, 403);
});

test("WebSocket enforces pairing token and rejects arbitrary website Origins", async (c) => {
  const f = await fixture(c);
  for (const options of [
    { token: "wrong" },
    { token: TOKEN, origin: "https://untrusted.example" },
  ]) {
    const s = new WebSocket(
      f.base.replace("http:", "ws:") + "/bridge?token=" + options.token,
      options.origin ? { origin: options.origin } : {},
    );
    await new Promise((resolve) => {
      s.once("unexpected-response", (_req, res) => {
        assert.ok([401, 403].includes(res.statusCode));
        res.resume();
        s.terminate();
        resolve();
      });
      s.on("error", () => {});
    });
  }
});

test("two Profiles with equal Chrome tab IDs dispatch independently to their exact sessions", async (c) => {
  const f = await fixture(c),
    a = await f.connect(),
    b = await f.connect(profileB, [tab(7, docB)]);
  await f.enable();
  await f.enable(target(profileB, 7, docB));
  const ta = await f.create(),
    tb = await f.create("text", target(profileB, 7, docB));
  const ra = await until(a.run),
    rb = await until(b.run);
  assert.equal(ra.id, ta.id);
  assert.equal(rb.id, tb.id);
  assert.equal(rb.profileInstanceId, profileB);
  assert.equal(rb.documentSessionId, docB);
  await f.finish(a, ra, "A");
  await f.finish(b, rb, "B");
  assert.equal(f.bridge.state.data.tasks[ta.id].text, "A");
  assert.equal(f.bridge.state.data.tasks[tb.id].text, "B");
});

test("same-provider tabs are explicitly selected and a single tab processes only one task", async (c) => {
  const f = await fixture(c),
    a = await f.connect(profileA, [tab(), tab(8, docB)]);
  await f.enable();
  await f.enable(target(profileA, 8, docB));
  const t1 = await f.create(),
    t2 = await f.create(),
    t3 = await f.create("text", target(profileA, 8, docB));
  await until(
    () => a.events.filter((e) => e.type === "bridge:run").length === 2,
  );
  assert.equal(f.bridge.state.getTask(t2.id).status, "QUEUED");
  assert.equal(f.bridge.state.getTask(t3.id).status, "DISPATCHED");
  await f.finish(
    a,
    a.events.find((e) => e.id === t1.id),
  );
  await until(
    () => a.events.filter((e) => e.type === "bridge:run").length === 3,
  );
  assert.equal(f.bridge.state.getTask(t2.id).status, "DISPATCHED");
});

test("reload invalidates consent and rejects old document events without accepting results", async (c) => {
  const f = await fixture(c),
    a = await f.connect();
  await f.enable();
  const task = await f.create(),
    run = await until(a.run);
  a.send({ type: "bridge:inventory", tabs: [tab(7, docB)] });
  await until(() => f.bridge.state.getTask(task.id).status === "UNKNOWN");
  a.send(
    f.event(run, "bridge:complete", { turnId: "stale", text: "not accepted" }),
  );
  await delay(30);
  assert.equal(f.bridge.state.getTask(task.id).status, "UNKNOWN");
  assert.deepEqual(f.bridge.state.data.tabs[profileA + ":7"].enabled, []);
  const stale = await f.request("/api/bridge/tasks", "POST", {
    kind: "text",
    prompt: "test",
    target: target(),
  });
  assert.equal(stale.status, 409);
});

test("wrong socket, tab, dispatch nonce and document cannot complete another task", async (c) => {
  const f = await fixture(c),
    a = await f.connect(),
    b = await f.connect(profileB, [tab(7, docB)]);
  await f.enable();
  const task = await f.create(),
    run = await until(a.run);
  for (const client of [a, b])
    for (const override of [
      { tabId: 99 },
      { documentSessionId: docB },
      { dispatchToken: "wrong" },
    ])
      client.send(
        f.event(run, "bridge:complete", { ...override, turnId: "foreign" }),
      );
  await delay(50);
  assert.equal(f.bridge.state.getTask(task.id).status, "DISPATCHED");
  await f.finish(a, run);
});

test("disconnect produces UNKNOWN, quarantines tab, and never automatically resubmits", async (c) => {
  const f = await fixture(c),
    a = await f.connect();
  await f.enable();
  const task = await f.create("text", target(), "dedupe-disconnect"),
    run = await until(a.run);
  a.send(f.event(run, "bridge:started"));
  await until(() => f.bridge.state.getTask(task.id).status === "RUNNING");
  a.socket.terminate();
  await until(() => f.bridge.state.getTask(task.id).status === "UNKNOWN");
  const reconnected = await f.connect();
  await f.enable();
  const replay = await f.create("text", target(), "dedupe-disconnect");
  assert.equal(replay.id, task.id);
  assert.equal(replay.status, "UNKNOWN");
  await delay(20);
  assert.equal(
    reconnected.events.filter((e) => e.type === "bridge:run").length,
    0,
  );
  assert.equal(f.bridge.state.data.profiles[profileA].online, true);
});

test("idempotency conflicts reject changed requests; duplicate Profile IDs are not silently merged", async (c) => {
  const f = await fixture(c),
    a = await f.connect();
  await f.enable();
  await f.create("text", target(), "same-key");
  const conflict = await f.request(
    "/api/bridge/tasks",
    "POST",
    { kind: "text", prompt: "different", target: target() },
    { "Idempotency-Key": "same-key" },
  );
  assert.equal(conflict.status, 409);
  const s = new WebSocket(
      f.base.replace("http:", "ws:") + "/bridge?token=" + TOKEN,
    ),
    events = [];
  s.on("message", (b) => events.push(JSON.parse(b)));
  await once(s, "open");
  s.send(
    JSON.stringify({
      type: "bridge:hello",
      protocol: 2,
      profileInstanceId: profileA,
      tabs: [tab()],
    }),
  );
  await until(() => events.some((e) => e.code === "profile_collision"));
  assert.equal(f.bridge.state.clients.get(profileA).readyState, 1);
  s.terminate();
  a.socket.terminate();
});

test("queued cancellation is confirmed; active cancellation cannot pretend to cancel the website", async (c) => {
  const f = await fixture(c),
    a = await f.connect();
  await f.enable();
  const active = await f.create(),
    queued = await f.create();
  await until(a.run);
  assert.equal(
    (await f.request(`/api/bridge/tasks/${active.id}/cancel`, "POST", {}))
      .status,
    409,
  );
  const cancelled = await f.request(
    `/api/bridge/tasks/${queued.id}/cancel`,
    "POST",
    {},
  );
  assert.equal((await cancelled.json()).status, "CANCELLED");
});

test("restart persists history and idempotency, but never redispatches an ambiguous task", async (c) => {
  const f = await fixture(c),
    a = await f.connect();
  await f.enable();
  const task = await f.create("text", target(), "restart-key");
  await until(a.run);
  // Restore the last durable DISPATCHED snapshot, as after abrupt process loss.
  const crashSnapshot = fs.readFileSync(path.join(f.directory, "state.json"));
  await f.bridge.close();
  fs.writeFileSync(path.join(f.directory, "state.json"), crashSnapshot);
  const second = createBridge({
    directory: f.directory,
    apiKey: API_KEY,
    bridgeToken: TOKEN,
  });
  await second.listen(0);
  c.after(() => second.close());
  assert.equal(second.state.getTask(task.id).status, "UNKNOWN");
  assert.equal(second.state.data.profiles[profileA].online, false);
  assert.equal(second.state.data.tabs[profileA + ":7"].uncertain, true);
  assert.equal(second.state.getTask(task.id).idempotencyKey, "restart-key");
});

test("async video/media results require ordered bytes and real decoding before completion", async (c) => {
  const f = await fixture(c),
    a = await f.connect();
  await f.enable();
  const r = await f.request("/v1/video/tasks", "POST", {
    prompt: "fixture",
    target: target(),
  });
  assert.equal(r.status, 202);
  const task = await r.json(),
    run = await until(a.run);
  a.send(f.event(run, "bridge:started"));
  a.send(
    f.event(run, "bridge:complete", {
      turnId: "fake-text-result",
      text: "video is ready",
    }),
  );
  await delay(30);
  assert.equal(f.bridge.state.getTask(task.id).status, "RUNNING");
  const file = path.join(f.directory, "fixture.mp4");
  execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x32:d=0.25",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  const bytes = fs.readFileSync(file);
  for (const msg of [
    f.event(run, "bridge:media-start", { turnId: "new-turn", original: true }),
    f.event(run, "bridge:media-chunk", {
      offset: 0,
      data: bytes.toString("base64"),
    }),
    f.event(run, "bridge:media-end", {
      bytes: bytes.length,
      turnId: "new-turn",
    }),
  ])
    a.send(msg);
  await until(
    () => f.bridge.state.getTask(task.id).status === "COMPLETED",
    10000,
  );
  const metadata =
    f.bridge.state.data.media[f.bridge.state.getTask(task.id).media[0]];
  assert.equal(metadata.mime, "video/mp4");
  assert.ok(metadata.duration > 0);
  assert.equal(metadata.sha256.length, 64);
  const download = await f.request("/v1/media/" + metadata.id);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const range = await f.request("/v1/media/" + metadata.id, "GET", undefined, {
    Range: "bytes=0-9",
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);
});

test("fake MIME, signature-only image/video, oversized files and nonsequential chunks are rejected", async (c) => {
  const f = await fixture(c);
  for (const [name, bytes, kind] of [
    ["fake.png", Buffer.from("<html>not image</html>"), "image"],
    ["truncated.png", Buffer.from("89504e470d0a1a0a", "hex"), "image"],
    ["fake.mp4", Buffer.from("000000186674797069736f6d", "hex"), "video"],
  ]) {
    const file = path.join(f.directory, name);
    fs.writeFileSync(file, bytes);
    await assert.rejects(validateMedia(file, kind));
  }
  const good = path.join(f.directory, "good.png");
  fs.writeFileSync(good, png(4, 3));
  assert.equal((await validateMedia(good, "image")).width, 4);
  await assert.rejects(validateMedia(good, "image", 1));
  const a = await f.connect();
  await f.enable();
  const task = await f.create("image"),
    run = await until(a.run);
  a.send(f.event(run, "bridge:started"));
  a.send(
    f.event(run, "bridge:media-start", { turnId: "turn", original: true }),
  );
  a.send(f.event(run, "bridge:media-chunk", { offset: 100, data: "eA==" }));
  await until(() => f.bridge.state.getTask(task.id).status === "UNKNOWN");
  assert.deepEqual(f.bridge.state.getTask(task.id).media, []);
});

test("OpenAI text JSON, SSE and tool-call conversion use the chosen tab; verified flags follow results", async (c) => {
  const f = await fixture(c),
    a = await f.connect();
  await f.enable();
  a.socket.on("message", async (bytes) => {
    const run = JSON.parse(bytes);
    if (run.type === "bridge:run")
      await f.finish(
        a,
        run,
        run.prompt.includes("AVAILABLE TOOLS")
          ? '{"name":"Bash","arguments":{"command":"pwd"}}'
          : "A real protocol fixture response",
      );
  });
  const input = {
    model: "bridge-muse",
    target: target(),
    messages: [{ role: "user", content: "hello" }],
  };
  const plain = await f.request("/v1/chat/completions", "POST", input);
  assert.equal(plain.status, 200);
  assert.equal(
    (await plain.json()).choices[0].message.content,
    "A real protocol fixture response",
  );
  const stream = await f.request("/v1/chat/completions", "POST", {
    ...input,
    stream: true,
    tools: [
      {
        type: "function",
        function: { name: "Bash", parameters: { type: "object" } },
      },
    ],
  });
  assert.equal(stream.status, 200);
  const events = await stream.text();
  assert.match(events, /"tool_calls"/);
  assert.match(events, /data: \[DONE\]/);
  assert.doesNotMatch(events, /"content":"\{/);
  assert.ok(f.bridge.state.data.tabs[profileA + ":7"].verified.text.taskId);
});

test("image API returns a validated stored file; unsupported batch/reference/editing is explicit", async (c) => {
  const f = await fixture(c),
    a = await f.connect();
  await f.enable();
  const bytes = png(3, 2);
  a.socket.on("message", (data) => {
    const run = JSON.parse(data);
    if (run.type !== "bridge:run") return;
    for (const msg of [
      f.event(run, "bridge:started"),
      f.event(run, "bridge:media-start", {
        turnId: "image-turn",
        original: true,
      }),
      f.event(run, "bridge:media-chunk", {
        offset: 0,
        data: bytes.toString("base64"),
      }),
      f.event(run, "bridge:media-end", {
        turnId: "image-turn",
        bytes: bytes.length,
      }),
    ])
      a.send(msg);
  });
  const result = await f.request("/v1/images/generations", "POST", {
    prompt: "test image",
    target: target(),
  });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.data[0].mime, "image/png");
  assert.ok(body.data[0].url.startsWith(f.base + "/v1/media/"));
  assert.equal(
    (
      await f.request("/v1/images/generations", "POST", {
        prompt: "x",
        target: target(),
        n: 2,
      })
    ).status,
    422,
  );
  assert.equal((await f.request("/v1/images/edits", "POST", {})).status, 501);
  const stored = body.data[0],
    file = path.join(f.bridge.media.directory, stored.filename),
    original = fs.readFileSync(file);
  original[original.length - 1] ^= 1;
  fs.writeFileSync(file, original);
  assert.equal((await f.request("/v1/media/" + stored.id)).status, 409);
  assert.equal(
    (await f.request("/api/bridge/media/" + stored.id + "/verify", "POST", {}))
      .status,
    409,
  );
});

test("deadline creates UNKNOWN and a previously used response turn cannot complete a new task", async (c) => {
  const f = await fixture(c, { timeoutMs: 100 }),
    a = await f.connect();
  await f.enable();
  const one = await f.create(),
    run = await until(a.run);
  await f.finish(a, run);
  const two = await f.create();
  const next = await until(() => a.events.find((e) => e.id === two.id));
  a.send(f.event(next, "bridge:started"));
  a.send(f.event(next, "bridge:chunk", { text: "stale answer" }));
  a.send(f.event(next, "bridge:complete", { turnId: "turn-" + run.id }));
  await until(() => a.events.some((e) => e.code === "reused_turn"));
  assert.notEqual(f.bridge.state.getTask(two.id).status, "COMPLETED");
  await until(() => f.bridge.state.getTask(two.id).status === "UNKNOWN");
  assert.equal(f.bridge.state.getTask(one.id).status, "COMPLETED");
});

test("data-directory lock rejects a second server instead of allowing duplicate dispatch", async (c) => {
  const f = await fixture(c);
  assert.throws(
    () =>
      createBridge({
        directory: f.directory,
        apiKey: API_KEY,
        bridgeToken: TOKEN,
      }),
    /Another Bridge instance/,
  );
});

test("CLI persists credentials without writing their values to logs and serves the Control Center", async (c) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-cli-"));
  c.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const f = await fixture(c),
    port = f.bridge.server.address().port;
  await f.bridge.close();
  const child = spawn(
    process.execPath,
    [
      "local-server.mjs",
      "--port",
      String(port),
      "--data-dir",
      folder,
      "--token-file",
      path.join(folder, "pairing"),
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  c.after(() => child.kill());
  await until(() => output.includes("Credentials are never printed"), 3000);
  const api = fs.readFileSync(path.join(folder, "api-key"), "utf8").trim(),
    pairing = fs.readFileSync(path.join(folder, "pairing"), "utf8").trim();
  assert.notEqual(api, pairing);
  assert.ok(!output.includes(api));
  assert.ok(!output.includes(pairing));
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Control Center/);
  child.kill();
  await once(child, "exit");
});
