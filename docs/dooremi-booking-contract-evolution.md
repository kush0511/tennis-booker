# Dooremi booking contract evolution

This is a sanitized record of the three captured booking contracts. It contains
no bearer tokens, cookies, credentials, personal data, or booking details.

| Revision | Mobile identity | Preview | Create | Material change |
| --- | --- | --- | --- | --- |
| 1 | `LifeUp/1` on iOS CFNetwork | `orderPreview` | `createOrderV2` | Initial captured two-step booking flow. |
| 2 | `okhttp/4.9.2` | `orderPreview` | `createOrderV2` | Transport identity changed; fee-bearing previews could add `paymentType: ""`. |
| 3 | `Dooremi/14` on iOS CFNetwork | `orderPreviewV2` | `createOrderV3` | Both endpoint generations advanced; the payload remained `eventDay` plus `bookingOrderFacilityList`. |

Revision 3 was reverified from the successful 2 September 2026 HAR. Its create
request contained no payment field for a fee-free tennis slot and returned a
confirmed booking order.

## What can be forecast

There are only two endpoint families and one observed suffix transition, so an
exact next endpoint cannot be established statistically. If Dooremi continues
the only observed naming sequence, the candidates would be `orderPreviewV3`
and `createOrderV4`. This is a low-confidence hypothesis, never an endpoint the
booker should call automatically.

The stronger pattern is coordinated mobile-contract migration: the transport
identity or session changes first or alongside a preview/create endpoint bump,
while the core booking payload has remained stable. Court Signal therefore
monitors the App Store version and exercises login, history, availability, and
read-only preview. A genuine version or unknown contract change stays locked
until a current HAR confirms both the preview and create calls. Guessed create
endpoints must never be probed because a successful guess could place a real
booking.
