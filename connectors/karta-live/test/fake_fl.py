"""Simulated FL Studio for tests: runs the real device_KartaLive.py with stand-in FL modules.
The transport moves in real time while playing; commands from Karta Live really seek/play/stop it.
Usage: python3 fake_fl.py <script folder> <seconds> [bpm]"""
import importlib.util, json, os, sys, time, types

folder, seconds = sys.argv[1], float(sys.argv[2])
bpm = float(sys.argv[3]) if len(sys.argv) > 3 else 96.0
FL = {"playing": False, "pos0": 0.0, "t0": time.time(), "hints": []}

def pos_ms():
    return int(FL["pos0"] + ((time.time() - FL["t0"]) * 1000 if FL["playing"] else 0))
def set_pos(ms):
    FL["pos0"], FL["t0"] = float(ms), time.time()
def start():
    if not FL["playing"]: FL["pos0"], FL["t0"], FL["playing"] = float(pos_ms()), time.time(), True
def stop():
    if FL["playing"]: FL["pos0"], FL["playing"] = float(pos_ms()), False

def mod(name, **f):
    m = types.ModuleType(name); [setattr(m, k, v) for k, v in f.items()]; sys.modules[name] = m
mod("general", getRecPPQ=lambda: 96, getVersion=lambda: 36, getChangedFlag=lambda: 0)
mod("mixer", getCurrentTempo=lambda asInt=False: bpm)
mod("ui", getVersion=lambda mode=4: "2025.1 (sim)", getProgTitle=lambda: "Spanish Town Dusk - FL Studio 2025", setHintMsg=lambda m: FL["hints"].append(m))
mod("transport", isPlaying=lambda: FL["playing"], isRecording=lambda: False, getLoopMode=lambda: 1,
    getSongPos=lambda mode=-1: pos_ms() if mode == 0 else pos_ms() * 96 * int(bpm) // 60000,
    getSongLength=lambda mode: 60000, getSongPosHint=lambda: "", start=start, stop=stop,
    setSongPos=lambda p, mode=-1: set_pos(p))

spec = importlib.util.spec_from_file_location("device_KartaLive", os.path.join(folder, "device_KartaLive.py"))
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
d.OnInit()
start()  # the producer hits play
end = time.time() + seconds
while time.time() < end:
    d.OnIdle()
    time.sleep(0.02)
    with open(os.path.join(folder, "fake_fl_log.json"), "w") as f:
        json.dump({"hints": FL["hints"], "posMs": pos_ms(), "playing": FL["playing"]}, f)
d.OnDeInit()
