<div align="center">

<img src=".github/assets/logo.png" alt="Frond logo" width="160" />

# Frond

**Sticky notes that stay on your machine, stay out of your way, and don't ask you to sign in.**

[![License: MIT](https://img.shields.io/badge/license-MIT-2E7D32?style=for-the-badge)](LICENSE)
[![Platform: Windows x64](https://img.shields.io/badge/platform-Windows%20x64-1B5E20?style=for-the-badge&logo=windows&logoColor=white)](https://cottoncowdev.github.io)
> **Windows 10/11 (x64) only for now.** macOS and Linux builds are not available.
[![Built with Electron](https://img.shields.io/badge/built%20with-Electron-10B981?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org)

### [⬇&nbsp;&nbsp;Download Frond for Windows](https://cottoncowdev.github.io)

*An indie project by **CottonCowDev***

<br />

</div>

---

## The Manifesto

Your sticky notes are a scrap of text you want to see **right now**. They don't need an account, a sync service, a settings page, or a server in a data center to remember "call Martin back".

Most note apps are built the other way around: sign in, sync, update, sign in again. Frond is built on a simpler idea:

> **A note is a file on your disk and a rectangle on your screen. Everything else is overhead.**

- **Absolute local privacy.** Notes live in a single folder on your machine. There is no account and no cloud.
- **Zero sync, zero telemetry.** Frond's code ships no analytics and makes no network requests. Don't take my word for it: read the source and `grep` for it. It's a few files.
- **Raw native speed.** Frameless, transparent, hardware-accelerated. Notes appear when you launch the app and they're already where you left them.
- **Built for heavy multitaskers.** Ten notes or fifty, Frond is designed to stay out of your taskbar and out of your way.

Frond is for people who keep a dozen things open at once and want their notes to be as fast as a Post-it.

---

## Features

### 🌿 Active Focus Shadow & Ecosystem Blur

Frond notices when you type and uses that to protect your focus.

- The moment you start typing, the active note **lifts toward you**. Its shadow deepens from `0 12px 40px` to `0 24px 70px`, and it gets a `1.015` micro-scale, animated over 0.4 s on a hand-tuned ease-out curve.
- **Every other note** dims and heavy-blurs (`blur(40px)`, reduced opacity), so the one place you're writing is the only thing that reads as sharp.
- When you stop for **800 ms**, the active note settles back to rest and the rest of the ecosystem restores itself.
- It costs almost nothing. Frond sends **one** IPC message per typing burst, not one per keystroke. The main process keeps a single "who is typing" owner, so handoffs between notes can't race. A late "stopped" from the note you just left is ignored.
- It handles real keyboards: dead keys, IME input, and **AltGr** (the `@ # { } \` keys on Czech layouts) all count as typing. Shortcuts like `Ctrl+B` don't.

### 👻 The Ghost Host: 1 to 50 notes, ONE taskbar icon

Window spam is what kills sticky-note apps on Windows. Frond solves it at the architecture level:

- A single invisible 1×1 transparent **Ghost Host** window is the *only* window that owns a taskbar button.
- Every note is a frameless, transparent window **owned by the host** with `skipTaskbar: true`. Open 1 note or 50 and the taskbar shows exactly **one clean icon**. No grouped previews, no thumbnail stack.
- **Minimize** hides every note in one pass and parks the host in the taskbar. **Click the icon** and every note bursts back on a shared clock, in the same frame.
- A note window can't be closed by accident. `Alt+F4` is blocked, and a note only leaves your desk through an explicit **Delete note**.
- Running a second copy of Frond just raises the first one. Two instances never fight over your data.

### 🗂️ Mechanical Card Index Physics

Notes behave like cards in an office card catalog:

- **Stack:** drag a note against the top edge of another and it snaps into a flush column.
- **Slide behind:** drop a note onto another and it collapses into a slim tab (a pill handle plus a keyword label pulled from its own text) that peeks out above the stack. Click the tab to bring that note to the front.
- **Pull the card:** grab a tab and pull it up. The card **lifts 30 px** like it's coming out of a catalog drawer, and it slides back if you let go.
- **Rip it out:** keep pulling past **60 px** and the card tears free with a quick 100 ms snap. It becomes an independent, free-floating note under your cursor.

### Also under the hood

- **Word-style rich text** (bold, underline, highlighter) built on the native Selection and Range APIs, with no deprecated `execCommand`. Toggling at the caret works the way you'd expect.
- **Pastel highlighter wheel:** hold the `H` button for 500 ms and a radial menu fans out with Classic Yellow, Soft Orange and Pastel Pink.
- **Crash-proof storage:** notes are saved atomically (temp file, `fsync`, rename), with a rolling `.bak` and a plain-text `.txt` mirror of every note. If the PC loses power mid-sentence, every note comes back at the same coordinates on next launch.
- **Native export:** one click opens the real OS "Save as" dialog and writes your note to a standard `.txt` file anywhere you like.
- **Apple-grade finish:** squircle corners, frosted glass, precise shadows, moss/emerald accents, a vacuum-style minimize and burst-back animation.

---

## Where your data lives

Frond stores everything under Electron's per-user data folder, never inside the app files:

```text
%APPDATA%\Frond\Frond_Storage\
├─ notes.json        # positions, content, formatting, stacks, theme
└─ txt_backups\      # one plain-text mirror per note
```

On first launch there is no `notes.json`, so a brand-new user starts with a clean sheet and nothing from a developer machine ever ships.

Uninstalling Frond **keeps your notes on purpose**. To wipe them for good, delete the `Frond_Storage` folder.

---

## Local Development & Build Pipeline

**Requirements:** Windows 10/11 x64, [Node.js](https://nodejs.org) 16+, Git.

```bash
# 1. Clone the repository
git clone https://github.com/CottonCowDev/frond.git
cd frond

# 2. Install developer dependencies
npm install

# 3. Run in dev mode
npm start

# 4. Compile the production installer (electron-builder, NSIS target)
npm run dist
```

The installer lands in `dist/` as `Frond-Setup-<version>.exe`, for example `Frond-Setup-1.0.0.exe`.

### Project layout

```text
frond/
├─ main.js          # Ghost Host, window lifecycle, storage, IPC
├─ index.html       # note UI + renderer logic
├─ style.css        # glass, shadows, animations
├─ icon.ico         # taskbar / installer icon
├─ package.json     # scripts + electron-builder config
└─ .github/assets/  # logo, screenshots
```

---

## Ecosystem Architecture: Two Repos, On Purpose

Frond is split across **two repositories** to keep each one honest:

| Repository | What it holds |
| --- | --- |
| **[`frond`](https://github.com/CottonCowDev/frond)** *(you are here)* | The open-source codebase, build pipeline and documentation. Nothing else. |
| **[`CottonCowDev.github.io`](https://github.com/CottonCowDev/CottonCowDev.github.io)** | The minimalist, 7-Zip-style download site (GitHub Pages) and the compiled installer, served at [cottoncowdev.github.io](https://cottoncowdev.github.io). |

**Why this repo has no `.exe` in it:**

- Compiled binaries bloat a Git history forever, and every rebuild makes it worse.
- A source repo should be readable top to bottom in an afternoon. A pile of build junk isn't.
- You should never have to wonder whether the thing you're reading is the thing that's running. Source lives here, and the installer is built from it with `npm run dist`.

**Just want to use Frond?** Don't clone anything. Grab the installer from the download site:

### 👉 [**cottoncowdev.github.io**](https://cottoncowdev.github.io)

Everything build-related (`dist/`, `node_modules/`, `*.exe`) is git-ignored. If you ever see a binary in a pull request here, it gets sent back.

---

## Contributing

Issues and pull requests are welcome. Keep it small, keep it local-first, and keep it fast. A change that adds a network call, an account or a telemetry ping is not going to be merged.

## License

[MIT](LICENSE) © 2026 CottonCow

<div align="center">

<sub>Made in 72 hours as a hate letter towards Microsoft</sub>

</div>
