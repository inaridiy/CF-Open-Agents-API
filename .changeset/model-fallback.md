---
"cf-open-agents-api": minor
---

Add `fallbackModel(candidates)` to `cf-open-agents-api/models`: one registry entry backed by several models tried in order, for providers whose models go "temporarily at capacity" one at a time. To make that possible, `aiSDKModel` now waits for the provider's first token before committing a response: an error before any output fails the request with the new `ModelUpstreamRejected` (503 `model_upstream_rejected`) instead of a 200 stream that ends in `response.failed`, and a `nativeModel` answer of 429 or 5xx also moves the chain on. Output that already started is never retried on another model.
