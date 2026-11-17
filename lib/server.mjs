import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { BridgeState, TERMINAL, PROVIDERS, problem } from "./state.mjs";
import { MediaEngine, fileChecksum } from "./media.mjs";
import {
  buildPromptWithInstructions,
  DEFAULT_PROMPT_INSTRUCTION_SETTINGS,
} from "../prompt-instructions.mjs";
import { makeAssistantMessage } from "../tool-calls.mjs";
import {
  formatPrompt,
  providerForModel,
  isConversationTitleRequest,
  makeConversationTitle,
} from "./chat.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, data) => {
  if (!res.destroyed && !res.writableEnded) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
};
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024)
      throw problem("body_limit", "Request body exceeds 1 MiB.", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    throw problem("invalid_json", "JSON object required.");
  }
}
const terminalWait = (state, task, res, ms) =>
  new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      state.off("task", onTask);
      res.off("close", onClose);
      resolve(value);
    };
    const onTask = (t) => {
      if (t.id === task.id && TERMINAL.has(t.status)) done(t);
    };
    const onClose = () => done(null);
    const timer = setTimeout(() => done(null), ms);
    state.on("task", onTask);
    res.once("close", onClose);
    if (TERMINAL.has(task.status)) done(task);
  });

export function createBridge({
  directory,
  apiKey,
  bridgeToken,
  allowedOrigins = [],
  timeoutMs,
  waitMs = 60_000,
  settings = {},
  promptRoot = path.join(root, "prompt-instructions"),
  maxMediaBytes,
} = {}) {
  if (!apiKey || !bridgeToken)
    throw new Error("Separate API and extension credentials are required.");
  const state = new BridgeState(directory, { timeoutMs });
  const media = new MediaEngine(state, { maxBytes: maxMediaBytes });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 300_000,
    perMessageDeflate: false,
  });
  let origin,
    closing = false,
    closePromise;
  function checkRequest(req, extension = false) {
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      )
    )
      throw problem("loopback_required", "Loopback connection required.", 403);
    if (
      ![
        `127.0.0.1:${server.address()?.port}`,
        `localhost:${server.address()?.port}`,
      ].includes(req.headers.host)
    )
      throw problem("invalid_host", "Unexpected Host header.", 403);
    const source = req.headers.origin;
    if (
      source &&
      source !== origin &&
      !allowedOrigins.includes(source) &&
      !(extension && /^chrome-extension:\/\/[a-p]{32}$/.test(source))
    )
      throw problem("origin_denied", "Origin is not allowed.", 403);
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (closing)
        throw problem("shutting_down", "Bridge is shutting down.", 503);
      checkRequest(req);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      if (req.headers.origin) {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, Idempotency-Key, Prefer",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        });
        return res.end();
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (
        req.method === "GET" &&
        ["/", "/control.js", "/control.css"].includes(url.pathname)
      ) {
        const file = {
          "/": "index.html",
          "/control.js": "control.js",
          "/control.css": "control.css",
        }[url.pathname];
        res.writeHead(200, {
          "Content-Type": file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
          "Cache-Control": "no-store",
        });
        return res.end(fs.readFileSync(path.join(root, "control", file)));
      }
      if (req.method === "GET" && url.pathname === "/health")
        return json(res, 200, { ok: true, version: "0.5.0" });
      if (!equal(req.headers.authorization, `Bearer ${apiKey}`))
        throw problem("invalid_api_key", "Valid API key required.", 401);
      if (req.method === "GET" && url.pathname === "/v1/models")
        return json(res, 200, {
          object: "list",
          data: ["auto", ...Object.keys(PROVIDERS)].map((p) => ({
            id: `bridge-${p}`,
            object: "model",
            owned_by: "ai-bridge",
            created: 0,
          })),
        });
      if (req.method === "GET" && url.pathname === "/api/bridge/health")
        return json(res, 200, {
          ok: true,
          profiles: state.clients.size,
          active: Object.values(state.data.tasks).filter(
            (t) => !TERMINAL.has(t.status),
          ).length,
          protocol: 2,
        });
      if (req.method === "GET" && url.pathname === "/api/bridge/profiles")
        return json(
          res,
          200,
          Object.values(state.data.profiles).map((profile) => {
            const tabs = Object.values(state.data.tabs).filter(
              (tab) =>
                tab.profileInstanceId === profile.profileInstanceId &&
                tab.online,
            );
            return {
              ...profile,
              availableProviders: [...new Set(tabs.map((tab) => tab.provider))],
              selectedTabs: tabs
                .filter((tab) => tab.enabled.length)
                .map((tab) => ({
                  tabId: tab.tabId,
                  documentSessionId: tab.documentSessionId,
                })),
            };
          }),
        );
      if (
        req.method === "GET" &&
        ["/api/bridge/tabs", "/api/bridge/capabilities"].includes(url.pathname)
      )
        return json(
          res,
          200,
          Object.values(state.data.tabs).map((t) => ({
            ...t,
            busy: state.busy(t),
          })),
        );
      if (req.method === "GET" && url.pathname === "/api/bridge/media")
        return json(res, 200, Object.values(state.data.media));
      const verifyMatch = url.pathname.match(
        /^\/api\/bridge\/media\/([a-f0-9-]+)\/verify$/,
      );
      if (req.method === "POST" && verifyMatch) {
        const item = state.data.media[verifyMatch[1]];
        if (!item) throw problem("media_not_found", "Media not found.", 404);
        const checksum = await fileChecksum(
          path.join(media.directory, item.filename),
        );
        return json(res, checksum === item.sha256 ? 200 : 409, {
          ok: checksum === item.sha256,
          sha256: checksum,
          expected: item.sha256,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/bridge/defaults")
        return json(res, 200, state.data.defaults);
      if (req.method === "PATCH" && url.pathname === "/api/bridge/defaults") {
        const input = await body(req);
        for (const [kind, target] of Object.entries(input)) {
          if (!["text", "image", "video"].includes(kind))
            throw problem("invalid_kind", "Unknown default kind.");
          if (target === null) {
            delete state.data.defaults[kind];
            continue;
          }
          state.checkTarget(
            state.data.tabs[`${target.profileInstanceId}:${target.tabId}`],
            target,
            kind,
          );
          state.data.defaults[kind] = {
            profileInstanceId: target.profileInstanceId,
            tabId: target.tabId,
            documentSessionId: target.documentSessionId,
          };
        }
        state.save();
        return json(res, 200, state.data.defaults);
      }
      let match;
      if (
        req.method === "PATCH" &&
        (match = url.pathname.match(
          /^\/api\/bridge\/profiles\/([a-zA-Z0-9_-]+)$/,
        ))
      ) {
        const profile = state.data.profiles[match[1]];
        if (!profile)
          throw problem("profile_not_found", "Profile not found.", 404);
        const input = await body(req);
        if (typeof input.displayName === "string" && input.displayName.trim())
          profile.displayName = input.displayName.trim().slice(0, 80);
        if (typeof input.enabled === "boolean") profile.enabled = input.enabled;
        if (input.disconnect === true)
          state.clients
            .get(profile.profileInstanceId)
            ?.close(1000, "User disconnected");
        state.save();
        state.pump();
        return json(res, 200, profile);
      }
      if (
        req.method === "PATCH" &&
        (match = url.pathname.match(
          /^\/api\/bridge\/tabs\/([a-zA-Z0-9_-]+)\/(\d+)$/,
        ))
      )
        return json(
          res,
          200,
          state.configureTab(match[1], Number(match[2]), await body(req)),
        );
      if (req.method === "GET" && url.pathname === "/api/bridge/tasks")
        return json(
          res,
          200,
          Object.values(state.data.tasks).map((t) => state.publicTask(t)),
        );
      if (
        req.method === "GET" &&
        (match = url.pathname.match(
          /^\/(?:api\/bridge|v1\/video)\/tasks\/([a-f0-9-]+)$/,
        ))
      )
        return json(res, 200, state.publicTask(state.getTask(match[1])));
      if (
        req.method === "POST" &&
        (match = url.pathname.match(
          /^\/api\/bridge\/tasks\/([a-f0-9-]+)\/cancel$/,
        ))
      )
        return json(res, 200, state.publicTask(state.cancel(match[1])));
      if (
        req.method === "GET" &&
        (match = url.pathname.match(/^\/v1\/media\/([a-f0-9-]+)$/))
      ) {
        const item = state.data.media[match[1]];
        if (!item) throw problem("media_not_found", "Media not found.", 404);
        const file = path.join(media.directory, item.filename),
          stat = fs.statSync(file);
        if (stat.size !== item.bytes)
          throw problem("media_modified", "Stored media size changed.", 409);
        if ((await fileChecksum(file)) !== item.sha256)
          throw problem(
            "media_modified",
            "Stored media checksum changed.",
            409,
          );
        let start = 0,
          end = stat.size - 1,
          status = 200;
        if (req.headers.range) {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          if (!range)
            throw problem(
              "invalid_range",
              "Single explicit byte range required.",
              416,
            );
          start = Number(range[1]);
          end = range[2] ? Math.min(Number(range[2]), end) : end;
          if (start > end || start >= stat.size)
            throw problem("invalid_range", "Range is outside media.", 416);
          status = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        }
        res.writeHead(status, {
          "Content-Type": item.mime,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="${item.filename}"`,
        });
        const stream = fs.createReadStream(file, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
      if (
        req.method === "POST" &&
        [
          "/api/bridge/tasks",
          "/v1/video/tasks",
          "/v1/images/generations",
          "/v1/chat/completions",
        ].includes(url.pathname)
      ) {
        const input = await body(req);
        let kind =
          url.pathname === "/v1/video/tasks"
            ? "video"
            : url.pathname === "/v1/images/generations"
              ? "image"
              : url.pathname === "/api/bridge/tasks"
                ? input.kind
                : "text";
        if (
          input.tools !== undefined &&
          (!Array.isArray(input.tools) || input.tools.length > 100)
        )
          throw problem(
            "invalid_tools",
            "tools must be an array of at most 100 entries.",
          );
        if (kind === "image" && input.n !== undefined && input.n !== 1)
          throw problem(
            "unsupported_batch",
            "Only n=1 is supported; no synthetic batch results.",
            422,
          );
        if (
          kind === "image" &&
          input.response_format &&
          input.response_format !== "url"
        )
          throw problem(
            "unsupported_format",
            "Only authenticated local media URLs are supported.",
            422,
          );
        if (
          kind !== "text" &&
          (input.quality ||
            (input.size && input.size !== "auto") ||
            input.duration)
        )
          throw problem(
            "website_controlled_options",
            "Select quality, size and duration in the existing website tab; this adapter does not claim to change them.",
            422,
          );
        if (
          input.image ||
          input.images ||
          input.first_frame ||
          input.last_frame
        )
          throw problem(
            "references_unverified",
            "Reference upload/editing is not yet verified by this DOM adapter.",
            422,
          );
        let prompt = input.prompt;
        if (url.pathname === "/v1/chat/completions") {
          if (
            !Array.isArray(input.messages) ||
            !input.messages.length ||
            input.messages.some((m) => !m || typeof m !== "object")
          )
            throw problem(
              "invalid_messages",
              "messages must be a nonempty array.",
            );
          if (input.stream !== undefined && typeof input.stream !== "boolean")
            throw problem("invalid_stream", "stream must be boolean.");
          if (input.messages.some((m) => typeof m.content !== "string"))
            throw problem(
              "unsupported_content",
              "This adapter currently accepts text message content only.",
              422,
            );
          const selected = providerForModel(input.model);
          if (input.model && input.model !== "bridge-auto" && !selected)
            throw problem("invalid_model", "Unsupported bridge model.", 422);
          prompt = formatPrompt(input.messages, input.tools);
          const s = { ...DEFAULT_PROMPT_INSTRUCTION_SETTINGS, ...settings };
          if (
            process.env.BRIDGE_INTERCEPT_TITLES !== "0" &&
            settings.interceptTitleRequests !== false &&
            isConversationTitleRequest(input.messages)
          ) {
            const text = makeConversationTitle(input.messages),
              task = {
                id: crypto.randomUUID(),
                model: input.model || "bridge-auto",
              };
            if (input.stream) {
              startSse(res);
              sse(res, chunk(task, { role: "assistant", content: text }));
              sse(res, chunk(task, {}, "stop"));
              sse(res, "[DONE]");
              return res.end();
            }
            return json(
              res,
              200,
              completion(task, { role: "assistant", content: text }),
            );
          }
          prompt = buildPromptWithInstructions(
            prompt,
            input.messages,
            selected,
            {
              everyMessage: s.injectPromptInstructionsEveryMessage,
              prePromptName: s.prePrompt,
              postPromptName: s.postPrompt,
              rootDirectory: promptRoot,
              disguiseModelNameAsAssistant: s.disguiseModelNameAsAssistant,
            },
          );
        }
        const provider =
          input.provider ||
          (kind === "text" ? providerForModel(input.model) : null);
        const task = state.create(
          kind,
          {
            prompt,
            target: input.target,
            provider,
            model: input.model,
            tools: input.tools,
          },
          req.headers["idempotency-key"],
        );
        if (
          url.pathname === "/api/bridge/tasks" ||
          kind === "video" ||
          req.headers.prefer === "respond-async"
        )
          return json(res, 202, state.publicTask(task));
        if (kind === "text" && input.stream) {
          startSse(res);
          sse(res, chunk(task, { role: "assistant" }));
          const onChunk = (t, text) => {
            if (t.id === task.id && !task.tools.length)
              sse(res, chunk(task, { content: text }));
          };
          state.on("chunk", onChunk);
          const result = await terminalWait(
            state,
            task,
            res,
            state.timeoutMs + 1000,
          );
          state.off("chunk", onChunk);
          if (!result || res.destroyed) {
            if (!res.destroyed) {
              sse(res, {
                error: { code: "task_still_running", task_id: task.id },
              });
              sse(res, "[DONE]");
              res.end();
            }
            return;
          }
          if (result.status === "COMPLETED") {
            const message = makeAssistantMessage(result.text, result.tools);
            if (message.tool_calls)
              sse(
                res,
                chunk(task, {
                  tool_calls: message.tool_calls.map((t, index) => ({
                    ...t,
                    index,
                  })),
                }),
              );
            else if (task.tools.length)
              sse(res, chunk(task, { content: message.content }));
            sse(
              res,
              chunk(task, {}, message.tool_calls ? "tool_calls" : "stop"),
            );
          } else
            sse(res, {
              error: {
                code: result.status.toLowerCase(),
                message: result.error,
                task_id: task.id,
              },
            });
          sse(res, "[DONE]");
          return res.end();
        }
        const result = await terminalWait(
          state,
          task,
          res,
          Math.min(waitMs, state.timeoutMs + 1000),
        );
        if (!result) return json(res, 202, state.publicTask(task));
        if (result.status !== "COMPLETED")
          throw problem(
            result.status.toLowerCase(),
            `${result.error || result.status} (task ${result.id})`,
            502,
          );
        if (kind === "text")
          return json(
            res,
            200,
            completion(task, makeAssistantMessage(task.text, task.tools)),
          );
        return json(res, 200, {
          created: Math.floor(Date.now() / 1000),
          task_id: task.id,
          data: task.media.map((id) => ({
            url: `${origin}/v1/media/${id}`,
            file_id: id,
            ...state.data.media[id],
          })),
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/images/edits")
        throw problem(
          "editing_unverified",
          "Image editing requires a verified reference-upload adapter.",
          501,
        );
      throw problem("not_found", "Route not found.", 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, error.status || 500, {
        error: {
          code: error.code || "internal_error",
          message: error.status
            ? error.message
            : "Internal operation failed; check local diagnostics.",
        },
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on("upgrade", (req, socket, head) => {
    try {
      checkRequest(req, true);
      const url = new URL(req.url, "http://127.0.0.1");
      if (
        url.pathname !== "/bridge" ||
        !equal(url.searchParams.get("token"), bridgeToken)
      )
        throw problem("invalid_bridge_token", "Invalid pairing token.", 401);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req),
      );
    } catch (e) {
      socket.end(
        `HTTP/1.1 ${e.status || 400} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
  });
  wss.on("connection", (socket) => {
    socket.lastSeen = Date.now();
    let chain = Promise.resolve();
    socket.on("message", (bytes, isBinary) => {
      chain = chain
        .then(async () => {
          let msg;
          try {
            if (closing) return;
            if (isBinary)
              throw problem("invalid_protocol", "JSON protocol required.");
            msg = JSON.parse(bytes.toString());
            socket.lastSeen = Date.now();
            if (msg.type === "bridge:hello") {
              state.register(socket, msg);
              socket.send(
                JSON.stringify({
                  type: "bridge:registered",
                  profileInstanceId: socket.profileInstanceId,
                }),
              );
            } else if (
              !socket.profileInstanceId ||
              state.clients.get(socket.profileInstanceId) !== socket
            )
              throw problem(
                "hello_required",
                "Register a Profile before sending events.",
              );
            else if (msg.type === "bridge:inventory")
              state.inventory(socket.profileInstanceId, msg.tabs);
            else if (msg.type === "bridge:ping")
              socket.send(JSON.stringify({ type: "bridge:pong" }));
            else if (msg.type?.startsWith("bridge:media-"))
              socket.send(JSON.stringify(await media.handle(socket, msg)));
            else state.event(socket, msg);
          } catch (e) {
            if (msg?.id && media.uploads.has(msg.id)) {
              try {
                const task = state.match(socket, msg);
                media.abort(task.id);
                state.unknown(
                  task,
                  "Media rejected: " + (e.code || "validation_failed"),
                );
              } catch {
                /* untrusted event cannot cancel another task */
              }
            }
            if (socket.readyState === 1)
              socket.send(
                JSON.stringify({
                  type: "bridge:protocol-error",
                  requestId: msg?.requestId,
                  code: e.code || "media_validation_failed",
                  message: e.status
                    ? e.message
                    : "Media validation or protocol operation failed.",
                }),
              );
          }
        })
        .catch(() => socket.close(1011, "Protocol operation failed"));
    });
    socket.on("close", () => {
      if (!closing) state.disconnect(socket);
    });
    socket.on("error", () => {});
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients)
      if (Date.now() - socket.lastSeen > 65_000) socket.terminate();
  }, 20_000);
  heartbeat.unref();
  return {
    server,
    state,
    media,
    async listen(port = 4317) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        clearInterval(heartbeat);
        state.close();
        media.close();
        const socketsClosed = new Promise((resolve) => wss.close(resolve));
        for (const socket of wss.clients) socket.terminate();
        await socketsClosed;
        if (server.listening)
          await new Promise((resolve) => server.close(resolve));
      })();
      return closePromise;
    },
  };
}
function startSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}
function sse(res, value) {
  if (!res.destroyed)
    res.write(
      `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
    );
}
function chunk(t, delta, finish_reason = null) {
  return {
    id: `chatcmpl-${t.id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: t.model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}
function completion(t, message) {
  return {
    id: `chatcmpl-${t.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: t.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
      },
    ],
  };
}
