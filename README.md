# AS Screen Recorder — Made by AS Technology

Free, unlimited-length, watermark-free screen recorder for Windows (Electron + bundled FFmpeg).

## Build the installer (on a Windows PC, ~5 minutes)

1. Install **Node.js LTS** from https://nodejs.org (only needed to *build*, not to use the app).
2. Double-click **`build-installer.bat`**.
3. Your installer appears at **`dist\AS-Screen-Recorder-Setup.exe`**.

No Windows PC with Node? Push this folder to a GitHub repo and run the **Build Windows installer** workflow
(Actions tab) — it uploads `AS-Screen-Recorder-Setup.exe` as a downloadable artifact.

To try the app without building: `npm install` then `npm start`.

## How it meets the spec
- **Installer**: NSIS wizard, desktop + Start Menu shortcuts, uninstall via Windows Settings, custom icon.
- **Modes**: full screen (pick display) and drag-to-select area that can be moved/resized before starting.
- **Controls**: Start / Pause / Resume / Stop on an always-on-top bar with timer + REC indicator.
  The bar is excluded from capture (content protection), so it never appears in the video.
- **Webcam**: opt-in, device picker, live preview, corner + size, composited into the video.
- **Audio**: microphone (device picker + level meter) and separate "Computer sound" (WASAPI loopback) toggle; active sources shown as chips and on the bar.
- **Unlimited duration**: video is encoded in 1-second chunks written straight to disk (RAM stays flat);
  warning below 2 GB free, automatic safe finalize below 200 MB free. No time cap anywhere.
- **Quality**: 720p / 1080p / original, 30 / 60 FPS, smaller / balanced / best presets (Chromium uses hardware H.264 when available).
- **MP4**: finalized with bundled FFmpeg (`+faststart`, AAC audio). Custom folder + file name (`{date}` token),
  open video / show in folder / save a copy. No watermark or overlay is ever drawn on footage.

## Test checklist (run on Windows before distributing)
Full screen · custom area · mic · webcam overlay · A/V sync · pause/resume/stop · 1h+ session ·
playback in VLC + Windows Media Player · low-disk warning · install / uninstall · shortcut + icon.
