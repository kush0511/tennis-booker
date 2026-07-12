"""Shared record shapes and pure Dooremi wire-contract helpers."""

import re
from typing import List, Optional, TypedDict

from .domain import schedule_event_times
from .errors import APIError, InputError


SCHEDULE_STATUSES = (
    "pending",
    "running",
    "succeeded",
    "partial",
    "failed",
    "missed",
    "cancelled",
)


class BookingTarget(TypedDict):
    event_day: str
    event_time: str
    facility_id: int


class AvailabilitySlot(TypedDict):
    id: Optional[int]
    facility_id: int
    event_time: str
    available: bool


class Availability(TypedDict):
    facility_id: int
    facility_name: str
    maximum_selectable_slots: int
    slots: List[AvailabilitySlot]


class ScheduleRecord(TypedDict, total=False):
    id: str
    event_day: str
    event_time: str
    event_times: List[str]
    facility_id: int
    facility_category_id: int
    release_at: str
    status: str
    created_at: str
    attempted_at: Optional[str]
    result_message: Optional[str]
    booking_order_id: Optional[int]
    booking_order_ids: List[int]
    booking_targets: List[BookingTarget]
    prepared_targets: List[BookingTarget]
    submitted_targets: List[BookingTarget]
    cancelled_booking_ids: List[int]


def parse_availability_payload(payload, preferred_facility_id):
    if payload.get("status") != 0:
        raise APIError(
            "Dooremi rejected the request ({}): {}".format(
                payload.get("status"), payload.get("msg", "Unknown error")
            )
        )
    facilities = [
        item.get("facility", {})
        for item in (payload.get("content") or [])
        if item.get("facility")
    ]
    facility = next(
        (item for item in facilities if item.get("id") == preferred_facility_id),
        facilities[0] if facilities else None,
    )
    if not facility:
        raise APIError("No facility availability was returned for that date.")
    slots = []
    for item in facility.get("condoBookingFacilityDateBeanList") or []:
        slot = {
            "id": item.get("id"),
            "facility_id": item.get("facilityId", preferred_facility_id),
            "event_time": "{}-{}".format(item.get("startFrom"), item.get("endTo")),
            "available": item.get("state") == 0
            and item.get("bookingOrderId") is None,
        }
        slots.append(slot)
    return {
        "facility_id": facility.get("id", preferred_facility_id),
        "facility_name": facility.get("facilityName", "Tennis court"),
        "maximum_selectable_slots": max(1, facility.get("multiSelectTime") or 1),
        "slots": slots,
    }


def booking_payload(schedule):
    return {
        "eventDay": schedule["event_day"],
        "bookingOrderFacilityList": [
            {
                "facilityId": schedule["facility_id"],
                "eventTime": event_time,
            }
            for event_time in schedule_event_times(schedule)
        ],
    }


def normalize_bearer_token(raw_token):
    token = re.sub(r"^Bearer\s+", "", raw_token.strip(), flags=re.IGNORECASE)
    if not token:
        raise InputError("The Bearer token cannot be empty.")
    return token


def bearer_tokens_from_har(har):
    try:
        entries = har["log"]["entries"]
    except (KeyError, TypeError) as error:
        raise InputError("That file is not a readable HAR capture.") from error
    tokens = set()
    for entry in entries:
        for header in entry.get("request", {}).get("headers", []):
            if header.get("name", "").lower() != "authorization":
                continue
            value = header.get("value", "")
            if value.lower().startswith("bearer "):
                tokens.add(value[7:])
    if not tokens:
        raise InputError("No Bearer Authorization header was found in that HAR.")
    return sorted(tokens)
