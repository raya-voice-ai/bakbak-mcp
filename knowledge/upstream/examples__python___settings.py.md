---
id: examples/python/_settings.py
title: Python example: _settings.py
description: Settings shared by the Python examples (voice, language, model).
url: https://github.com/raya-voice-ai/bakbak-python/blob/main/examples/_settings.py
---

# examples/python/_settings.py

A runnable example from bakbak-python. Settings shared by the Python examples (voice, language, model).

Source: https://github.com/raya-voice-ai/bakbak-python/blob/main/examples/_settings.py

```python
"""Settings the examples share, from the environment.

BAKBAK_API_KEY is required (the client reads it). BAKBAK_BASE_URL, and the
voice settings below, are optional.
"""

from __future__ import annotations

import os

VOICE_ID = os.environ.get("BAKBAK_VOICE_ID", "009ae8b5-4a03-492d-af1c-3055989ac734")  # Anika M1
LANGUAGE = os.environ.get("BAKBAK_LANGUAGE", "hi")
MODEL = os.environ.get("BAKBAK_MODEL", "m1")
```
