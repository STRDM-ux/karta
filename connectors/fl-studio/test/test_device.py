"""Runs device_KartaLive.py against stand-in FL Studio modules (FL's own aren't importable outside FL)."""
import importlib.util, json, os, shutil, sys, tempfile, time, types, unittest

FL = {"playing": False, "pos": 0, "tempo": 96.0, "hint": ""}

def fake(name, **fns):
    m = types.ModuleType(name)
    for k, v in fns.items():
        setattr(m, k, v)
    sys.modules[name] = m

fake("general", getRecPPQ=lambda: 96, getVersion=lambda: 36, getChangedFlag=lambda: 1)
fake("mixer", getCurrentTempo=lambda asInt=False: FL["tempo"])
fake("ui", getVersion=lambda mode=4: "2025.1", getProgTitle=lambda: "Spanish Town Dusk - FL Studio 2025", setHintMsg=lambda m: FL.__setitem__("hint", m))
fake("transport",
     isPlaying=lambda: FL["playing"], isRecording=lambda: False, getLoopMode=lambda: 1,
     getSongPos=lambda mode=-1: FL["pos"] if mode == 0 else FL["pos"] * 96 * 96 // 60000,
     getSongLength=lambda mode: 180000 if mode == 0 else 0, getSongPosHint=lambda: "5:1:00",
     start=lambda: FL.__setitem__("playing", True), stop=lambda: FL.__setitem__("playing", False),
     setSongPos=lambda p, mode=-1: FL.__setitem__("pos", p))

class DeviceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        src = os.path.join(os.path.dirname(__file__), "..", "Karta Live", "device_KartaLive.py")
        shutil.copy(src, self.dir)
        spec = importlib.util.spec_from_file_location("device_KartaLive", os.path.join(self.dir, "device_KartaLive.py"))
        self.d = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.d)
        FL.update(playing=False, pos=0, tempo=96.0, hint="")

    def state(self):
        with open(os.path.join(self.dir, "karta_state.json")) as f:
            return json.load(f)

    def test_init_writes_state_and_hint(self):
        self.d.OnInit()
        s = self.state()
        self.assertEqual(s["tempo"], 96.0)
        self.assertEqual(s["songMs"], 180000)
        self.assertFalse(s["playing"])
        self.assertIn("Spanish Town Dusk", s["title"])
        self.assertEqual(FL["hint"], "Karta Live connected")

    def test_playing_updates_position_and_old_tempo_format(self):
        self.d.OnInit()
        FL.update(playing=True, pos=12345, tempo=140000)  # old API: tempo * 1000
        time.sleep(0.06)
        self.d.OnIdle()
        s = self.state()
        self.assertTrue(s["playing"])
        self.assertEqual(s["posMs"], 12345)
        self.assertEqual(s["tempo"], 140.0)

    def test_commands_seek_play_hint(self):
        self.d.OnInit()
        with open(os.path.join(self.dir, "karta_cmd.json"), "w") as f:
            json.dump([{"type": "seek", "ms": 20508}, {"type": "play"}, {"type": "hint", "text": "Karta: hook shot ready"}, {"type": "nonsense"}], f)
        time.sleep(0.11)
        self.d.OnIdle()
        self.assertEqual(FL["pos"], 20508)
        self.assertTrue(FL["playing"])
        self.assertEqual(FL["hint"], "Karta: hook shot ready")
        self.assertFalse(os.path.exists(os.path.join(self.dir, "karta_cmd.json")), "command file is consumed")
        self.assertEqual(self.state()["posMs"], 20508)

    def test_bad_command_file_is_ignored(self):
        self.d.OnInit()
        with open(os.path.join(self.dir, "karta_cmd.json"), "w") as f:
            f.write("{not json")
        time.sleep(0.11)
        self.d.OnIdle()  # must not raise inside FL
        self.assertFalse(os.path.exists(os.path.join(self.dir, "karta_cmd.json")), "corrupt file is dropped")

    def test_deinit_marks_closed(self):
        self.d.OnInit()
        self.d.OnDeInit()
        self.assertTrue(self.state()["closed"])

if __name__ == "__main__":
    unittest.main()
