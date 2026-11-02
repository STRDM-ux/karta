# name=Karta Live
# url=https://karta.strdm.io/fl
#
# Karta Live for FL Studio.
#
# Shares what FL Studio is doing (tempo, playhead, play/stop, project title, song length) with the
# Karta Live app on this computer, so it can show Higgsfield's visuals for your beat in time with
# the playlist, and lets Karta Live send a few things back (seek, play/stop, a message in the hint bar).
#
# FL Studio scripts can't open network connections, so the two talk through two small files in this
# script's folder: karta_state.json (written here, ~20 times a second while anything changes) and
# karta_cmd.json (written by Karta Live, read and deleted here).
#
# Install: Karta Live puts this folder in  Documents/Image-Line/FL Studio/Settings/Hardware/Karta Live
# Then in FL Studio: Options > MIDI settings > pick any input (a loopMIDI / IAC port works if you have
# no controller) > Controller type: "Karta Live". The script only needs to be attached to a port to run.

import json
import os
import time

import general
import mixer
import transport
import ui

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:  # very old FL builds don't set __file__
    HERE = os.path.join(os.path.expanduser("~"), "Documents", "Image-Line", "FL Studio", "Settings", "Hardware", "Karta Live")

STATE_FILE = os.path.join(HERE, "karta_state.json")
STATE_TMP = os.path.join(HERE, "karta_state.tmp")
CMD_FILE = os.path.join(HERE, "karta_cmd.json")

SONGLENGTH_MS = 0
SONGLENGTH_ABSTICKS = 2

WRITE_EVERY = 0.05      # seconds between state writes while playing
HEARTBEAT = 1.0         # seconds between writes when nothing changes, so Karta Live knows FL is open
CMD_EVERY = 0.1         # seconds between checks for commands

_last_write = 0.0
_last_cmd = 0.0
_last_state = None
_seq = 0


def _safe(fn, default):
    try:
        return fn()
    except Exception:
        return default


def read_state():
    """Everything Karta Live needs to stay in time with FL Studio."""
    ppq = _safe(general.getRecPPQ, 96) or 96
    tempo = _safe(lambda: mixer.getCurrentTempo(), 0.0)
    # older API versions return tempo * 1000 as an int
    if tempo > 1000:
        tempo = tempo / 1000.0
    return {
        "app": "fl-studio",
        "script": 1,
        "api": _safe(general.getVersion, 0),
        "flVersion": _safe(lambda: ui.getVersion(4), ""),
        "title": _safe(ui.getProgTitle, ""),
        "playing": bool(_safe(transport.isPlaying, False)),
        "recording": bool(_safe(transport.isRecording, False)),
        "loopMode": _safe(transport.getLoopMode, 0),  # 0 = pattern, 1 = song
        "tempo": round(float(tempo), 3),
        "ppq": ppq,
        "posMs": _safe(lambda: transport.getSongPos(SONGLENGTH_MS), 0),
        "posTicks": _safe(lambda: transport.getSongPos(SONGLENGTH_ABSTICKS), 0),
        "songMs": _safe(lambda: transport.getSongLength(SONGLENGTH_MS), 0),
        "hint": _safe(transport.getSongPosHint, ""),
        "unsaved": _safe(general.getChangedFlag, 0) != 0,
    }


def write_state(force=False):
    global _last_write, _last_state, _seq
    now = time.time()
    state = read_state()
    changed = state != _last_state
    due = (state["playing"] and now - _last_write >= WRITE_EVERY) or (changed and now - _last_write >= WRITE_EVERY) or now - _last_write >= HEARTBEAT
    if not (force or due):
        return
    _seq += 1
    out = dict(state, seq=_seq, at=int(now * 1000))
    try:
        with open(STATE_TMP, "w") as f:
            json.dump(out, f)
        os.replace(STATE_TMP, STATE_FILE)  # atomic, so Karta Live never reads half a file
        _last_write = now
        _last_state = state
    except Exception:
        pass


def handle(cmd):
    """Commands from Karta Live. Unknown ones are ignored."""
    kind = cmd.get("type")
    if kind == "hint" and cmd.get("text"):
        ui.setHintMsg(str(cmd["text"])[:120])
    elif kind == "play" and not transport.isPlaying():
        transport.start()
    elif kind == "stop" and transport.isPlaying():
        transport.stop()
    elif kind == "toggle":
        transport.start() if not transport.isPlaying() else transport.stop()
    elif kind == "seek" and "ms" in cmd:
        # jump the playhead (song mode) so the beat and the preview line up at a section
        transport.setSongPos(max(0, int(cmd["ms"])), SONGLENGTH_MS)


def read_commands():
    global _last_cmd
    now = time.time()
    if now - _last_cmd < CMD_EVERY:
        return
    _last_cmd = now
    if not os.path.exists(CMD_FILE):
        return
    try:
        with open(CMD_FILE, "r") as f:
            data = json.load(f)
    except Exception:
        data = None  # half-written or corrupt: drop it rather than retry forever
    try:
        os.remove(CMD_FILE)
    except Exception:
        pass
    if data is None:
        return
    for cmd in data if isinstance(data, list) else [data]:
        if isinstance(cmd, dict):
            try:
                handle(cmd)
            except Exception:
                pass
    write_state(force=True)


def OnInit():
    try:
        os.makedirs(HERE, exist_ok=True)
    except Exception:
        pass
    write_state(force=True)
    _safe(lambda: ui.setHintMsg("Karta Live connected"), None)


def OnDeInit():
    try:
        state = dict(read_state(), playing=False, closed=True, at=int(time.time() * 1000))
        with open(STATE_TMP, "w") as f:
            json.dump(state, f)
        os.replace(STATE_TMP, STATE_FILE)
    except Exception:
        pass


def OnIdle():
    write_state()
    read_commands()


def OnRefresh(flags):
    write_state(force=True)


def OnUpdateBeatIndicator(value):
    write_state()


def OnProjectLoad(status):
    write_state(force=True)
