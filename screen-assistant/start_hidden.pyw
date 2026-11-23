#!python3.12
# Double-click this file on Windows to start Screen Assistant in the background.
# .pyw files run with pythonw.exe: no console window and nothing on the taskbar,
# only the icon in the system tray ("show hidden icons" arrow). Quit from that icon.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.argv = [sys.argv[0], "run"]

import screen_assistant

screen_assistant.main()
