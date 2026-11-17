import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { WebSocket } from "ws";
import { once } from "node:events";
import { createBridge } from "../lib/server.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error("Control Center fixture timed out.");
}

test("Control Center authenticates, grants a tab, sets a default, and sends a durable task through real HTTP", async (c) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-control-"));
  const bridge = createBridge({
      directory,
      apiKey: "api-fixture",
      bridgeToken: "extension-fixture",
    }),
    base = await bridge.listen(0);
  const socket = new WebSocket(
    base.replace("http:", "ws:") + "/bridge?token=extension-fixture",
  );
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "bridge:hello",
      protocol: 2,
      profileInstanceId: "profile-control",
      displayName: "<img src=x onerror=alert(1)>",
      tabs: [
        {
          tabId: 3,
          documentSessionId: "document-control",
          url: "https://muse.ai/chat/test",
          ready: true,
          supported: ["text"],
        },
      ],
    }),
  );
  await until(() => bridge.state.clients.size === 1);
  const html = fs.readFileSync(
    new URL("../control/index.html", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, { url: base, runScripts: "outside-only" }),
    w = dom.window;
  w.fetch = (url, options) => fetch(new URL(url, base), options);
  w.eval(
    fs.readFileSync(new URL("../control/control.js", import.meta.url), "utf8"),
  );
  c.after(async () => {
    dom.window.close();
    await bridge.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const $ = (id) => w.document.getElementById(id);
  $("key").value = "wrong";
  $("auth").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => $("notice").textContent.includes("Valid API key"));
  $("key").value = "api-fixture";
  $("auth").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => $("profiles").querySelector("strong"));
  assert.equal($("workspace").hidden, false);
  assert.equal($("profiles").querySelector("img"), null);
  assert.match($("profiles").textContent, /<img/);
  const checkbox = $("tabs").querySelector("input[type=checkbox]");
  checkbox.checked = true;
  checkbox.dispatchEvent(new w.Event("change"));
  await until(() => $("target").options.length === 1);
  $("setDefault").click();
  await until(() => $("notice").textContent.includes("Đã lưu đích mặc định"));
  $("prompt").value = "dashboard fixture prompt";
  $("task").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => Object.values(bridge.state.data.tasks).length === 1);
  await until(
    () =>
      !$("task").querySelector("button:not([type])").disabled &&
      $("tasks").children.length === 1,
  );
  const task = Object.values(bridge.state.data.tasks)[0];
  assert.equal(task.tabId, 3);
  assert.equal(task.profileInstanceId, "profile-control");
  assert.equal(task.status, "DISPATCHED");
  assert.equal(task.prompt, "dashboard fixture prompt");
  assert.ok(task.idempotencyKey);
  assert.equal($("key").value, "");
});
