# Cicerone

Cicerone is an AI-powered VS Code extension designed to help developers perform deep dives into unfamiliar codebases and rapidly build understanding. 

Instead of just reading code or relying on standard chat interfaces, Cicerone generates **interactive, guided code tours** directly within your editor. By integrating with ACP-compatible agents (like `pi` and `Kiro`), Cicerone answers your architectural questions by navigating you through the actual files, lines, and symbols that matter—complete with contextual notes, follow-up tangents, and session summaries.

## Key Features

- **Interactive Code Tours:** Ask a question and get a multi-step walkthrough jumping directly to the relevant code.
- **Tangents & Notes:** Use the inline comment reply box on any tour stop to ask a follow-up (spawning a "tangent" tour) or save a personal note.
- **Session Summaries:** Click `Summarize` in the sidebar to generate a cleanly formatted markdown synthesis of all your active tours and personal notes.
- **Background Generation:** Queue up multiple tours at once. Cicerone generates them in the background without blocking your current flow.
- **Agent Backend Abstraction:** Seamlessly use generic `acp` backends (`kiro-cli acp`, `pi-acp`) or fall back to direct `pi-rpc` connections. Top-level tours get fresh sessions, while tangents reuse their parent's context.

## Project Structure

- `src/types.ts` — shared tour/step types
- `src/backend/types.ts` — backend abstraction for agent integrations
- `src/backend/acpBackend.ts` — generic ACP backend implementation for pi-acp, kiro-cli, and other ACP-compatible agents
- `src/backend/piRpcBackend.ts` — direct pi RPC backend implementation
- `src/tourStackManager.ts` — LIFO tour stack manager for roots and tangents
- `src/commentTourController.ts` — comment thread + decorations UI
- `src/extension.ts` — command wiring and application state

## Prerequisites

- Node.js 20+ recommended
- VS Code
- npm

## Install & Build

```bash
npm install
npm run compile
```

## Run the Extension

1. Open this folder in VS Code.
2. Press `F5` to launch the Extension Development Host.
3. In the new VS Code window, open any code file inside a workspace.
4. In the **Cicerone Sidebar** (Activity Bar), select your backend/model, ask a question, and click **Start**.

### Keyboard Shortcuts

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| **Next Step** | `Ctrl`+`Alt`+`]` | `Cmd`+`Alt`+`]` |
| **Previous Step** | `Ctrl`+`Alt`+`[` | `Cmd`+`Alt`+`[` |
| **Next Tour** | `Ctrl`+`Alt`+`Shift`+`]` | `Cmd`+`Alt`+`Shift`+`]` |
| **Previous Tour** | `Ctrl`+`Alt`+`Shift`+`[` | `Cmd`+`Alt`+`Shift`+`[` |
| **Start Tour** (in Sidebar) | `Ctrl`+`Enter` | `Cmd`+`Enter` |

## License

This project is licensed under the [MIT License](LICENSE).
