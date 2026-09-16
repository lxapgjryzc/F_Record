# F_Record

[简体中文](README.md) · [Download](https://github.com/lxapgjryzc/F_Record/releases/latest) · [Release notes](RELEASE_NOTES.md)

F_Record records your Photoshop drawing process. It saves frames when the canvas changes, exports recordings as videos, and copies the current canvas to the clipboard.

Version **4.0.1** targets **Windows and Photoshop CC 2015.5–2026 (17.x–27.x)**. The package contains a Generator plug-in and three CEP panels; the installer selects the appropriate panel automatically.

## Install or upgrade

1. Download `F_Record-4.0.1.zip` and extract the entire archive. GitHub's automatic Source code archives require building before installation.
2. Quit Photoshop, open PowerShell in the extracted directory, and run:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DevMode
   ```

   The installer requests administrator privileges and installs into detected, supported Photoshop installations. The panels are unsigned. `-DevMode` sets CEP's `PlayerDebugMode` for the current Windows user so they can load. Once enabled, you can also double-click `scripts\install.cmd`.

3. Start Photoshop and check **Edit → Preferences → Plug-ins**: enable Generator and allow extension panels. Restart Photoshop after changing these preferences.
4. Open **F_Record** under **Window → Extensions** or **Window → Extensions (legacy)**. Menu names vary with version and language.

Use the same command to upgrade both halves together. The panel and Generator use protocol version **13** and should be installed as a matching pair.

| Photoshop | Major version | Selected panel |
|---|---|---|
| CC 2015.5–CC 2017 | 17–18 | `classic` |
| CC 2018–2020 | 19–21 | `legacy` |
| 2021–2026 | 22–27 | `modern` |

CC 2015.1 and earlier are skipped. This table describes build and installer targets; automated tests do not establish validation in every Photoshop release.

### ffmpeg and installer options

Recording works without ffmpeg. Video export and canvas-copy processing require it. The package does not bundle ffmpeg: the installer searches locally first, then downloads from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) if needed, verifies SHA-256, and stores it in `%ProgramData%\F_Record\ffmpeg\`. A download failure does not prevent plug-in installation, but the affected features need ffmpeg installed separately.

```powershell
# Preview without changing the system
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

# Install into a specific Photoshop installation
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DevMode -Path "D:\Adobe Photoshop 2024"

# Skip ffmpeg discovery and download
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DevMode -SkipFfmpeg
```

## Record and resume

Turn recording on in the panel. The Generator saves frames for the active document and keeps working when the panel is hidden or closed. Settings can enable recording automatically when Photoshop starts.

- Canvas changes trigger captures. The default minimum interval is 1.5 seconds and adapts to capture cost; inactivity does not continuously produce duplicate frames.
- Recording defaults to 1080p and JPEG quality 70. Resolution uses a pixel-area budget while preserving the canvas aspect ratio, without cropping to 16:9.
- Document switches, canvas resizing, and a busy Photoshop are handled through synchronization and recovery. Persistent failures appear in the panel.
- Sessions are identified through the PSD, the current run's document map, or the disk index. The index is only used for documents opened from a file with matching canvas dimensions. Uncertain matches are offered for selection.
- **Save As splits the recording**: the new file receives all frames so far and continues independently, while the original retains its recording. Hard links are used where supported, with file copies as a fallback.

## Video, watermarks, and canvas copy

Export the current recording or one from the list. Choose an aspect ratio and duration. Playback is uniform; shorter durations sample frames while retaining the first and last frames. Aspect ratio and duration are remembered for the next export.

Watermarks accept text or an image, with corner, center, or embossed tiling placement, size, and opacity controls. The export dialog can override the content or disable the watermark for one export. Transparent PNG signatures are supported. Set `F_RECORD_FONT` to a font file to select a particular font.

**Copy Canvas** works even when recording is off. It defaults to 1080p; choose another resolution or original size in Settings and control clipboard watermarking separately. Resizing happens before watermarking, and capturing pauses briefly during the operation.

## Organize recordings

| Action | Purpose |
|---|---|
| Open / switch document | Open a recorded PSD, PSB, or other source file. Switching saves and closes the current document first. |
| Archive / restore | File completed work under Archive. Drawing again returns it to the recordings list. |
| Move frames | Place frames beside the source document or return them to the configured frames directory. |
| Select old recordings | Filter by frame count or age; defaults are fewer than 20 frames or creation more than 30 days ago. |
| Pack ZIP | Create one archive per recording, optionally including the source document and deleting originals after packing. |
| Review for cleanup | View artworks in Photoshop one at a time, make decisions, and confirm deletions together. |

Deleting a recording and deleting its source document are separate choices. Source documents are sent to the system trash. Check the listed items before confirming.

## Settings, data, and troubleshooting

Settings and the default frames directory live under `%APPDATA%\F_Record\`:

| Path | Contents |
|---|---|
| `config.json` | Settings |
| `processImages\` | Default recordings directory; each session contains `session.json` and frames |
| `index.json` | Recovery index |
| `logs\generator.log` | Generator log |

Changing the frames directory does not move existing recordings. Back up the source document and its complete frames folder together.

The panel supports English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português (Brasil), and Русский. It follows Photoshop's language and falls back to English when no match exists.

Update checking is off by default. When enabled, it queries GitHub Releases about once a day; a manual check also contacts GitHub. Recording itself stays local.

For a missing panel, connection failure, or export problem, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

Run `scripts\uninstall.cmd` to uninstall. Settings and recordings are preserved by default. Include the Photoshop version, diagnostic output, and relevant logs when [reporting an issue](https://github.com/lxapgjryzc/F_Record/issues).

## Development

Use Node.js 24 and npm:

```powershell
npm install
npm run build
npm run check
node scripts/build.mjs --zip
```

Builds go to `dist\`; the release archive is `release\F_Record-4.0.1.zip`. Development uses the system's Node.js, while the installed plug-in uses Photoshop's runtime.

See the [development and release guide](docs/DEVELOPMENT.md) for module ownership, tests, and publishing steps. Licensed under [GPL-3.0-only](LICENSE).
