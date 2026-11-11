import pytest
from pydantic import ValidationError

from aos.core import LIMITS, Sample, check_seq, classify, history_bucket_ms, transitions

PRESSURE = LIMITS["cabin_kpa"]   # yellow 97-104, red 94-106


@pytest.mark.parametrize("value, level", [
    (101.3, "nominal"), (97.0, "nominal"), (104.0, "nominal"),   # band edges are inside
    (96.9, "yellow"), (104.5, "yellow"),
    (93.9, "red"), (106.1, "red"),
])
def test_classify(value, level):
    assert classify(value, PRESSURE) == level


def test_check_seq_first_frame():
    assert check_seq(1, None) == (True, 0)


def test_check_seq_detects_gap():
    assert check_seq(15, 10) == (True, 4)


@pytest.mark.parametrize("seq", [10, 3])
def test_check_seq_drops_duplicates_and_replays(seq):
    assert check_seq(seq, 10) == (False, 0)


def test_transitions_only_on_change():
    values = {"cabin_kpa": 95.0, "battery_v": 28.0}
    assert transitions(values, {}) == [("cabin_kpa", "yellow", 95.0)]
    assert transitions(values, {"cabin_kpa": "yellow"}) == []                      # still yellow: no new alarm
    assert transitions({"cabin_kpa": 101.0}, {"cabin_kpa": "yellow"}) == [("cabin_kpa", "nominal", 101.0)]


def frame(**overrides):
    base = dict(seq=1, t=0, mode="IDLE", battery_v=28, cabin_kpa=101.3, temp_cabin_c=21, temp_avionics_c=30,
                temp_battery_c=22, rate_x_dps=0, rate_y_dps=0, rate_z_dps=0)
    return {**base, **overrides}


def test_sample_parses_redis_strings():
    s = Sample.model_validate({k: str(v) for k, v in frame().items()})   # Redis returns strings
    assert s.seq == 1 and s.cabin_kpa == 101.3


def test_sample_rejects_bad_mode():
    with pytest.raises(ValidationError):
        Sample.model_validate(frame(mode="PANIC"))


def test_hysteresis_stops_flapping():
    # yellow band is 97-104 (width 7, 3% = 0.21): 97.1 is inside but too close to clear the alarm
    assert transitions({"cabin_kpa": 97.1}, {"cabin_kpa": "yellow"}) == []
    assert transitions({"cabin_kpa": 97.3}, {"cabin_kpa": "yellow"}) == [("cabin_kpa", "nominal", 97.3)]


@pytest.mark.parametrize("span_ms, points, bucket", [
    (120_000, 600, 200),            # 2 min live view
    (10_000, 600, 100),             # deep zoom: never below the 10 Hz frame period
    (86_400_000, 600, 144_000),     # 24 h: 600 points, not 864,000
    (1_000_001, 1000, 1001),        # rounds up, never down
])
def test_history_bucket(span_ms, points, bucket):
    assert history_bucket_ms(span_ms, points) == bucket
