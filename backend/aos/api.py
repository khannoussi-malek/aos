"""HTTP API for the console: live values (SSE), history, alarms and commands."""
import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from typing import Literal

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, model_validator

from .core import (ACKED_SET, EVENTS_STREAM, FAULTS, LIMITS, PARAMS, REDIS_URL, STATE_HASH, TC_STREAM,
                   TS_RETENTION_MS, cmd_key, history_bucket_ms, now_ms, ts_key)

LIVE_PERIOD_S = 0.25
CMD_TIMEOUT_MS = 5000
CMD_LIST = "cmd:recent"

r = aioredis.Redis.from_url(REDIS_URL, decode_responses=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await r.aclose()


app = FastAPI(title="aos", lifespan=lifespan)


@app.get("/api/parameters")
async def parameters():
    return {"params": [{"name": p, **LIMITS[p]} for p in PARAMS], "faults": FAULTS}


async def snapshot() -> dict:
    state = {k: json.loads(v) for k, v in (await r.hgetall(STATE_HASH)).items()}
    events = await r.xrevrange(EVENTS_STREAM, count=200)
    acked = await r.smembers(ACKED_SET)
    unacked = sum(1 for eid, e in events if e["level"] != "nominal" and eid not in acked)
    return {"now": now_ms(), "state": state, "unacked": unacked}


@app.get("/api/live")
async def live():
    """Server-Sent Events: the latest value of every parameter, 4 times per second."""
    async def stream():
        while True:
            yield f"data: {json.dumps(await snapshot())}\n\n"
            await asyncio.sleep(LIVE_PERIOD_S)
    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/history")
async def history(param: str, span_ms: int = Query(120_000, ge=10_000, le=TS_RETENTION_MS),
                  end: int | None = Query(None, ge=0), points: int = Query(600, ge=10, le=2000)):
    """Window [end - span_ms, end] (end defaults to now), downsampled on the server to at most `points`
    buckets. Each point is [t, avg, min, max]: min/max keep a short spike visible in a long window."""
    if param not in LIMITS:
        raise HTTPException(404, f"unknown parameter {param}")
    end = end or now_ms()
    bucket = history_bucket_ms(span_ms, points)
    avg, lo, hi = await asyncio.gather(*(
        r.ts().range(ts_key(param), end - span_ms, end, aggregation_type=agg, bucket_size_msec=bucket)
        for agg in ("avg", "min", "max")))
    rows = [[t, round(float(a), 3), round(float(l), 3), round(float(h), 3)]
            for (t, a), (_, l), (_, h) in zip(avg, lo, hi)]
    return {"param": param, "bucket_ms": bucket, "points": rows}


@app.get("/api/events")
async def events(count: int = Query(50, ge=1, le=500)):
    entries = await r.xrevrange(EVENTS_STREAM, count=count)
    acked = await r.smembers(ACKED_SET)
    return [{"id": eid, **e, "acked": eid in acked or e["level"] == "nominal"} for eid, e in entries]


@app.post("/api/events/{event_id}/ack")
async def ack(event_id: str):
    if not await r.xrange(EVENTS_STREAM, event_id, event_id):
        raise HTTPException(404, "unknown event")
    await r.sadd(ACKED_SET, event_id)
    return {"id": event_id, "acked": True}


class Command(BaseModel):
    name: Literal["SET_MODE", "INJECT_FAULT", "CLEAR_FAULTS"]
    arg: str = ""

    @model_validator(mode="after")
    def check_arg(self):
        allowed = {"SET_MODE": ("IDLE", "TEST", "REENTRY"), "INJECT_FAULT": FAULTS, "CLEAR_FAULTS": ("",)}
        if self.arg not in allowed[self.name]:
            raise ValueError(f"{self.name} takes one of {allowed[self.name]}")
        return self


@app.post("/api/commands", status_code=201)
async def send_command(cmd: Command):
    cmd_id = uuid.uuid4().hex[:8]
    record = {"id": cmd_id, "name": cmd.name, "arg": cmd.arg, "sent": now_ms(), "status": "sent"}
    pipe = r.pipeline()
    pipe.hset(cmd_key(cmd_id), mapping=record)
    pipe.lpush(CMD_LIST, cmd_id)
    pipe.ltrim(CMD_LIST, 0, 49)
    pipe.xadd(TC_STREAM, {"id": cmd_id, "name": cmd.name, "arg": cmd.arg}, maxlen=1000, approximate=True)
    await pipe.execute()
    return record


@app.get("/api/commands")
async def commands():
    """Recent commands. sent -> received (vehicle got it) -> verified (seen in telemetry), else failed."""
    out = []
    for cmd_id in await r.lrange(CMD_LIST, 0, 19):
        c = await r.hgetall(cmd_key(cmd_id))
        # never received in 5 s -> failed; received but never seen in telemetry in 15 s (e.g. during a dropout) -> failed
        timeout = {"sent": CMD_TIMEOUT_MS, "received": 3 * CMD_TIMEOUT_MS}.get(c.get("status", ""))
        if c and timeout and now_ms() - int(c["sent"]) > timeout:
            c["status"] = "failed"
            await r.hset(cmd_key(cmd_id), "status", "failed")
        if c:
            out.append(c)
    return out
