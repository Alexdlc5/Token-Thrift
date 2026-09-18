# Token Thrift

A desktop hub for chatting with free-tier LLMs — one app, eight providers, zero paid API calls unless you explicitly opt in.

Built with Electron, React, and TypeScript. Every provider call streams live, every response is logged in a task monitor, and every API key is encrypted at rest via the OS keychain.

## Why

Free-tier access to capable LLMs is scattered across a dozen different consoles, each with its own dashboard, its own key format, and its own rate limits. Token Thrift puts them behind one interface, with a hard client-side guard that refuses to bill a paid model unless you flip a switch for that specific provider.

## Features

- **Eight free-tier providers behind one interface** — OpenRouter, Groq, Google AI Studio (Gemini), Cerebras, NVIDIA NIM, Hugging Face, Mistral, and Cloudflare Workers AI. Each implements a shared `LLMProvider` interface, so adding a provider is one new file, not a rewrite.
- **Live streaming, including reasoning traces.** For models that expose a separate thinking/reasoning channel, it renders distinctly from the final answer instead of getting mixed in.
- **A real task monitor**, not just a chat log — every request (and any future nested/agentic sub-requests) shows up as a row with live status, token counts, cost, and the exact resolved system prompt that was sent, so you can verify what a toggle actually changed.
- **Session-level context management.** Conversations carry up to 500K tokens of rolling history; once a session gets close to that cap, the oldest portion is automatically summarized by the model and archived (not deleted — still inspectable, just no longer resent). Every individual request is separately fitted to the *active* model's real context window, whatever that happens to be.
- **A live document panel** above the chat input — start a text document and let the model revise it turn by turn (a plain response convention, so it works identically across all eight providers with no function-calling support required), or load an image/PDF as a reference.
- **Free image generation and image reading**, both via a hosted vision/image model, triggered automatically by conversational intent rather than a separate mode you have to remember to switch into.
- **A session-scoped file library** — every uploaded or generated file is saved to disk and shown in a grid, sized and colored by file size, one click from opening in whatever your OS treats as the default handler for that file type.
- **Multiple named API keys per provider**, independently encrypted, with an active-key selector — useful for keeping separate accounts straight, not for working around any single provider's rate limits.
- **Mid-conversation model switching.** Change which provider/model a session talks to without losing its history.
- **Nothing ever looks frozen.** Every async operation — session creation, model loading, the gap between sending a message and the first streamed token — has a visible loading state.

## Tech stack

- **Electron + React + TypeScript**, with the renderer talking to the main process only through a typed `contextBridge` IPC layer (no Node integration in the renderer).
- **SQLite via Node's built-in `node:sqlite`** for conversations, sessions, and the task log — no native module compilation required.
- **API keys encrypted via Electron's `safeStorage`** (OS keychain / DPAPI-backed on Windows), never sent to the renderer and never written to disk in plaintext.
- Zero UI framework dependency — plain React and CSS throughout.

## Getting started

```bash
npm install
npm run dev
```

Then open **Settings** and paste in a free-tier API key for at least one provider (OpenRouter's `openrouter/free` auto-router is the fastest way to get a first message streaming with zero setup beyond a key).

## Project structure

```
src/
  main/            # Electron main process: providers, persistence, IPC handlers
    providers/      # One LLMProvider implementation per service
    image-providers/ # Image generation + vision (image-reading)
    db/             # node:sqlite schema + repository layer
  preload/         # contextBridge — the only surface the renderer can call
  renderer/        # React UI
  shared/          # Types and the IPC contract shared across all three processes
```

## License

MIT — see [LICENSE](LICENSE).
