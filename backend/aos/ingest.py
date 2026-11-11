"""Ingest worker: reads telemetry through a Redis consumer group, validates it, detects gaps,
checks limits, stores history in Redis TimeSeries and raises alarm events on limit transitions.

Crash-safe: an entry is acknowledged (XACK) only after it is processed, and pending entries are
re-read on start-up. Idempotent: frames are deduplicated by sequence number.
"""
import json

import redis
from pydantic import ValidationError

from .core import (EVENTS_STREAM, GROUP, LAST_SEQ_KEY, LIMITS, PARAMS, REDIS_URL, STATE_HASH,
                   TM_STREAM, TS_RETENTION_MS, Level, Sample, check_seq, cmd_key, now_ms, transitions, ts_key)

CONSUMER = "ingest-1"


def setup(r: redis.Redis) -> None:
    try:
        r.xgroup_create(TM_STREAM, GROUP, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise
    for p in PARAMS:
        if not r.exists(ts_key(p)):
            r.ts().create(ts_key(p), retention_msecs=TS_RETENTION_MS, duplicate_policy="last",
                          labels={"param": p, "unit": LIMITS[p]["unit"]})


def event(pipe, kind: str, level: str, message: str, **extra) -> None:
    pipe.xadd(EVENTS_STREAM, {"t": now_ms(), "kind": kind, "level": level, "message": message, **extra},
              maxlen=10_000, approximate=True)


def previous_levels(r: redis.Redis) -> dict[str, Level]:
    return {p: json.loads(v)["level"] for p, v in r.hgetall(STATE_HASH).items() if p in LIMITS}   # skips "mode"


def process(r: redis.Redis, fields: dict, levels: dict[str, Level]) -> None:
    try:
        s = Sample.model_validate(fields)
    except ValidationError as e:
        pipe = r.pipeline()
        event(pipe, "invalid", "yellow", f"invalid frame dropped: {e.error_count()} error(s)")
        pipe.execute()
        return
    last = r.get(LAST_SEQ_KEY)
    is_new, missed = check_seq(s.seq, int(last) if last else None)
    if not is_new:
        return                                             # duplicate or replay: nothing to do
    rx = now_ms()
    values = s.values()
    pipe = r.pipeline()
    if missed:
        event(pipe, "gap", "yellow", f"telemetry gap: {missed} frame(s) lost before seq {s.seq}")
    changes = transitions(values, levels)
    for param, level, value in changes:
        name, unit = LIMITS[param]["label"], LIMITS[param]["unit"]
        msg = f"{name} back to nominal ({value} {unit})" if level == "nominal" else f"{name} {level.upper()}: {value} {unit}"
        event(pipe, "limit", level, msg, param=param, value=value)
    levels.update({param: level for param, level, _ in changes})
    for param, value in values.items():
        level = levels.get(param, "nominal")
        pipe.ts().add(ts_key(param), s.t, value)
        pipe.hset(STATE_HASH, param, json.dumps({"v": value, "level": level, "t": s.t, "rx": rx}))
    pipe.hset(STATE_HASH, "mode", json.dumps({"v": s.mode, "t": s.t, "rx": rx}))
    if s.last_cmd:
        pipe.hset(cmd_key(s.last_cmd), "status", "verified")
    pipe.set(LAST_SEQ_KEY, s.seq)
    pipe.execute()


def main() -> None:
    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    setup(r)
    levels = previous_levels(r)
    cursor = "0"                                           # first re-read our own pending entries
    print("ingest: consuming", TM_STREAM, "as", GROUP, flush=True)
    while True:
        resp = r.xreadgroup(GROUP, CONSUMER, {TM_STREAM: cursor}, count=200, block=1000)
        entries = resp[0][1] if resp else []
        if cursor == "0" and not entries:
            cursor = ">"                                   # pending drained: switch to new entries
            continue
        for entry_id, fields in entries:
            process(r, fields, levels)
            r.xack(TM_STREAM, GROUP, entry_id)


if __name__ == "__main__":
    main()
