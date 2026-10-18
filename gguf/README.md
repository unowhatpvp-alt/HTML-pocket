# MONO · GGUF Studio

A black-and-white, bilingual, entirely frontend GGUF chat application. Served as a separate `/gguf/` page in this GitHub Pages repository.

## Use

1. Open the page over HTTPS in a recent browser. Desktop Chrome or Edge is a good starting point.
2. Choose a local GGUF text-generation model. Select every shard together for a split GGUF.
3. Select Auto, WebGPU, or CPU, configure context and threads, and load the model.
4. Chat locally. Generation can be stopped. Copy messages/code, download code, export Markdown/JSON, or import a JSON conversation.
5. In **Chat history → Chat save location → Choose folder**, select a dedicated local folder and allow read/write access. Existing browser conversations and the current chat are saved there as `mono-chat-<conversation-id>.json`, one file per conversation. The same file is updated as you chat. Folder saving is independent of the browser-history checkbox.

Folder access uses the File System Access API when available (for example desktop Chrome / Edge). The app remembers the directory handle in IndexedDB where supported. On later visits, click **Restore access** if the browser requires permission again. Only the folder name is available to display, not the full operating-system path. Unsupported browsers, including some mobile browsers, retain browser history, JSON download, and JSON import; the browser controls the download destination.

JSON is checkpointed roughly every two seconds during generation and immediately when sending, completing, or stopping. Watch the save status and wait for **Saved to folder** before closing the page. An abrupt browser crash, tab termination, or lost permission can interrupt the last save; asynchronous writes are not guaranteed during page shutdown. **Save all now** retries a current backup, and errors expose **Retry saving** / **Restore access**. Clearing browser history or stopping folder saving does not delete any JSON files. Import a saved JSON through **Import JSON chat** to continue it as a new conversation; the app does not scan or auto-import other files in the directory.

The application has no model-parameter-count quota or model-file-size cap. This is **not** a promise that every size, architecture, or quantization will work. Browser, runtime, GPU-buffer, memory, and model support limits still apply. `-1` output tokens means no per-response token-count limit, but end tokens and context capacity still apply. Context overflow is reported; conversation history is not silently discarded.

## Runtime and privacy

- wllama **3.8.1**, loaded on demand from the version-pinned jsDelivr npm distribution, executes llama.cpp locally in a Web Worker.
- WebGPU offloads supported model layers to the local GPU. CPU uses WebAssembly SIMD. CPU multithreading requires cross-origin isolation.
- `isolation-sw.js` adds COOP/COEP response headers for this page's scope on GitHub Pages. It does not control the parent HTML Pocket page, upload data, or persist model files.
- Local model files are read with the browser File API. Metadata inspection reads small windows rather than allocating a whole-model ArrayBuffer. GGUF shard metadata is checked before loading.
- The first runtime load needs internet access. GitHub Pages and jsDelivr receive ordinary requests for static assets. Model files, prompts, and responses are never sent to an inference service. This is not an offline-installation guarantee.
- Chat history and settings are stored in namespaced browser localStorage. History saving can be disabled and records cleared. Model files must be selected again after closing the page.
- Optional folder autosave writes only chat JSON to the explicitly selected local folder; model files are never copied. Permission handles are stored locally and are never uploaded. Writes are serialized. Unrelated files with conflicting names and newer JSON snapshots on disk are not overwritten. Restoring access at startup does not automatically replay old browser history.
- Only text generation is exposed. An embedding model or mmproj projector is not a standalone chat model.

## Interface

Chinese/English, light/dark monochrome themes, responsive mobile model drawer, streamed text, collapsible model reasoning, GFM Markdown, headings, bold/italic, tables, quotes, lists, fenced code blocks, monochrome syntax highlighting, per-code copy/download, message copy, regeneration, and local conversation history.

Generated HTML is sanitized using DOMPurify. Embedded images and active content are removed; code is never executed. Markdown links only navigate when the user clicks them.

## Hardware reporting

Logical processors, approximate/clamped device memory (where exposed), WebGPU adapter information and buffer limits, cross-origin isolation, active CPU thread count, model file size, engine-reported GPU layer offload/allocation, page JS heap (where exposed), event-loop delay, token counts, generation speed, and time to first output.

Whole-system CPU/GPU utilization, temperatures, power, actual free VRAM and available RAM are **not accessible to a normal webpage** and are not fabricated. JS heap is not total model memory; a maximum GPU buffer size is not VRAM capacity. GPU allocation values are extracted from engine logs and are not whole-device usage. Reported output token counts come from engine timings/usage, not from counting streamed chunks.

## Deployment

This directory is buildless. Keep every file together and serve over HTTPS (or a trustworthy localhost development origin); opening `index.html` with `file://` is not supported. The repository's existing GitHub Pages branch publication serves `/gguf/` automatically. No API key, backend, virtual driver, native executable, or server setting is needed for visitors.

## Verification performed

- JavaScript syntax checks.
- Ten automated core checks: GGUF metadata, bounded reads for a virtual 32 GiB file, invalid/truncated files, complete/missing/duplicate/mixed shards, projector rejection, numeric bounds, reasoning parsing, chat import validation, actual-log parsing, and translation parity.
- DOM-emulated application flow: startup, model selection, bilingual/theme controls, load options, streaming, Markdown/code/tables, XSS sanitation, metrics, history, stop, unload, and GPU-to-CPU fallback. These UI tests use a mock engine; they are not evidence of real hardware inference.
- Version-pinned WebAssembly and compatibility assets checked for availability, MIME type and CORS/CORP support.
- Folder autosave checks use mocked directory handles: snapshots, queued updates, failures/retry, permissions, restoration, folder changes, disconnect, and unsupported browsers. DOM checks cover saving with browser-history disabled and preserving disk files when browser history is cleared. A real operating-system folder picker was not exercised in this environment.

Real GPU execution and compatibility with the visitor's particular GGUF still require testing on that device. This build was not visually tested in a real browser before publication.

Third-party license notices are in `THIRD_PARTY_LICENSES.txt`. Runtime documentation: https://github.com/ngxson/wllama
