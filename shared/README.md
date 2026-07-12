# Shared booking contract

`booking-contract.json` is the cross-runtime contract for both implementations:

- the Python command-line and Textual interfaces;
- the TypeScript ChatGPT Sites application.

It contains non-secret protocol constants, scheduling defaults, and durable
status names. Credentials, facility identifiers, schedules, and booking results
must never be added here.

Python remains the macOS-native execution runtime. Sites implements the same
domain and safety rules in TypeScript because the Sites worker runtime cannot
import Python. Parity tests in both runtimes protect this boundary.
