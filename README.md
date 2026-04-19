# Cicerone

A minimal VS Code extension scaffold for experimenting with collaborative code tours, now with ACP-compatible agent backends like pi and Kiro.

## What is included

- `TourStackManager` for main tours and tangents
- `CommentTourController` using the VS Code comments API
- Demo commands for a manual 3-step tour
- `Ask for Code Tour` to answer repository questions as a guided walkthrough
- Follow-up questions from the comment thread that spawn tangent tours
- A dedicated Cicerone sidebar with a question box, tour controls, stack display, and clickable step cards
- Line highlighting and status bar progress

## Project structure

- `src/types.ts` — shared tour/step types
- `src/backend/types.ts` — backend abstraction for agent integrations
- `src/backend/acpBackend.ts` — generic ACP backend implementation for pi-acp, kiro-cli, and other ACP-compatible agents
- `src/backend/piRpcBackend.ts` — direct pi RPC backend implementation
- `src/tourStackManager.ts` — LIFO tour stack manager
- `src/commentTourController.ts` — comment thread + decorations UI
- `src/extension.ts` — command wiring and demo tour

## Prerequisites

- Node.js 20+ recommended
- VS Code
- npm

## Install dependencies

```bash
npm install
```

## Build

```bash
npm run compile
```

## Run the extension

1. Open this folder in VS Code.
2. Run `npm install`.
3. Press `F5` to launch the Extension Development Host.
4. In the new VS Code window, open any code file.
5. In the **Cicerone Sidebar** (Activity Bar), ask a question and click **Start Tour**.

### Keyboard Shortcuts

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| **Next Step** | `Ctrl`+`Alt`+`]` | `Cmd`+`Alt`+`]` |
| **Previous Step** | `Ctrl`+`Alt`+`[` | `Cmd`+`Alt`+`[` |
| **Next Tour** | `Ctrl`+`Alt`+`Shift`+`]` | `Cmd`+`Alt`+`Shift`+`]` |
| **Previous Tour** | `Ctrl`+`Alt`+`Shift`+`[` | `Cmd`+`Alt`+`Shift`+`[` |
| **Start Tour** (in Sidebar) | `Ctrl`+`Enter` | `Cmd`+`Enter` |

## Features

- The default backend implementation uses generic `acp`, which can point at `pi-acp`, `kiro-cli`, or another ACP-compatible CLI. `pi-rpc` is also available as a direct pi fallback.
- Cicerone routes tour generation through a backend abstraction and now supports session reuse semantics across top-level tours vs. tangents.
- The pi-generated tour uses the workspace root as the agent working directory.
- Use the inline comment thread actions for `Previous`, `Next`, and `Exit Tour` while navigating a tour.
- Use the dedicated `Cicerone` sidebar in the Activity Bar to ask a question, start a tour, jump directly to any step, navigate tangents, and discard tours.
- The sidebar now shows the active backend (`pi-acp`, `kiro-cli (acp)`, `pi-rpc`, etc.) and persists your question draft between reloads.
- Top-level tours now create a fresh backend conversation session, while follow-ups and tangents reuse the same session.
- The sidebar also shows the current tour stack plus Previous / Next / Toggle Detail / Exit / Discard controls.
- Toggle between terse and detailed annotations with `Cicerone: Toggle Annotation Detail`, the inline thread action, or the sidebar control.
- Use the comment reply box on any tour step, then trigger `Cicerone: Ask Follow-up Tour` from the thread actions to open a tangent tour.
- `Cicerone: Exit Tour` pops the current tangent and returns to the parent tour if one exists.
- The demo tour uses the currently active file.
- The three demo steps are placed at the top, middle, and bottom of that file.
- Tangent support exists in `TourStackManager`, but is not yet exposed via commands.

## Suggested next steps

- Make follow-up replies submit directly from the comment input without needing a thread action
- Add a `Start Tangent` command
- Add `maps_to(index)` command support
- Replace single-line highlighting with block/range highlighting
- Persist pi sessions for multi-turn architectural conversations
