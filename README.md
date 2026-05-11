# Gong Per-Speaker Playback Speed

A Chrome extension that auto-adjusts Gong call playback speed based on who is currently talking. Set a slower rate for a customer you want to hear clearly, and a faster rate for an internal teammate — the extension switches between them in real time as the call plays.

Built because Gong's single playback-rate control treats every speaker the same, which is rarely what you actually want when reviewing a call.

## What it does

- Detects the current speaker by reading Gong's speaker timeline in the DOM.
- Applies a per-speaker playback rate to the call's media element, switching as the active speaker changes.
- Persists per-speaker preferences across calls (keyed by speaker name).
- Adds inline `−` / value / `+` / `↺` controls next to each speaker in Gong's UI.
- Exposes the same controls (plus a global default and a "clear all" action) from the extension popup.
- Includes a built-in log buffer with a one-click download for diagnostics — today only, no historic bloat.

## Install

Chrome / Edge / Brave (any Chromium browser):

1. `git clone` this repo (or download as ZIP and unpack).
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and pick the project folder.
5. Open or refresh any Gong call page (`https://*.app.gong.io/call?...`).

The icon should appear in the Chrome toolbar. Pin it for easy access.

## Using it

### Inline controls

Each speaker row on the Gong call page gets a small control strip right next to the name:

- `−` decrease that speaker's rate by 0.25×
- `1.75×` current rate for that speaker (dim if it's just the default, bright if it's an override)
- `+` increase that speaker's rate by 0.25×
- `↺` reset that speaker back to the global default

### Popup

Click the extension icon to open the popup. Same controls plus:

- A global default rate (used for any speaker without an override).
- "Clear all speaker overrides" — wipe overrides in one click.
- A "Download logs" button that exports today's diagnostic logs as `.txt` and `.json`.

### Hotkeys (on the Gong page)

| Keys | Action |
| --- | --- |
| `]` / `[` | Current speaker ±0.25× |
| `Shift + ]` / `Shift + [` | Global default ±0.25× |
| `\` | Reset current speaker to default |

Hotkeys are ignored when typing in an input/textarea.

## How it works (short version)

- A content script polls Gong's DOM every few seconds for `.speaker[data-speaker-id]` rows, extracting each speaker's name and segment timings.
- Every 100ms (and on `seeked`, `ratechange`, `play`, `loadedmetadata`), it figures out who is talking at `media.currentTime` and writes the matching `playbackRate` to the page's `<video>` or `<audio>` element.
- Speaker → rate mappings are stored in `chrome.storage.local` under normalized lowercase keys (NFC, whitespace collapsed) so different rendering of the same name doesn't break lookups.
- The popup and inline controls share state via `chrome.storage.onChanged`.

## Diagnostics

Open the popup → **Download logs**. You get two files:

- `gongspeed-logs-<timestamp>.txt` — human-readable
- `gongspeed-logs-<timestamp>.json` — full structured payload (state + entries)

Logs include: speaker scans, rate applications, drift corrections, inline clicks, storage changes, and the resolved media element state. Pruned to the current local day so the buffer never balloons.

To view logs live in the browser instead:

- Page console (Gong tab): `Cmd+Option+J`, filter `[GongSpeed`
- Popup console: right-click the popup → Inspect, filter `[GongSpeed:popup`
- Uncaught throws only: `chrome://extensions` → this extension → Errors

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, host permissions, content script registration |
| `content.js` | Speaker detection, rate enforcement, inline UI, log buffer |
| `popup.html` | Popup markup + styles |
| `popup.js` | Popup logic, log download, override clearing |
| `icon.png` | Toolbar icon |
| `LICENSE` | MIT |

## Privacy

The extension reads only the Gong call page DOM and stores per-speaker rate overrides in `chrome.storage.local` (your browser's local storage). It does not send data anywhere. Logs are kept in memory and only leave the browser when you click "Download logs".

## License

MIT — see [LICENSE](./LICENSE).

## Credits

Open sourced by [Justin DiPietro](https://www.linkedin.com/in/justindipietro/) at [Glia](https://glia.com).
