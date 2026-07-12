"""Platform-neutral configuration shared by all Tennis Booker surfaces."""

import dataclasses
import datetime as dt


SGT = dt.timezone(dt.timedelta(hours=8), name="SGT")


@dataclasses.dataclass
class Config:
    facility_id: int = 0
    facility_category_id: int = 0
    booking_lead_days: int = 14
    release_hour: int = 12
    release_minute: int = 0
    wake_lead_seconds: int = 180
    arming_window_seconds: int = 240
    grace_period_seconds: int = 300
    cancellation_lead_seconds: int = 15
    fire_delay_milliseconds: int = 10
    max_sessions_per_booking: int = 6

    @classmethod
    def from_dict(cls, value):
        allowed = {field.name for field in dataclasses.fields(cls)}
        return cls(**{key: item for key, item in value.items() if key in allowed})
