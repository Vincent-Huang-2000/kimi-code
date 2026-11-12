---
"@moonshot-ai/kimi-code": patch
---

Experimental /deep analysis now ends the turn with a `/deep --continue` prompt when a clarification question is dismissed or fails, instead of reporting an internal `phase_denied` error. The Intent tool schema now states that every requirement and decision needs at least one source quotation, and source errors name the offending record.
