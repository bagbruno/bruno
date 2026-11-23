#!/usr/bin/env python3
"""
Screen Assistant - looks at your screen, answers what's on it with Claude,
and sends the answer to your phone (ntfy app or Telegram).

It runs in the background with an icon in the system tray (the "show hidden
icons" area on Windows). It has no window and nothing on the taskbar.

Ways to get answers (they can all run at the same time):
  * Hotkey     - press Ctrl+Alt+Q: the current screen is answered and sent to your phone.
  * Live mode  - watches the screen and sends an answer whenever a new question appears.
  * Chat       - (Telegram only) message your bot from your phone; it looks at your
                 screen and replies, and you can ask follow-up questions.

Commands:
  python screen_assistant.py setup   first-time setup wizard (creates config.json)
  python screen_assistant.py test    send a test message to your phone
  python screen_assistant.py once    answer what's on the screen right now, once
  python screen_assistant.py run     start in the system tray (use pythonw to hide the console)
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re
import secrets
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
LOG_PATH = HERE / "screen_assistant.log"

DEFAULT_CONFIG = {
    "anthropic_api_key": "",
    "model": "claude-opus-5-5",
    "effort": "medium",
    "notifier": "ntfy",
    "ntfy": {"server": "https://ntfy.sh", "topic": ""},
    "telegram": {"bot_token": "", "chat_id": ""},
    "modes": {"hotkey": True, "watch": False, "chat": True, "tray_icon": True},
    "hotkey": "<ctrl>+<alt>+q",
    "watch_toggle_hotkey": "<ctrl>+<alt>+w",
    "watch": {
        "interval_seconds": 3,
        "change_threshold": 0.005,
        "min_seconds_between_answers": 5,
    },
    "monitor": 1,
    "max_image_edge": 1920,
    "extra_instructions": "",
}

# Models that accept server-side refusal fallbacks (fallbacks="default").
FALLBACK_MODELS = {
    "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5",
    "claude-fable-5-2", "claude-fable-5-1",
}

SYSTEM_PROMPT = """\
You are Screen Assistant. Each user message includes a screenshot of the user's \
computer screen. The user reads your reply on their phone, as a notification or \
a chat message.

How to answer:
- Find the question, problem, or task the user is most likely looking at. If the \
user asked something specific, answer that, using the screen as context.
- Put the answer itself on the first line. For multiple choice, give the letter \
and the option text. For math, give the final result.
- Then add a short explanation (1-4 sentences) only if it helps.
- If several questions are visible, answer each one, numbered.
- Plain text only: no Markdown, tables, or headings, unless the answer is code. \
Keep it short enough to read comfortably on a phone.
- Reply in the language the question is written in.
- If the screenshot is unreadable or there is nothing to answer, say so in one line."""

WATCH_PROMPT = """\
Live mode check. If the screen shows no question, problem, or task that needs an \
answer, reply with exactly NO_QUESTION and nothing else.{previous}
Otherwise reply in exactly this format:
Q: <the question, restated in at most 15 words>
A: <the answer, in your usual style>"""

log = logging.getLogger("screen_assistant")


# --------------------------------------------------------------------------- config

def deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return json.loads(json.dumps(DEFAULT_CONFIG))
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return deep_merge(DEFAULT_CONFIG, json.load(f))


def save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


# --------------------------------------------------------------------------- screen

def grab_screen(monitor: int):
    """Return a PIL image of the chosen monitor (0 = all monitors together)."""
    import mss
    from PIL import Image

    factory = getattr(mss, "MSS", None) or mss.mss
    with factory() as sct:
        monitors = sct.monitors
        mon = monitors[monitor] if 0 <= monitor < len(monitors) else monitors[1]
        shot = sct.grab(mon)
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def encode_image(img, max_edge: int) -> tuple[str, str]:
    """Shrink to max_edge on the long side; return (base64 data, media type)."""
    from PIL import Image

    img = img.copy()
    if max(img.size) > max_edge:
        img.thumbnail((max_edge, max_edge), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    media_type = "image/png"
    if buf.tell() > 3_500_000:  # keep well under the API's 5 MB image limit
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        media_type = "image/jpeg"
    return base64.standard_b64encode(buf.getvalue()).decode("ascii"), media_type


def thumbnail(img):
    return img.convert("L").resize((192, 108))


def changed_fraction(a, b) -> float:
    """Fraction of thumbnail pixels that changed noticeably between two frames."""
    from PIL import ImageChops

    diff = ImageChops.difference(a, b).point(lambda p: 255 if p > 24 else 0)
    return diff.histogram()[255] / (a.size[0] * a.size[1])


# --------------------------------------------------------------------------- Claude

class Brain:
    """Sends screenshots to Claude and keeps a short text-only conversation history."""

    MAX_HISTORY_MESSAGES = 12

    def __init__(self, cfg: dict):
        import anthropic

        self.anthropic = anthropic
        self.cfg = cfg
        key = cfg.get("anthropic_api_key") or None
        self.client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
        self.history: list[dict] = []
        self.lock = threading.Lock()
        system = SYSTEM_PROMPT
        if cfg.get("extra_instructions"):
            system += "\n\nExtra instructions from the user:\n" + cfg["extra_instructions"]
        self.system = system

    def reset(self) -> None:
        with self.lock:
            self.history.clear()

    def ask(self, img, prompt: str, remember: bool = True) -> str:
        data, media_type = encode_image(img, int(self.cfg["max_image_edge"]))
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}},
            {"type": "text", "text": prompt},
        ]
        with self.lock:
            messages = self.history + [{"role": "user", "content": content}]
            model = self.cfg["model"]
            kwargs = dict(
                model=model,
                max_tokens=16000,
                system=self.system,
                output_config={"effort": self.cfg["effort"]},
                messages=messages,
            )
            if model in FALLBACK_MODELS:
                # If Claude's safety filter declines, retry on Anthropic's recommended fallback model.
                kwargs["betas"] = ["server-side-fallback-2026-07-01"]
                kwargs["fallbacks"] = "default"
            response = self.client.beta.messages.create(**kwargs)

            if response.stop_reason == "refusal":
                return "Claude declined to answer this one."
            text = "\n".join(b.text for b in response.content if b.type == "text").strip()
            if response.stop_reason == "max_tokens":
                text += "\n[answer was cut off]"

            if remember and text:
                stamp = datetime.now().strftime("%H:%M")
                self.history.append({
                    "role": "user",
                    "content": f"[Screenshot taken at {stamp}, no longer attached]\n{prompt}",
                })
                self.history.append({"role": "assistant", "content": text})
                self.history = self.history[-self.MAX_HISTORY_MESSAGES:]
            return text


# --------------------------------------------------------------------------- phone

def split_text(text: str, limit: int) -> list[str]:
    chunks = []
    while len(text.encode("utf-8")) > limit:
        cut = text[:limit]
        while len(cut.encode("utf-8")) > limit:
            cut = cut[:-50]
        nl = cut.rfind("\n")
        if nl > len(cut) // 2:
            cut = cut[:nl]
        chunks.append(cut)
        text = text[len(cut):].lstrip("\n")
    chunks.append(text)
    return chunks


class ConsoleNotifier:
    def send(self, title: str, text: str) -> None:
        print(f"\n=== {title} ===\n{text}\n", flush=True)


class NtfyNotifier:
    """Push notifications through the free ntfy app (ntfy.sh)."""

    def __init__(self, cfg: dict):
        import requests

        self.requests = requests
        self.server = cfg["ntfy"]["server"].rstrip("/")
        self.topic = cfg["ntfy"]["topic"]
        if not self.topic:
            raise SystemExit("ntfy topic is empty - run: python screen_assistant.py setup")

    def send(self, title: str, text: str) -> None:
        chunks = split_text(text or "(empty answer)", 3500)
        for i, chunk in enumerate(chunks, 1):
            t = title if len(chunks) == 1 else f"{title} ({i}/{len(chunks)})"
            r = self.requests.post(
                self.server,
                json={"topic": self.topic, "title": t, "message": chunk,
                      "priority": 4, "tags": ["bulb"]},
                timeout=20,
            )
            r.raise_for_status()


class Telegram:
    """Telegram bot: sends answers to you, and receives your questions (chat mode)."""

    def __init__(self, cfg: dict):
        import requests

        self.requests = requests
        self.token = cfg["telegram"]["bot_token"]
        self.chat_id = str(cfg["telegram"]["chat_id"])
        if not self.token or not self.chat_id:
            raise SystemExit("Telegram is not set up - run: python screen_assistant.py setup")
        self.base = f"https://api.telegram.org/bot{self.token}"

    def call(self, method: str, timeout: float = 20, **params):
        r = self.requests.post(f"{self.base}/{method}", data=params, timeout=timeout)
        r.raise_for_status()
        return r.json()["result"]

    def send(self, title: str, text: str) -> None:
        body = f"{title}\n\n{text}" if title else text
        for chunk in split_text(body or "(empty answer)", 4000):
            self.call("sendMessage", chat_id=self.chat_id, text=chunk)

    def typing(self) -> None:
        try:
            self.call("sendChatAction", chat_id=self.chat_id, action="typing")
        except Exception:
            pass

    def send_photo(self, img) -> None:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        r = self.requests.post(
            f"{self.base}/sendPhoto",
            data={"chat_id": self.chat_id},
            files={"photo": ("screen.jpg", buf.getvalue(), "image/jpeg")},
            timeout=60,
        )
        r.raise_for_status()


def make_notifier(cfg: dict):
    kind = cfg["notifier"]
    if kind == "ntfy":
        return NtfyNotifier(cfg)
    if kind == "telegram":
        return Telegram(cfg)
    return ConsoleNotifier()


# --------------------------------------------------------------------------- app

class App:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.brain = Brain(cfg)
        self.notifier = make_notifier(cfg)
        self.telegram = self.notifier if isinstance(self.notifier, Telegram) else None
        self.stop = threading.Event()
        self.watch_on = threading.Event()
        if cfg["modes"]["watch"]:
            self.watch_on.set()
        self.busy = threading.Lock()
        self.tray = None

    # -- helpers
    def notify(self, title: str, text: str) -> None:
        try:
            self.notifier.send(title, text)
        except Exception as e:
            log.error("Could not send to phone: %s", e)

    def answer_error(self, e: Exception) -> str:
        a = self.brain.anthropic
        if isinstance(e, a.AuthenticationError):
            return "Error: the Anthropic API key is invalid. Fix it in config.json."
        if isinstance(e, a.RateLimitError):
            return "Error: rate limited by the Anthropic API. Try again in a minute."
        if isinstance(e, a.APIConnectionError):
            return "Error: no internet connection to the Anthropic API."
        if isinstance(e, a.APIStatusError):
            return f"Error from the Anthropic API ({e.status_code}): {e.message}"
        return f"Error: {e}"

    # -- one-shot answer (hotkey, tray menu, `once`)
    def answer_now(self, question: str | None = None) -> None:
        if not self.busy.acquire(blocking=False):
            log.info("Still working on the previous answer, ignoring.")
            return
        try:
            log.info("Reading the screen...")
            img = grab_screen(int(self.cfg["monitor"]))
            prompt = question or "Answer what's on my screen."
            answer = self.brain.ask(img, prompt)
            log.info("Answer:\n%s", answer)
            self.notify("Screen answer", answer)
        except Exception as e:
            log.exception("Answer failed")
            self.notify("Screen Assistant", self.answer_error(e))
        finally:
            self.busy.release()

    def answer_async(self, question: str | None = None) -> None:
        threading.Thread(target=self.answer_now, args=(question,), daemon=True).start()

    def toggle_watch(self, *_):
        if self.watch_on.is_set():
            self.watch_on.clear()
            log.info("Live mode OFF")
        else:
            self.watch_on.set()
            log.info("Live mode ON")
        if self.tray:
            self.tray.update_menu()

    # -- live mode
    def watch_loop(self) -> None:
        w = self.cfg["watch"]
        interval = float(w["interval_seconds"])
        threshold = float(w["change_threshold"])
        min_gap = float(w["min_seconds_between_answers"])
        prev = analyzed = None
        last_question = ""
        last_call = 0.0
        while not self.stop.wait(interval):
            if not self.watch_on.is_set():
                prev = None
                continue
            try:
                img = grab_screen(int(self.cfg["monitor"]))
            except Exception as e:
                log.error("Screen capture failed: %s", e)
                continue
            thumb = thumbnail(img)
            stable = prev is not None and changed_fraction(thumb, prev) < threshold
            prev = thumb
            if not stable:
                continue  # screen is still changing (scrolling, typing); wait for it to settle
            if analyzed is not None and changed_fraction(thumb, analyzed) < threshold:
                continue  # nothing new since the last check
            if time.time() - last_call < min_gap or not self.busy.acquire(blocking=False):
                continue
            try:
                analyzed, last_call = thumb, time.time()
                previous = ""
                if last_question:
                    previous = (f'\nThe last question you answered was: "{last_question}". '
                                "If that is still the question on screen, reply exactly NO_QUESTION.")
                reply = self.brain.ask(img, WATCH_PROMPT.format(previous=previous), remember=False)
                if not reply or reply.strip().upper().startswith("NO_QUESTION"):
                    continue
                m = re.search(r"^Q:\s*(.+)$", reply, re.MULTILINE)
                question = m.group(1).strip() if m else reply[:80]
                if norm(question) == norm(last_question):
                    continue
                last_question = question
                # Keep the answer in history so you can ask follow-ups from Telegram.
                with self.brain.lock:
                    self.brain.history += [
                        {"role": "user", "content": "[Live mode screenshot, no longer attached]"},
                        {"role": "assistant", "content": reply},
                    ]
                    self.brain.history = self.brain.history[-Brain.MAX_HISTORY_MESSAGES:]
                log.info("Live answer:\n%s", reply)
                self.notify("New answer", reply)
            except Exception as e:
                log.exception("Live mode answer failed")
                self.notify("Screen Assistant", self.answer_error(e))
            finally:
                self.busy.release()

    # -- Telegram chat
    def chat_loop(self) -> None:
        tg = self.telegram
        offset = None
        try:  # skip messages sent while the program was not running
            old = tg.call("getUpdates", offset=-1, timeout=0)
            if old:
                offset = old[-1]["update_id"] + 1
        except Exception as e:
            log.error("Telegram: %s", e)
        while not self.stop.is_set():
            try:
                params = {"timeout": 25}
                if offset is not None:
                    params["offset"] = offset
                updates = tg.call("getUpdates", timeout=35, **params)
            except Exception as e:
                log.error("Telegram polling error: %s", e)
                self.stop.wait(5)
                continue
            for upd in updates:
                offset = upd["update_id"] + 1
                msg = upd.get("message") or {}
                # Only you may use the bot - anyone else could otherwise see your screen.
                if str(msg.get("chat", {}).get("id")) != tg.chat_id:
                    continue
                text = (msg.get("text") or "").strip()
                if text:
                    threading.Thread(target=self.handle_chat, args=(text,), daemon=True).start()

    def handle_chat(self, text: str) -> None:
        tg = self.telegram
        cmd = text.split()[0].lower().split("@")[0]
        try:
            if cmd in ("/start", "/help"):
                tg.send("", CHAT_HELP)
            elif cmd == "/new":
                self.brain.reset()
                tg.send("", "Started a new conversation.")
            elif cmd == "/watch":
                arg = text.split()[1].lower() if len(text.split()) > 1 else ""
                if arg == "on" or (arg == "" and not self.watch_on.is_set()):
                    self.watch_on.set()
                else:
                    self.watch_on.clear()
                if self.tray:
                    self.tray.update_menu()
                tg.send("", f"Live mode is {'ON' if self.watch_on.is_set() else 'OFF'}.")
            elif cmd == "/screen":
                tg.send_photo(grab_screen(int(self.cfg["monitor"])))
            else:
                question = None if cmd in ("/ask", "?") else text
                tg.typing()
                self.answer_now(question)
        except Exception as e:
            log.exception("Chat command failed")
            self.notify("Screen Assistant", f"Error: {e}")

    # -- hotkeys
    def start_hotkeys(self) -> None:
        try:
            from pynput import keyboard
        except Exception as e:
            log.error("Hotkeys unavailable: %s", e)
            return
        mapping = {self.cfg["hotkey"]: self.answer_async}
        if self.cfg.get("watch_toggle_hotkey"):
            mapping[self.cfg["watch_toggle_hotkey"]] = self.toggle_watch
        listener = keyboard.GlobalHotKeys(mapping)
        listener.daemon = True
        listener.start()
        log.info("Hotkeys: %s = answer screen, %s = live mode on/off",
                 self.cfg["hotkey"], self.cfg.get("watch_toggle_hotkey"))

    # -- tray icon
    def run_tray(self) -> bool:
        try:
            import pystray
        except Exception as e:
            log.error("Tray icon unavailable (%s); running without it.", e)
            return False

        def quit_app(icon, _item):
            self.stop.set()
            icon.stop()

        menu = pystray.Menu(
            pystray.MenuItem("Answer screen now", lambda *_: self.answer_async(), default=True),
            pystray.MenuItem("Live mode", self.toggle_watch,
                             checked=lambda _item: self.watch_on.is_set()),
            pystray.MenuItem("New conversation", lambda *_: self.brain.reset()),
            pystray.MenuItem("Open log", lambda *_: open_file(LOG_PATH)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", quit_app),
        )
        self.tray = pystray.Icon("screen_assistant", tray_image(), "Screen Assistant", menu)
        self.tray.run()  # blocks until Quit; must run on the main thread (macOS)
        return True

    def run(self) -> None:
        modes = self.cfg["modes"]
        if modes["hotkey"]:
            self.start_hotkeys()
        threading.Thread(target=self.watch_loop, daemon=True).start()
        if modes["chat"] and self.telegram:
            threading.Thread(target=self.chat_loop, daemon=True).start()
            log.info("Telegram chat is on - message your bot from your phone.")
        log.info("Screen Assistant is running. Live mode: %s",
                 "ON" if self.watch_on.is_set() else "OFF")
        if modes.get("tray_icon", True) and self.run_tray():
            return
        try:
            while not self.stop.wait(1):
                pass
        except KeyboardInterrupt:
            pass


CHAT_HELP = """\
Screen Assistant commands:
(any message) - I look at your screen and answer your message
? or /ask - answer whatever is on the screen
/screen - send me a screenshot of the screen
/watch on | /watch off - live mode (auto-answers new questions)
/new - forget the conversation and start fresh"""


def norm(s: str) -> str:
    return re.sub(r"\W+", " ", s.lower()).strip()


def tray_image():
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4, 8, 60, 48), radius=8, fill=(37, 99, 235, 255))
    d.rectangle((26, 48, 38, 56), fill=(37, 99, 235, 255))
    d.rectangle((16, 54, 48, 60), fill=(37, 99, 235, 255))
    d.ellipse((22, 18, 42, 38), outline=(255, 255, 255, 255), width=5)
    return img


def open_file(path: Path) -> None:
    import os
    import subprocess

    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


# --------------------------------------------------------------------------- setup

def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value or default


def setup() -> None:
    import os

    import requests

    cfg = load_config()
    print("\n=== Screen Assistant setup ===\n")

    if os.environ.get("ANTHROPIC_API_KEY") and not cfg["anthropic_api_key"]:
        print("Using the ANTHROPIC_API_KEY environment variable.")
    else:
        print("Get an API key at https://console.anthropic.com/settings/keys")
        key = ask("Anthropic API key", "(keep current)" if cfg["anthropic_api_key"] else "")
        if key and key != "(keep current)":
            cfg["anthropic_api_key"] = key

    print("\nHow should answers reach your phone?")
    print("  1) ntfy app      - easiest: install the app, no account needed (one-way)")
    print("  2) Telegram bot  - also lets you chat with it and ask follow-ups from your phone")
    choice = ask("Choose 1 or 2", "2" if cfg["notifier"] == "telegram" else "1")

    if choice == "2":
        cfg["notifier"] = "telegram"
        print("\nIn Telegram, open @BotFather, send /newbot and follow the steps.")
        print("It gives you a token like 123456789:ABC-DEF...")
        token = ask("Bot token", cfg["telegram"]["bot_token"])
        base = f"https://api.telegram.org/bot{token}"
        me = requests.get(f"{base}/getMe", timeout=20).json()
        if not me.get("ok"):
            raise SystemExit("That token did not work - check it and run setup again.")
        username = me["result"]["username"]
        print(f"\nNow open Telegram on your phone, find @{username} and send it any message.")
        print("Waiting up to 2 minutes...")
        chat_id = None
        deadline = time.time() + 120
        while time.time() < deadline and not chat_id:
            ups = requests.get(f"{base}/getUpdates", params={"timeout": 20}, timeout=30).json()
            for u in ups.get("result", []):
                msg = u.get("message")
                if msg:
                    chat_id = str(msg["chat"]["id"])
        if not chat_id:
            raise SystemExit("No message received - run setup again.")
        cfg["telegram"] = {"bot_token": token, "chat_id": chat_id}
        print(f"Connected to your chat (id {chat_id}).")
    else:
        cfg["notifier"] = "ntfy"
        topic = cfg["ntfy"]["topic"] or f"screen-assistant-{secrets.token_hex(8)}"
        cfg["ntfy"]["topic"] = topic
        print("\n1. Install the 'ntfy' app on your phone (App Store / Google Play).")
        print("2. Tap + (subscribe to topic) and enter exactly this topic name:")
        print(f"\n      {topic}\n")
        print("   Keep it secret - anyone who knows it can read your answers.")
        input("Press Enter once you have subscribed...")

    live = ask("\nStart with live mode on? (y/n)", "y" if cfg["modes"]["watch"] else "n")
    cfg["modes"]["watch"] = live.lower().startswith("y")
    save_config(cfg)
    print(f"\nSaved {CONFIG_PATH}")
    make_notifier(cfg).send("Screen Assistant", "Setup complete - answers will arrive here.")
    print("Sent a test message to your phone. Setup done!")


# --------------------------------------------------------------------------- main

def setup_logging() -> None:
    handlers: list[logging.Handler] = [logging.FileHandler(LOG_PATH, encoding="utf-8")]
    if sys.stdout is not None:  # pythonw has no console
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpx2", "anthropic", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    if command in ("-h", "--help", "help"):
        print(__doc__)
        return
    if command == "setup":
        setup()
        return
    setup_logging()
    cfg = load_config()
    if not CONFIG_PATH.exists() and command != "once":
        log.error("No config.json yet - run: python screen_assistant.py setup")
        sys.exit(1)
    if command == "test":
        make_notifier(cfg).send("Screen Assistant", "Test message - it works!")
        log.info("Test message sent.")
    elif command == "once":
        App(cfg).answer_now()
    elif command == "run":
        App(cfg).run()
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
