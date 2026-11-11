"""Fake vehicle / test bench: sends 10 telemetry frames per second and executes commands.

Faults (via INJECT_FAULT): leak (cabin pressure drops), freeze (avionics sensor stuck),
overheat (battery heats up), dropout (10 s of silence: frames are lost, ingest sees the gap).
"""
import random
import time

import redis

from .core import REDIS_URL, TC_STREAM, TM_STREAM, Sample, cmd_key, now_ms

HZ = 10
DT = 1 / HZ
NOMINAL = {
    "battery_v": 28.0, "cabin_kpa": 101.3, "temp_cabin_c": 21.0, "temp_avionics_c": 30.0,
    "temp_battery_c": 22.0, "rate_x_dps": 0.0, "rate_y_dps": 0.0, "rate_z_dps": 0.0,
}
NOISE = {"battery_v": 0.03, "cabin_kpa": 0.05, "temp_cabin_c": 0.02, "temp_avionics_c": 0.05,
         "temp_battery_c": 0.02, "rate_x_dps": 0.05, "rate_y_dps": 0.05, "rate_z_dps": 0.05}
DROPOUT_S = 10


class Vehicle:
    def __init__(self) -> None:
        self.v = dict(NOMINAL)
        self.mode = "IDLE"
        self.faults: set[str] = set()
        self.dropout_until = 0.0
        self.seq = 0
        self.last_cmd = ""

    def step(self) -> None:
        for p, sigma in NOISE.items():
            if p == "temp_avionics_c" and "freeze" in self.faults:
                continue                                   # stuck sensor: value never changes
            target = NOMINAL[p] + (8.0 if p == "temp_avionics_c" and self.mode == "TEST" else 0.0)
            pull = 0.02 * (target - self.v[p])             # drift back toward nominal
            spread = sigma * (8 if p.startswith("rate_") and self.mode == "REENTRY" else 1)
            self.v[p] += pull + random.gauss(0, spread)
        # fault terms cancel the drift-back pull above, so the value keeps moving at a steady rate
        if "leak" in self.faults:
            self.v["cabin_kpa"] -= 0.4 * DT + 0.02 * (NOMINAL["cabin_kpa"] - self.v["cabin_kpa"])
        if "overheat" in self.faults:
            self.v["temp_battery_c"] += 1.0 * DT - 0.02 * (NOMINAL["temp_battery_c"] - self.v["temp_battery_c"])
        self.seq += 1

    def frame(self) -> Sample:
        return Sample(seq=self.seq, t=now_ms(), mode=self.mode, last_cmd=self.last_cmd,
                      **{p: round(x, 3) for p, x in self.v.items()})

    def execute(self, name: str, arg: str) -> None:
        if name == "SET_MODE":
            self.mode = arg
        elif name == "INJECT_FAULT":
            if arg == "dropout":
                self.dropout_until = time.monotonic() + DROPOUT_S
            else:
                self.faults.add(arg)
        elif name == "CLEAR_FAULTS":
            self.faults.clear()
            self.v.update({k: NOMINAL[k] for k in ("cabin_kpa", "temp_battery_c")})


def main() -> None:
    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    veh = Vehicle()
    newest = r.xrevrange(TC_STREAM, count=1)
    last_tc = newest[0][0] if newest else "0-0"           # skip commands sent before start-up
    print("simulator: sending telemetry at", HZ, "Hz", flush=True)
    while True:
        tick = time.monotonic()
        # one command per tick, so each command is echoed in at least one frame and can be verified
        for _, entries in r.xread({TC_STREAM: last_tc}, count=1) or []:
            for entry_id, cmd in entries:
                last_tc = entry_id
                r.hset(cmd_key(cmd["id"]), "status", "received")
                veh.execute(cmd["name"], cmd.get("arg", ""))
                veh.last_cmd = cmd["id"]                    # echoed in telemetry -> ingest marks it verified
        veh.step()
        if time.monotonic() >= veh.dropout_until:          # during dropout frames are produced but lost
            r.xadd(TM_STREAM, veh.frame().model_dump(), maxlen=50_000, approximate=True)
        time.sleep(max(0.0, DT - (time.monotonic() - tick)))


if __name__ == "__main__":
    main()
