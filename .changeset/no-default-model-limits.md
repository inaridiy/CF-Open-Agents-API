---
"cf-open-agents-api": patch
---

`aiSDKModel` and `openAICompatibleModel` no longer impose a 120-second request timeout or an 8192-token output cap of their own. Unset, the provider's own limits apply and the turn deadline bounds the request; `timeoutMs` and `maxOutputTokens` remain available as deployment-side bounds, and a harness request's `max_output_tokens` is still honoured. Reasoning models on Workers AI, which routinely think past 8192 tokens and two minutes, were failing every large task as `connection_failed` because of these defaults.
