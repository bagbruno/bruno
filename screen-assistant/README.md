# Screen Assistant

Reads your screen, answers what's on it using Claude, and sends the answer to your phone.

It runs **in the background**: no window, nothing on the taskbar. Its only sign is a small blue
monitor icon in the system tray, under the **^ "Show hidden icons"** arrow next to the clock.

## Ways to get answers

| Mode | How it works |
|---|---|
| **Hotkey** | Press **Ctrl+Alt+Q**. Your current screen is answered and the answer is sent to your phone. |
| **Live mode** | Watches the screen. When a new question appears, it sends the answer by itself. Turn it on or off with **Ctrl+Alt+W** or from the tray icon. |
| **Chat** (Telegram only) | Message your bot from your phone, for example "what's the answer to question 3?" or "explain that more simply". It takes a screenshot and replies. |

Right-click the tray icon for: Answer screen now · Live mode on/off · New conversation · Open log · Quit.

## Setup (Windows, once)

1. Install **Python 3.10+** from https://www.python.org/downloads/ and check **"Add python.exe to PATH"** in the installer.
2. Open this folder, click the address bar, type `cmd` and press Enter. Then run:
   ```
   pip install -r requirements.txt
   python screen_assistant.py setup
   ```
   The wizard asks for:
   - Your **Anthropic API key**. Create one at https://console.anthropic.com/settings/keys.
   - How answers reach your phone:
     - **ntfy**: easiest. Install the free *ntfy* app and subscribe to the topic name the wizard shows you.
     - **Telegram**: also lets you chat with it. In Telegram, message **@BotFather**, send `/newbot`, paste the token into the wizard, then send your new bot any message.
3. **Start it:** double-click **`start_hidden.pyw`**. No window opens; the tray icon appears.

**Start automatically with Windows:** press **Win+R**, type `shell:startup`, press Enter, and put a
shortcut to `start_hidden.pyw` in the folder that opens.

**Stop it:** right-click the tray icon, then **Quit**.

> If the icon is in the overflow area and you want it always visible, drag it from the ^ menu onto the
> taskbar corner. To keep it hidden, leave it where it is.

## Other commands

```
python screen_assistant.py test     # send a test message to your phone
python screen_assistant.py once     # answer the current screen once (shows output in the console)
python screen_assistant.py run      # same as start_hidden.pyw, but with a console showing the log
```

Problems? Right-click the tray icon, then **Open log**. You can also open `screen_assistant.log` in this folder.

## Settings (`config.json`)

| Setting | Meaning |
|---|---|
| `effort` | How hard Claude thinks: `low` (fastest, cheapest), `medium` (default), `high` (best for hard math or logic). |
| `modes.watch` | `true` starts with live mode on. |
| `modes.chat` | Telegram chat on or off. |
| `hotkey`, `watch_toggle_hotkey` | Key combos, e.g. `<ctrl>+<shift>+a`. |
| `watch.interval_seconds` | How often live mode checks the screen. |
| `watch.change_threshold` | How much of the screen must change to count as new (0.005 = 0.5%). |
| `monitor` | `1` = main screen, `2` = second screen, `0` = all screens together. |
| `max_image_edge` | Screenshot size sent to Claude. Larger reads small text better but costs more. |
| `extra_instructions` | Anything extra, e.g. `"Always answer in Portuguese"` or `"Show the working for math"`. |
| `model` | Defaults to `claude-opus-5-5`. |

After you edit `config.json`, quit from the tray and start the program again.

## Good to know

- **Cost:** each answer sends one screenshot to the Anthropic API, roughly 1–2 US cents each at the default
  settings. Live mode only sends a screenshot when the screen has changed and stopped moving, so a static
  screen or a playing video costs nothing.
- **Privacy:** screenshots go to Anthropic's API. Answers pass through ntfy.sh or Telegram. Your ntfy topic name
  works like a password, so don't share it. The Telegram bot only answers your own chat; it ignores everyone else.
- **Refusals:** if Claude's safety filter declines a request, it automatically retries on Anthropic's recommended
  fallback model (`fallbacks: "default"`).
- **Mac:** this also works. Use `python3 screen_assistant.py run`, and allow *Screen Recording* and *Accessibility*
  for your terminal in System Settings → Privacy & Security.
