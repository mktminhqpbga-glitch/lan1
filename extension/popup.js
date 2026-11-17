const $ = (id) => document.getElementById(id);
async function load() {
  const state = await chrome.runtime.sendMessage({ type: "bridge:get-state" });
  for (const id of ["serverUrl", "token", "displayName"])
    $(id).value = state.settings[id];
  $("identity").textContent = "Profile ID: " + state.settings.profileInstanceId;
  $("status").textContent = state.socketState;
  $("error").textContent = state.lastError;
  $("pause").textContent = state.settings.paused ? "Continue" : "Pause";
}
$("save").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "bridge:save",
    serverUrl: $("serverUrl").value,
    token: $("token").value,
    displayName: $("displayName").value,
  });
  if (!result.ok) $("error").textContent = result.error;
  else await load();
});
$("pause").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "bridge:toggle-pause" });
  await load();
});
load();
