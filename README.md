# DSH Quicklook（划词小窗）

Select text in **any Windows application**, press a hotkey, and get a small always-on-top window to **translate** it or **ask about it**. The DSH main window never pops up.

中文说明见 [docs/DETAIL.md](docs/DETAIL.md)。

## How it works

DSH Desktop runs plugins in a plain Node child process, so a plugin has no access to `BrowserWindow`/`globalShortcut` and cannot create an OS window by itself. This project therefore splits in two:

- **Plugin (Host half, this repo)** — owns all intelligence: text normalization, prompts, model calls (`llm.stream`), web search, clipboard/history/settings, and a local HTTP surface.
- **PowerShell shell** (`shell/quicklook.ps1`) — spawned and stopped by the plugin; owns global hotkeys, text capture, region screenshot, local OCR, and creating/repositioning one borderless Edge app window. Its UI is plain HTML/CSS/JS served by the plugin over `127.0.0.1`.

| Piece | Path | Role |
|---|---|---|
| Plugin entry | `index.js` | Registers routes, writes a runtime token file, starts/stops the shell |
| HTTP surface | `lib/router.js` | `/qk/*` routes, NDJSON streaming, auth, cancellation |
| Model calls | `lib/model.js` | Per-purpose model routing (translate / ask) |
| Prompts | `lib/prompts.js` | Translation, dictionary-card JSON contract, Q&A budget, OCR |
| Normalization | `lib/normalize.js` | PDF/Word line-break repair, shape detection, segmentation |
| Settings/state | `lib/state.js` | `state.json`: settings, history, favorites |
| Shell lifecycle | `lib/shell.js` | Spawn/restart/terminate, passes `QK_*` env vars |
| Client UI | `ui/popup.*` | The floating window |
| Settings page | `client.js` | Registers a `settings.section` page inside DSH |
| Shell | `shell/quicklook.ps1` | Hotkeys, WM_COPY, WinForms region select, Windows OCR window management |

## Features

- Global hotkeys — `Ctrl+Shift+Q` translate, `Ctrl+Shift+E` ask, `Ctrl+Shift+S` screenshot (all editable in-app). Never use `Alt+…`: Alt activates the menu bar and eats the selection.
- **Translate** — text only; a single word produces a dictionary card (IPA, parts of speech, senses, examples with the word highlighted). Split into plain translation / web chat with independent model choices.
- **Ask** — one-shot model call with optional web search (sources are cited); answers follow a fixed budget (one conclusion + 3–5 points).
- **Screenshot** — region select → Windows built-in offline OCR → editable text → translate, or (in ask mode only) send the image to a vision-capable model.
- **Single window** — translate and ask are two independent panes; a pin button keeps new picks in a "pending" list instead of overwriting. History is inline and clickable.
- **Settings in two places** — an in-window drawer and a DSH **Settings → Quicklook** page, both editing the same `state.json`.

## Install

In DSH: **Plugins → Add plugin → local directory**, select this folder. Or install the bundle via the plugin manager with the absolute path of this directory. No build step, no npm dependencies.

The shell spawns Edge with a dedicated profile (`%LOCALAPPDATA%\quicklook-edge`) so its window stays in a process the shell can manage.

## Privacy

- All text/images go only to the DSH-configured model provider; screenshots are OCR'd locally by Windows before anything is sent.
- No API key or credential is stored by this plugin. A random local token and `state.json` (settings/history/favorites) are kept under `$DSH_HOME/plugin-data/dsh-quicklook/`, never in this repository.
- The local HTTP surface binds to the DSH origin only and requires a runtime token.

## Requirements

- Windows 10/11 (PowerShell + `msedge`).
- A running DeepSeek Harness with a configured model. The plugin does **not** work when DSH is fully closed.

## License

MIT — see [LICENSE](LICENSE).
