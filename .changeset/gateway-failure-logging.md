---
"cf-open-agents-api": patch
---

Log why a model gateway stream failed. When the provider errors or its output ends without a finish, the gateway still answers the runtime with `model_output_failed` (which Codex reports as `connection_failed`), but it now logs `Model output failed` with the registry model name, the finish reason and the provider's error line, such as Workers AI's "Service temporarily at capacity". Request and response bodies are never logged.
