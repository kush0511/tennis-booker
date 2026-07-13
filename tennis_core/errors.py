"""Shared Tennis Booker error types.

These exceptions describe booking-domain and Dooremi outcomes without taking a
dependency on a particular presentation or host platform.
"""


class BookerError(Exception):
    pass


class InputError(BookerError):
    pass


class APIError(BookerError):
    pass


class AuthenticationError(APIError):
    pass


class NetworkTimeoutError(APIError):
    pass


class ConnectivityError(APIError):
    pass


class RateLimitError(APIError):
    pass


class PartialBookingError(APIError):
    def __init__(self, results, errors, submit_skew_ms):
        self.results = results
        self.errors = errors
        self.submit_skew_ms = submit_skew_ms
        confirmed = len(results)
        total = confirmed + len(errors)
        super().__init__(
            "{} of {} requests returned a success. Refresh My Bookings before "
            "retrying; one or more requests failed or had an ambiguous "
            "response.".format(confirmed, total)
        )

    @property
    def booking_order_ids(self):
        return [
            item["result"].get("booking_order_id")
            for item in self.results
            if item["result"].get("booking_order_id") is not None
        ]


class CancellationError(APIError):
    pass


class RebookingSubmissionError(APIError):
    pass


class StoreError(BookerError):
    pass


class SystemError(BookerError):
    pass
