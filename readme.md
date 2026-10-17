# Electron Teleprompter

Desktop teleprompter app built with [Electron.js](https://www.electronjs.org/).

> **Note:** This is a modified fork of [Electron Teleprompter](https://github.com/reverentgeek/electron-teleprompter), originally created by [David Neal](https://github.com/reverentgeek) and used here under the MIT License. This fork replaces the Deepgram cloud speech service with a fully offline [faster-whisper](https://github.com/SYSTRAN/faster-whisper) service and adds a settable auto-scroll start point. All credit for the original application belongs to David Neal.

## Features

- Translucent overlay — see through the script to your presentation or video call
- Built-in markdown editor with syntax highlighting
- Voice-driven auto-scroll — speak your script and the prompter follows you, powered by fully offline [faster-whisper](https://github.com/SYSTRAN/faster-whisper) speech recognition running locally
- Live reload — script automatically reloads when the file is modified externally
- Adjustable background opacity
- Font size is persisted across sessions
- Mirror/flip mode — for physical teleprompter setups with beam splitters
- Recently opened files — File > Open Recent submenu
- Auto-loads last opened file on startup
- Window position and size are persisted across sessions

## Usage

The Electron Teleprompter app can load any markdown and/or HTML syntax and display that as a translucent overlay on the screen. In this way you can load a script and still see your presentation, video conferencing, or any other applications through the script.

Use the File -> Open menu (or keyboard shortcut) to open a text file that contains markdown or HTML as a script.

### What is Markdown?

Markdown is a lightweight syntax for creating formatted documents. For example, headings use the <code>#</code> symbol.

```md
# This is a Main Heading
## This is a Secondary Heading
```

### Use H2 tags for navigation

Use H2 tags (`##` in markdown) to create both headings and navigation points in your script. Pressing the right arrow on your keyboard will jump the script to the next heading, left arrow to go back. You can also use a presentation remote/clicker (e.g. [Logitech presentation remotes](https://www.logitech.com/en-us/products/presenters.html)) to go navigate forward/back.

### Built-in Markdown Editor

Press `Cmd/Ctrl+E` to open the built-in editor, or `Cmd/Ctrl+N` to start a new script. The editor uses a dark theme with syntax highlighting for markdown, and the background becomes opaque so you can focus on writing.

You can freely toggle between the editor and the teleprompter preview with `Cmd/Ctrl+E` to see how your script looks — your changes are preserved as you switch back and forth. Save with `Cmd/Ctrl+S` or use `Cmd/Ctrl+Shift+S` to save as a new file. If you close the app or open a different file with unsaved changes, you'll be prompted to save first.

### Voice-Driven Auto-Scroll

The teleprompter can listen to you and scroll the script automatically as you speak. No keyboard, remote, or foot pedals required! Speech is transcribed locally by [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — audio never leaves your machine — and the recognized words are matched against your script, so the prompter follows your real cadence and tolerates ad-libs and re-reads.

#### Setup

Auto-scroll needs a local speech-to-text service. The app launches it automatically on startup (it lives at `src/stt-daemon.py`), so set it up once:

1. Install Python 3.
2. Create a virtual environment for the service and install its dependencies. By default the app looks for the interpreter at `~/video-tools/venv/bin/python`. To use a different interpreter, set the `STT_PYTHON` environment variable to its path when launching the app.

   ```bash
   python3 -m venv ~/video-tools/venv
   ~/video-tools/venv/bin/pip install faster-whisper sounddevice websockets numpy
   ```

3. The first time the service runs, faster-whisper downloads its model (default `base`) to the Hugging Face cache, so an internet connection is needed once. After that, transcription is fully offline.
4. Grant microphone access the first time you start auto-scroll.

The service listens on `ws://127.0.0.1:8766`. If it can't be reached when you start auto-scroll, restart the app so it can start the service.

#### Auto-Scroll Usage

- Press `Cmd/Ctrl+Shift+L` (or `Script > Toggle Auto-scroll`) to start listening. A green "Listening" pill appears in the top-right corner.
- Start reading your script. As you speak, the prompter smoothly scrolls to keep your current word about a third of the way down the screen.
- If you scroll manually (trackpad, arrow keys, page keys), auto-scroll yields to you for a few seconds before resuming.
- Press `Cmd/Ctrl+Shift+L` again, or click the indicator pill, to stop listening.

#### Adjusting the speed

Auto-scroll uses a smooth, critically-damped animation. If it feels too laggy or too snappy for your speaking style, tune it with:

| Shortcut             | Action                          |
| -------------------- | ------------------------------- |
| `Cmd/Ctrl+]`         | Increase auto-scroll speed      |
| `Cmd/Ctrl+[`         | Decrease auto-scroll speed      |
| `Cmd/Ctrl+\`         | Reset auto-scroll speed to 1×   |

The speed is persisted across sessions. Speed range is 0.25× to 4× in 0.1 steps.

#### Starting from a point in the script

Auto-scroll begins at the top of the script by default. To start somewhere else — for example, to re-record a section or pick up mid-script:

1. Scroll the preview so the line you want to begin at sits on the reading guide (about a third of the way down the window).
2. Choose `Script > Set Auto-scroll Start Here` (or press `Cmd/Ctrl+Shift+K`). A dashed guide briefly confirms the captured point.
3. Start auto-scroll (`Cmd/Ctrl+Shift+L`) and begin reading — the prompter follows you from that point.

The start point is remembered for the next auto-scroll session and resets when a new script is loaded. Choose `Script > Clear Auto-scroll Start` to return to the top of the script.

#### Selecting a microphone

By default, auto-scroll listens to your system's default audio input. To use a specific microphone (e.g. a USB lavalier or a podcasting mic), set the `STT_DEVICE` environment variable to the device's index or name before launching the app:

```bash
# List available input devices
~/video-tools/venv/bin/python -c "import sounddevice; print(sounddevice.query_devices())"

# Launch with a chosen device (index or a unique part of its name)
STT_DEVICE="USB Lavalier" npm start
```

A device change takes effect the next time the app starts; it does not interrupt an active session.

### Keyboard Shortcuts

#### Shortcuts for the managing the teleprompter overlay

| Shortcut              | Action                        |
| --------------------- | ----------------------------- |
| `Right Arrow`         | Jump to next section (H2)     |
| `Left Arrow`          | Jump to previous section (H2) |
| `Up/Down Arrow`       | Scroll up/down                |
| `Cmd/Ctrl+Plus`       | Increase font size            |
| `Cmd/Ctrl+Minus`      | Decrease font size            |
| `Cmd/Ctrl+0`          | Reset font size to default    |
| `Cmd/Ctrl+M`          | Toggle mirror/flip mode       |
| `Cmd/Ctrl+Shift+Up`   | Increase background opacity   |
| `Cmd/Ctrl+Shift+Down` | Decrease background opacity   |
| `Cmd/Ctrl+Shift+0`    | Reset opacity to default      |

#### Shortcuts for managing the editor

| Shortcut              | Action                        |
| --------------------- | ----------------------------- |
| `Cmd/Ctrl+N`          | New file                      |
| `Cmd/Ctrl+O`          | Open a markdown/text file     |
| `Cmd/Ctrl+E`          | Toggle editor / preview       |
| `Cmd/Ctrl+S`          | Save (in editor mode)         |
| `Cmd/Ctrl+Shift+S`    | Save As (in editor mode)      |

#### Shortcuts for voice-driven auto-scroll

| Shortcut              | Action                        |
| --------------------- | ----------------------------- |
| `Cmd/Ctrl+Shift+L`    | Toggle auto-scroll            |
| `Cmd/Ctrl+Shift+K`    | Set auto-scroll start point   |
| `Cmd/Ctrl+]`          | Increase auto-scroll speed    |
| `Cmd/Ctrl+[`          | Decrease auto-scroll speed    |
| `Cmd/Ctrl+\`          | Reset auto-scroll speed       |

## Developer Setup

1. Install [Node.js LTS](https://nodejs.org/) (v22+)
1. Clone or download the source code.
1. Open a terminal/command window, change to the source code folder, and install dependencies using `npm install`.
1. Set up the local speech-to-text service for auto-scroll — see [Setup](#setup) under Voice-Driven Auto-Scroll. The rest of the app runs without it; only voice-driven auto-scroll needs it.
1. Launch the app from the terminal using `npm start`.

## Origin Story

This app was originally built "in the open" on the [All Hands on Tech Live](https://www.twitch.tv/pluralsight_live) developer stream. You can watch past streams on Pluralsight's [YouTube](https://www.youtube.com/c/pluralsight), [LinkedIn](https://www.linkedin.com/company/pluralsight), or [Facebook](https://www.facebook.com/pluralsight).

## Credits

Electron Teleprompter was created by [David Neal](https://github.com/reverentgeek) and is available at [reverentgeek/electron-teleprompter](https://github.com/reverentgeek/electron-teleprompter) under the MIT License. This fork builds on his work — thanks, David!

