# Vendored third-party assets — `pageagent/`

## page-agent.iife.js — npm package `page-agent` v1.12.4

Upstream: https://github.com/alibaba/page-agent
License: MIT (see below).
Local modifications (both listed in the file header):
 1. The demo bundle's `autoInit` flag is forced off so the script never
    self-instantiates (the upstream default for tag-less injection is to
    connect to a Mainland-China demo LLM). The host app instantiates
    `window.PageAgent` explicitly via `bootstrap.js`.
 2. The top-level CSS injection appends to `(document.head ||
    document.documentElement)` instead of `document.head` — at true document
    start `<head>` is not parsed yet, and the upstream code crashed before
    `window.PageAgent` was ever assigned.

```
MIT License

Copyright (c) Alibaba PageAgent contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The upstream bundle's DOM-processing components and agent prompt are derived
from [browser-use](https://github.com/browser-use/browser-use) (MIT License,
(c) 2024 Gregor Zunic), as acknowledged by the page-agent project.
