const $ = (id) => document.getElementById(id);
let key = "",
  snapshot = {},
  polling = false,
  timer;
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
function notice(text) {
  $("notice").textContent = text;
}
async function api(route, method = "GET", data, extra = {}) {
  const r = await fetch(route, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!r.ok) {
    let msg;
    try {
      msg = (await r.json()).error.message;
    } catch {
      msg = `HTTP ${r.status}`;
    }
    throw new Error(msg);
  }
  return r.json();
}
function button(text, action, cls) {
  const b = node("button", text, cls);
  b.type = "button";
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await action();
      await refresh();
    } catch (e) {
      notice(e.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function display(profile) {
  return (
    snapshot.profiles.find((p) => p.profileInstanceId === profile)
      ?.displayName || profile
  );
}
function target() {
  const t = snapshot.tabs.find(
    (t) => `${t.profileInstanceId}:${t.tabId}` === $("target").value,
  );
  if (!t)
    throw new Error("Chưa có tab phù hợp. Ghép nối và cho phép tab trước.");
  return {
    profileInstanceId: t.profileInstanceId,
    tabId: t.tabId,
    documentSessionId: t.documentSessionId,
  };
}
function renderTargets() {
  const selected = $("target").value;
  $("target").replaceChildren();
  for (const t of snapshot.tabs.filter(
    (t) =>
      t.online &&
      t.ready &&
      !t.uncertain &&
      t.enabled.includes($("kind").value),
  )) {
    const option = node(
      "option",
      `${display(t.profileInstanceId)} · ${t.provider} · tab ${t.tabId}`,
    );
    option.value = `${t.profileInstanceId}:${t.tabId}`;
    $("target").append(option);
  }
  if ([...$("target").options].some((o) => o.value === selected))
    $("target").value = selected;
}
function render() {
  $("profiles").replaceChildren();
  for (const p of snapshot.profiles) {
    const card = node("div", undefined, "card");
    card.append(
      node("strong", p.displayName),
      node(
        "p",
        `${p.online ? "Online" : "Offline"} · ${p.enabled === false ? "Tắt" : "Bật"}`,
      ),
    );
    const name = node("input");
    name.value = p.displayName;
    name.setAttribute("aria-label", "Tên Profile");
    card.append(
      name,
      button(
        "Đổi tên",
        () =>
          api(`/api/bridge/profiles/${p.profileInstanceId}`, "PATCH", {
            displayName: name.value,
          }),
        "secondary",
      ),
      button(
        p.enabled === false ? "Bật" : "Tắt",
        () =>
          api(`/api/bridge/profiles/${p.profileInstanceId}`, "PATCH", {
            enabled: p.enabled === false,
          }),
        "secondary",
      ),
      button(
        "Ngắt kết nối",
        () =>
          api(`/api/bridge/profiles/${p.profileInstanceId}`, "PATCH", {
            disconnect: true,
          }),
        "secondary",
      ),
      node("small", p.profileInstanceId),
    );
    $("profiles").append(card);
  }
  if (!snapshot.profiles.length)
    $("profiles").append(
      node(
        "p",
        "Chưa có Profile. Cài Extension vào Profile Chrome bạn muốn sử dụng và ghép nối.",
      ),
    );
  $("tabs").replaceChildren();
  for (const t of snapshot.tabs) {
    const row = node("tr"),
      identity = node("td", `${display(t.profileInstanceId)} / ${t.tabId}`),
      page = node("td", t.provider);
    page.append(
      node("small", t.url),
      node("small", `Phiên ${t.documentSessionId}`),
    );
    row.append(identity, page);
    for (const kind of ["text", "image", "video"]) {
      const cell = node("td"),
        label = node("label"),
        check = node("input");
      check.type = "checkbox";
      check.checked = t.enabled.includes(kind);
      check.disabled = !t.online || !t.supported.includes(kind);
      check.setAttribute("aria-label", `${kind} tab ${t.tabId}`);
      check.addEventListener("change", async () => {
        try {
          await api(
            `/api/bridge/tabs/${t.profileInstanceId}/${t.tabId}`,
            "PATCH",
            {
              documentSessionId: t.documentSessionId,
              enabled: check.checked
                ? [...t.enabled, kind]
                : t.enabled.filter((k) => k !== kind),
            },
          );
          await refresh();
        } catch (e) {
          notice(e.message);
          check.checked = !check.checked;
        }
      });
      label.append(
        check,
        node(
          "small",
          !t.supported.includes(kind)
            ? "Chưa phát hiện"
            : t.verified[kind]
              ? "Adapter đã trả kết quả"
              : check.checked
                ? "Đã cho phép · chưa xác minh"
                : "Đã phát hiện",
        ),
      );
      cell.append(label);
      row.append(cell);
    }
    const status = node(
      "td",
      t.uncertain
        ? "UNKNOWN cần kiểm tra"
        : t.busy
          ? "Đang chạy"
          : t.online
            ? "Sẵn sàng"
            : "Offline",
    );
    if (t.uncertain)
      status.append(
        button(
          "Tôi đã kiểm tra tab; giải phóng",
          () =>
            api(`/api/bridge/tabs/${t.profileInstanceId}/${t.tabId}`, "PATCH", {
              documentSessionId: t.documentSessionId,
              releaseUnknown: true,
            }),
          "secondary",
        ),
      );
    row.append(status);
    $("tabs").append(row);
  }
  renderTargets();
  $("tasks").replaceChildren();
  for (const t of snapshot.tasks.slice().reverse()) {
    const row = node("tr");
    for (const text of [
      t.id.slice(0, 8),
      `${display(t.profileInstanceId)} / ${t.tabId}`,
      t.kind,
      t.status,
    ])
      row.append(node("td", text));
    const result = node("td");
    if (t.error) result.append(node("small", t.error));
    if (t.text)
      result.append(
        button(
          "Xem phản hồi",
          () => {
            $("resultText").textContent = t.text;
            $("result").showModal();
          },
          "secondary",
        ),
      );
    if (t.status === "QUEUED")
      result.append(
        button(
          "Hủy hàng chờ",
          () => api(`/api/bridge/tasks/${t.id}/cancel`, "POST", {}),
          "secondary",
        ),
      );
    row.append(result);
    $("tasks").append(row);
  }
  $("media").replaceChildren();
  for (const m of snapshot.media) {
    const card = node("div", undefined, "card");
    card.append(
      node("strong", m.mime),
      node(
        "p",
        `${(m.bytes / 1024).toFixed(1)} KiB · ${m.width} × ${m.height}${m.duration ? " · " + m.duration.toFixed(2) + "s" : ""}`,
      ),
      node("small", `Task ${m.taskId}`),
      node("p", `SHA256 ${m.sha256}`),
    );
    card.append(
      button(
        "Kiểm tra SHA256",
        async () => {
          const result = await api(
            `/api/bridge/media/${m.id}/verify`,
            "POST",
            {},
          );
          notice(result.ok ? "Checksum hợp lệ." : "Checksum không khớp.");
        },
        "secondary",
      ),
    );
    card.append(
      button(
        "Tải file",
        async () => {
          const r = await fetch(`/v1/media/${m.id}`, {
            headers: { Authorization: `Bearer ${key}` },
          });
          if (!r.ok) throw new Error("Không tải được file.");
          const blob = await r.blob(),
            url = URL.createObjectURL(blob),
            a = node("a");
          a.href = url;
          a.download = m.filename;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        },
        "secondary",
      ),
    );
    $("media").append(card);
  }
}
async function refresh() {
  if (polling || !key) return;
  polling = true;
  try {
    const [profiles, tabs, tasks, media] = await Promise.all(
      ["profiles", "tabs", "tasks", "media"].map((x) =>
        api("/api/bridge/" + x),
      ),
    );
    snapshot = { profiles, tabs, tasks, media };
    render();
    $("connection").textContent =
      `${profiles.filter((p) => p.online).length} Profile online`;
  } catch (e) {
    notice(e.message);
  } finally {
    polling = false;
  }
}
$("auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  key = $("key").value;
  try {
    await api("/api/bridge/health");
    $("unlock").hidden = true;
    $("workspace").hidden = false;
    $("key").value = "";
    await refresh();
    timer = setInterval(refresh, 5000);
    notice("Đã kết nối. Quyền tab cần được bật riêng cho từng phiên trang.");
  } catch (e) {
    key = "";
    notice(e.message);
  }
});
$("kind").addEventListener("change", renderTargets);
$("setDefault").addEventListener("click", async () => {
  try {
    await api("/api/bridge/defaults", "PATCH", { [$("kind").value]: target() });
    notice("Đã lưu đích mặc định cho " + $("kind").value);
  } catch (e) {
    notice(e.message);
  }
});
$("task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("task").querySelector("button:not([type])");
  submit.disabled = true;
  try {
    const task = await api(
      "/api/bridge/tasks",
      "POST",
      { kind: $("kind").value, target: target(), prompt: $("prompt").value },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    notice("Đã tạo task " + task.id);
    await refresh();
  } catch (e) {
    notice(e.message);
  } finally {
    submit.disabled = false;
  }
});
