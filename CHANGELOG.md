# Change Log

## 0.0.34

- Fixed Ollama availability handling by distinguishing unreachable Ollama (`OLLAMA_UNAVAILABLE`) from reachable-but-empty model discovery (`MODEL_NOT_FOUND`).
- Improved user-facing error messages in chat and command actions for health/model selection failures.
- Added regression tests for model discovery fallback and availability classification.

## 0.0.1

- Initial MVP scaffold for the Ayla Local Agent chat participant.
