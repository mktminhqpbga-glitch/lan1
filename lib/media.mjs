import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { problem, TERMINAL } from "./state.mjs";

const exec = promisify(execFile);
export async function fileChecksum(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function validateMedia(file, kind, maxBytes = 256 * 1024 * 1024) {
  const size = fs.statSync(file).size;
  if (!size || size > maxBytes)
    throw problem("invalid_media_size", "Empty or oversized media file.", 422);
  const fd = fs.openSync(file, "r"),
    head = Buffer.alloc(16);
  let n;
  try {
    n = fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  let format, mime, metadata;
  if (kind === "image") {
    // Check magic AND decode pixels. Never trust an extension or Content-Type.
    const hex = head.subarray(0, n).toString("hex");
    const expected = hex.startsWith("89504e470d0a1a0a")
      ? "png"
      : hex.startsWith("ffd8ff")
        ? "mjpeg"
        : ["GIF87a", "GIF89a"].includes(head.toString("ascii", 0, 6))
          ? "gif"
          : head.toString("ascii", 0, 4) === "RIFF" &&
              head.toString("ascii", 8, 12) === "WEBP"
            ? "webp"
            : head.toString("ascii", 4, 8) === "ftyp" &&
                ["avif", "avis"].includes(head.toString("ascii", 8, 12))
              ? "av1"
              : null;
    if (!expected)
      throw problem(
        "unsupported_media",
        "PNG, JPEG, GIF, WebP or AVIF image required.",
        422,
      );
    const result = await exec(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", file],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const stream = JSON.parse(result.stdout).streams?.find(
      (s) => s.codec_type === "video",
    );
    if (
      !stream ||
      stream.codec_name !== expected ||
      !stream.width ||
      !stream.height ||
      stream.width * stream.height > 40_000_000
    )
      throw problem(
        "invalid_image",
        "Image codec/dimensions are invalid or exceed 40 megapixels.",
        422,
      );
    await exec(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-f",
        "null",
        "-",
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    format = { mjpeg: "jpg", av1: "avif" }[expected] || expected;
    mime = `image/${format === "jpg" ? "jpeg" : format}`;
    metadata = { width: stream.width, height: stream.height, format };
  } else if (kind === "video") {
    const mp4 = n >= 12 && head.toString("ascii", 4, 8) === "ftyp";
    const webm =
      n >= 4 &&
      head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!mp4 && !webm)
      throw problem("invalid_video", "MP4 or WebM container required.", 422);
    const result = await exec(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const probe = JSON.parse(result.stdout),
      stream = probe.streams?.find((s) => s.codec_type === "video");
    const duration = Number(probe.format?.duration || stream?.duration);
    if (
      !stream?.codec_name ||
      !stream.width ||
      !stream.height ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 3600 ||
      stream.width * stream.height > 40_000_000
    )
      throw problem(
        "invalid_video",
        "Video requires a real codec, dimensions and finite duration up to one hour.",
        422,
      );
    await exec(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-f",
        "null",
        "-",
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    format = mp4 ? "mp4" : "webm";
    mime = `video/${format}`;
    metadata = {
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      duration,
    };
  } else
    throw problem("invalid_kind", "Media task must be image or video.", 422);
  return {
    bytes: size,
    mime,
    extension: format,
    sha256: await fileChecksum(file),
    ...metadata,
  };
}

export class MediaEngine {
  constructor(state, { maxBytes = 256 * 1024 * 1024 } = {}) {
    this.state = state;
    this.maxBytes = maxBytes;
    this.uploads = new Map();
    this.validating = 0;
    this.validationWaiters = [];
    this.directory = path.join(state.directory, "media");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(this.directory))
      if (/^upload-[a-f0-9-]+\.part$/.test(name))
        fs.unlinkSync(path.join(this.directory, name));
    this.listener = (t) => {
      if (TERMINAL.has(t.status)) this.abort(t.id);
    };
    state.on("task", this.listener);
  }
  abort(id) {
    const u = this.uploads.get(id);
    if (!u) return;
    if (u.fd !== null) {
      fs.closeSync(u.fd);
      u.fd = null;
    }
    fs.rmSync(u.file, { force: true });
    this.uploads.delete(id);
  }
  async handle(socket, msg) {
    const task = this.state.match(socket, msg);
    if (!["image", "video"].includes(task.kind) || task.status !== "RUNNING")
      throw problem(
        "invalid_media_task",
        "Media can only be attached to its active running task.",
        409,
      );
    if (msg.type === "bridge:media-start") {
      this.state.checkTurn(task, msg.turnId);
      if (
        this.uploads.has(task.id) ||
        typeof msg.turnId !== "string" ||
        !msg.turnId ||
        msg.turnId.length > 100 ||
        msg.original !== true
      )
        throw problem(
          "invalid_provenance",
          "A unique new response turn and original file source are required.",
          422,
        );
      const file = path.join(this.directory, `upload-${task.id}.part`);
      this.uploads.set(task.id, {
        file,
        fd: fs.openSync(file, "wx", 0o600),
        offset: 0,
        turnId: msg.turnId,
      });
    } else if (msg.type === "bridge:media-chunk") {
      const u = this.uploads.get(task.id);
      if (
        !u ||
        msg.offset !== u.offset ||
        typeof msg.data !== "string" ||
        msg.data.length > 262144 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          msg.data,
        )
      )
        throw problem(
          "invalid_chunk",
          "Missing upload, invalid base64 or nonsequential offset.",
          422,
        );
      const bytes = Buffer.from(msg.data, "base64");
      if (!bytes.length || u.offset + bytes.length > this.maxBytes)
        throw problem(
          "media_limit",
          "Media exceeds configured size limit.",
          413,
        );
      let written = 0;
      while (written < bytes.length)
        written += fs.writeSync(u.fd, bytes, written, bytes.length - written);
      u.offset += bytes.length;
    } else if (msg.type === "bridge:media-end") {
      const u = this.uploads.get(task.id);
      if (!u || msg.bytes !== u.offset || msg.turnId !== u.turnId)
        throw problem(
          "invalid_upload",
          "Byte count or response turn mismatch.",
          422,
        );
      fs.fsyncSync(u.fd);
      fs.closeSync(u.fd);
      u.fd = null;
      if (this.validating >= 2)
        await new Promise((resolve) => this.validationWaiters.push(resolve));
      else this.validating++;
      let metadata;
      try {
        this.state.match(socket, msg);
        metadata = await validateMedia(u.file, task.kind, this.maxBytes);
      } finally {
        const next = this.validationWaiters.shift();
        if (next) next();
        else this.validating--;
      }
      // A disconnect/navigation during decode invalidates the result.
      this.state.match(socket, msg);
      const id = crypto.randomUUID(),
        name = `${id}.${metadata.extension}`;
      fs.renameSync(u.file, path.join(this.directory, name));
      this.uploads.delete(task.id);
      this.state.data.media[id] = {
        id,
        filename: name,
        taskId: task.id,
        turnId: u.turnId,
        kind: task.kind,
        ...metadata,
      };
      task.media.push(id);
      task.turnId = u.turnId;
      this.state.complete(task);
    }
    return {
      type: "bridge:media-ack",
      id: task.id,
      requestId: msg.requestId,
      offset: this.uploads.get(task.id)?.offset,
      ok: true,
    };
  }
  close() {
    for (const id of [...this.uploads.keys()]) this.abort(id);
    this.state.off("task", this.listener);
  }
}
