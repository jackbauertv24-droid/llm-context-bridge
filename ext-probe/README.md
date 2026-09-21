# Sideload Probe

A deliberately boring MV3 extension whose only job is to answer: **can I load an
unpacked extension here, and if so what is policy still stopping me from doing?**

It reads nothing about you, stores one throwaway string in extension storage,
and talks to no network host except `127.0.0.1:8787`, which is the echo server
in this folder that you start yourself.

## 1. Check policy first (30 seconds, no install)

Open `chrome://policy` — or `edge://policy` — and click **Reload policies**.

| Policy | Effect |
|---|---|
| `ExtensionDeveloperModeSettings` | Disallowed = the Developer Mode toggle is dead. Hard stop. |
| `ExtensionInstallBlocklist: ["*"]` | Everything blocked except an explicit allowlist. |
| `ExtensionSettings` | Look for `installation_mode: blocked` and `runtime_blocked_hosts`. |
| `BlockExternalExtensions` | Blocks external installs; usually still allows unpacked. |
| `DeveloperToolsAvailability` | Disabled means no DevTools either. |

`runtime_blocked_hosts` is the one people miss: the extension loads perfectly and
is still forbidden from touching `*.microsoft.com`. Step 4 below tests for it.

## 2. Load the extension

1. `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode** (top right). Missing or greyed out → policy blocks it, stop here.
3. **Load unpacked** → select this `ext-probe` folder.
4. Pin it and click the icon.

## 3. Start the echo server

```bash
node echo-server.mjs        # http://127.0.0.1:8787, ctrl-c to stop
```

Zero npm dependencies — the WebSocket handshake and framing are implemented in
the file, so it runs where `npm install` is blocked. Binds to loopback only.

Then reopen the popup. Checks 7 and 8 should go green.

## 4. Read the results

| Check | Why it is there |
|---|---|
| Extension loaded | Sanity, plus confirms MV3 |
| Browser | Chrome and Edge differ on sideloading policy |
| Install type | `development` = unpacked loading works, which is the headline question |
| Service worker responds | The MV3 background context can start at all |
| Service worker restarts | Makes the lifecycle visible — reopen a minute later and the count climbs |
| Extension storage | Some policies restrict it |
| Localhost HTTP | Can an extension reach a local bridge |
| Localhost WebSocket | Same, for the streaming transport |
| Copilot host permission | Whether host access is already granted |

Then press **Test access to copilot.cloud.microsoft**. Open a Copilot tab first.
It requests the optional permission and reads only `document.title` of that tab.

- **Permission prompt appears, injection succeeds** → an extension-based bridge is viable.
- **No prompt at all** → policy suppressed it.
- **Granted but injection throws "blocked"** → `runtime_blocked_hosts`. The extension
  route is dead for that domain even though sideloading works.

## What the service-worker counter is telling you

MV3 background workers are killed after about 30 seconds idle. That counter is
not a bug report, it is the constraint: a bridge cannot just open a WebSocket in
the service worker and assume it stays up. Real options are `chrome.alarms`
keep-alives (30s minimum interval), reconnect-on-wake, an offscreen document, or
holding the connection in a content script on a pinned tab.

## Permissions, and why each one is here

| Permission | Reason |
|---|---|
| `storage` | The round-trip test and the restart counter |
| `scripting` | The optional `runtime_blocked_hosts` test — unused until you press the button |
| `host_permissions: 127.0.0.1, localhost` | The echo server |
| `optional_host_permissions: copilot.cloud.microsoft` | Requested only on the button press, never at install |

Nothing is requested at install time beyond loopback. If you want it even more
inert, delete `scripting` and `optional_host_permissions` from `manifest.json`
and the button stops working; every other check still runs.
