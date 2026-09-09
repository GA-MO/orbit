<!-- This is the original brief Orbit was built from, kept as written. The
tabs, providers and flows it names are not all what shipped: see README.md
for what exists and docs/DESIGN-NOTES.md for why it took the shape it did. -->

You are a senior macOS engineer and full-stack architect.

Build a personal AI coding assistant that turns a MacBook Pro into a local AI development server.

The goal is to create a Cursor-like coding experience accessible from iPhone and Android.

This is NOT a cloud SaaS platform.
This is a single-user local-first application.

The MacBook is the source of truth.

Architecture:

iPhone / Android Browser
        |
        | WebSocket + HTTPS
        |
MacBook Local AI Coding Hub
        |
        |
PTY Manager
        |
Claude Code / Codex CLI / Gemini CLI


CORE FEATURES:

1. Real Terminal Experience

Implement a real interactive terminal.

Technology:

Frontend:
- React
- TypeScript
- Vite
- PWA
- xterm.js

Backend:
- Node.js
- TypeScript
- node-pty
- WebSocket


Requirements:

The mobile user must see exactly what appears in CLI.

Support:

- ANSI colors
- Cursor movement
- Interactive prompts
- Keyboard input
- Ctrl+C
- Resize
- Copy paste


Example:

Mobile browser:

$ claude

Claude Code runs on MacBook.

User can interact normally.


2. Local Mac Agent

Create a local agent service.

Responsibilities:

- Start CLI agents
- Manage PTY sessions
- Access project folders
- Execute commands
- Capture screenshots
- Run tests
- Manage git


3. Agent Provider System

Support:

- Claude Code
- Codex CLI
- Gemini CLI


Each provider:

- command
- arguments
- environment
- working directory


4. Persistent Sessions

Sessions survive mobile disconnect.

Store:

- session id
- project
- agent
- terminal history
- created time


5. Mobile Experience

PWA interface:

Tabs:

Terminal
Timeline
Files
Diff
Screenshots


6. Voice Input

Mobile user can speak:

"Add JWT authentication"

Convert speech to text and send command.


7. Image Input

User can upload:

- Screenshot
- UI design
- Error image

Send context to AI workflow.


8. Screenshot Validation

Use Playwright.

Flow:

AI changes code.

System:

- Run application
- Open browser
- Capture screenshot
- Display result


9. Security

Because this controls a personal computer:

Implement:

- Authentication
- Local access mode
- Tailscale compatible
- Command approval for dangerous commands


10. macOS First

Optimize for:

- Apple Silicon
- macOS filesystem
- zsh shell
- Docker Desktop


Development strategy:

Phase 1:
Working xterm.js terminal connected to node-pty.

Phase 2:
Claude Code/Codex integration.

Phase 3:
Session management.

Phase 4:
Voice and image.

Phase 5:
Screenshot testing.

Phase 6:
Mobile UX polish.


The final result should feel like:

"Cursor running on my MacBook, controlled from my iPhone."

Start with architecture and implement Phase 1 completely.
