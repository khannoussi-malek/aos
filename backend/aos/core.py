"""Shared config, Redis key names, the telemetry model and the pure logic (easy to unit test)."""
import os
import time
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

# Redis keys
TM_STREAM = "tm:raw"            # simulator -> ingest (telemetry)
TC_STREAM = "tc:queue"          # api -> simulator (telecommands)
EVENTS_STREAM = "events"        # ingest -> api (alarms, gaps)
STATE_HASH = "tm:state"         # latest value + limit state per parameter
LAST_SEQ_KEY = "ingest:last_seq"
ACKED_SET = "events:acked"
GROUP = "ingest"
TS_RETENTION_MS = 24 * 3600 * 1000

LIMITS: dict[str, dict] = yaml.safe_load((Path(__file__).parent / "limits.yaml").read_text())
PARAMS = list(LIMITS)

Level = Literal["nominal", "yellow", "red"]
Mode = Literal["IDLE", "TEST", "REENTRY"]
FAULTS = ("leak", "freeze", "overheat", "dropout")


def now_ms() -> int:
    return int(time.time() * 1000)


def ts_key(param: str) -> str:
    return f"ts:{param}"


def cmd_key(cmd_id: str) -> str:
    return f"cmd:{cmd_id}"


MIN_BUCKET_MS = 100   # the simulator sends at 10 Hz: a smaller bucket adds nothing


def history_bucket_ms(span_ms: int, points: int) -> int:
    """Bucket size so a time window returns at most `points` points (about one per chart pixel)."""
    return max(MIN_BUCKET_MS, -(-span_ms // points))   # ceil division


class Sample(BaseModel):
    """One telemetry frame. Values the simulator sends, validated on ingest."""
    seq: int
    t: int                        # vehicle time, epoch ms
    mode: Mode
    last_cmd: str = ""            # id of the last command the vehicle executed
    battery_v: float
    cabin_kpa: float
    temp_cabin_c: float
    temp_avionics_c: float
    temp_battery_c: float
    rate_x_dps: float
    rate_y_dps: float
    rate_z_dps: float

    def values(self) -> dict[str, float]:
        return {p: getattr(self, p) for p in PARAMS}


RANK = {"nominal": 0, "yellow": 1, "red": 2}
HYSTERESIS = 0.03   # to clear an alarm the value must be 3% of the band width back inside the limit


def classify(value: float, limit: dict, shrink: float = 0.0) -> Level:
    def inside(band):
        lo, hi = limit[band]
        margin = (hi - lo) * shrink
        return lo + margin <= value <= hi - margin
    if not inside("red"):
        return "red"
    return "nominal" if inside("yellow") else "yellow"


def check_seq(seq: int, last_seq: int | None) -> tuple[bool, int]:
    """Returns (is_new, missed). Duplicates and replays are dropped, so ingest is idempotent."""
    if last_seq is None:
        return True, 0
    if seq <= last_seq:
        return False, 0
    return True, seq - last_seq - 1


def transitions(values: dict[str, float], previous: dict[str, Level]) -> list[tuple[str, Level, float]]:
    """Limit-state changes only, so an out-of-limit value raises one alarm, not one per sample."""
    out = []
    for param, value in values.items():
        prev = previous.get(param, "nominal")
        level = classify(value, LIMITS[param])
        if RANK[level] < RANK[prev]:                       # getting better: apply hysteresis so noise can't flap it
            level = max(level, classify(value, LIMITS[param], HYSTERESIS), key=RANK.get)
        if level != prev:
            out.append((param, level, value))
    return out
