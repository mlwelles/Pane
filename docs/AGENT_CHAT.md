# Agent Chat

Agent tabs can use Chat or the agent's native Terminal interface. The tab's
ellipsis menu and context menu offer **View as Chat** and **View as Terminal**.
Compatible conversations also have a Chat/Terminal switch above the content,
including in the React Native companion.
Both interfaces continue the same saved provider conversation. Switching waits
for an idle checkpoint; it does not transfer a running tool or cancel a turn.

Settings → AI & Agents → **Default agent interface** applies to new compatible
tabs. Existing installations default to Terminal, and existing tabs keep their
choice. **Chat interface** disables new Chat transitions without terminating
existing Chat work. Those conversations can still send, cancel, stop and return
to Terminal.

## Current compatibility

The initial implementation enables Claude Code **2.1.309** with
`@agentclientprotocol/claude-agent-acp` **0.94.0** on **macOS Apple Silicon**.
Pane uses ACP SDK **2.0.1** and assistant-ui **0.15.31** as a display/composer
binding; the React Native companion uses the matching **0.1.50** distribution.
Both share core **0.3.31**, store **0.3.22** and tap **0.9.24**; their exact
release-age exceptions keep this tested runtime family together. The adapter uses the verified native Claude executable on the workspace
host. Chat uses the existing provider login; there is no additional chat cloud
service or second conversation store.

A directly launched `claude` command can preserve model, effort, permission
mode, `--strict-mcp-config` and `--add-dir`. Wrappers, custom resume templates,
SSH commands, unknown flags and existing tabs without Pane's lifecycle hooks
remain Terminal. A switch requested during work waits for a verified checkpoint;
**Cancel pending switch** leaves the current interface active. The hooks
report foreground completion, pending work, background tasks and scheduled
wakeups. An incomplete observation blocks switching.

Default shared-daemon Codex tabs remain Terminal: exiting their TUI does not
prove release of the conversation's writer. A dedicated `--no-daemon` experiment
proved continuity, but its background-work checkpoint is not enabled in the
product. Linux, Windows, WSL and other providers also remain Terminal until
validated. A browser on another operating system can view a supported host's
Chat; it never starts a substitute local agent.

**Set up Chat** explicitly installs the pinned upstream adapter under the
workspace host's Pane data directory. Missing adapters leave native terminals
usable. The default Chat setting falls back to Terminal for unsupported launches
or missing adapters. Setup does not alter global Claude/Codex configuration.

## Lifetime and recovery

The host owns the process, exact conversation identity, runtime generation,
pending permissions and transcript projection. Hiding a tab, switching viewers
or disconnecting a remote browser only detaches subscriptions. Stop, close and
archive clean up the active runtime on the owning host.

A handoff preflights the destination, verifies the source checkpoint, freezes
submissions, and saves a transition before releasing the source. The source's
tracked process lifetimes must end before the destination loads the exact ID.
Failed imports never fall back to a new conversation, a latest-session selector
or a summary. After a failed target load, Pane restores the exact source only
when target release is verified; otherwise the tab remains stopped.

After a host restart, Chat recovery is explicit, including after an app update. Recover in Terminal first to rebuild
the normal workspace launch environment. If a crash occurred before a spawned
process identity or new conversation ID was recorded, inspect the processes and
provider store on that host; Pane does not guess an owner or create a replacement.

Permission cards show the adapter's exact choices. Answers bind to the runtime
generation and request ID; the first accepted answer wins across viewers.
Cancellation withdraws pending requests. A lost send response keeps its operation
ID for **Check delivery** or an explicit **Retry same delivery**. Safe reads can
retry automatically; sends, answers and configuration changes cannot.

## Display and controls

Chat uses assistant-ui’s default thread, message and composer styling. It renders
Markdown, reasoning, tools and edit details. Resource links, embedded resources
and unfamiliar message content have expandable, selectable details; provider protocol metadata is under
Conversation options → Diagnostics on desktop/web. Model, mode and effort
choices come from the host and sit beside Send. Narrow web panels combine them
in one menu trigger; the native app uses a settings sheet.
Images and configuration controls appear only when advertised by the adapter.
The browser never executes provider tools. Unsupported client filesystem,
terminal and elicitation capabilities are not advertised.

The display cache is limited to 4,000 messages and 16 MiB; larger imports remain
in Terminal with an explanation. The provider retains the complete conversation.
The desktop/web viewer renders pages of 200 messages; the React Native viewer
uses Legend List virtualization. Both open heavy tool details on demand.
Draft text, pending delivery reconciliation and scroll position survive viewer
remounts during the same application/browser session. The native app also saves
draft text per host, pane and panel on the device. Native image attachments use
ACP image content, with a 5 MiB limit; they do not paste a host filesystem path.
The native app keeps uncertain operations and attachments by saved host profile
and panel through host switches and credential changes, rebinding to the current
connection. The Chat composer clears only the original draft revision after a
confirmed host receipt; edits made while waiting remain. Uncertain deliveries
stay available for reconciliation. Raw terminal input controls are mounted
only for Terminal ownership.

## Automation

`runpane panels submit`, `wait`, `last-message`, `output`, `resume` and workspace
status dispatch to the active runtime. Chat submissions report `sequenceName:
"acp"`, `enter: "none"`, a durable `operationId` and delivery evidence
`"acp-receipt"`. A wait's legacy `screen` field is tagged `source:
"acpTranscript"` when it contains Chat transcript text; it is not a native screen.

Raw `panels input`, `panels screen` and `panels submit-composer` retain literal
terminal semantics and return `CHAT_RAW_TERMINAL_UNSUPPORTED` when Chat owns the
tab. Use semantic submit/read commands or switch to Terminal. Update npm/Python
runpane clients together with Pane to recognize the added response variants.

Commands and ordered generation/revision events use Pane's existing authenticated
daemon transport. Reconnect repairs gaps from a host snapshot. An older host
without these commands remains usable in Terminal and reports Chat unavailable.

## Renderer regression tests

Run `pnpm exec playwright test -c playwright.agent-chat.config.ts` for desktop and
phone viewport checks of bounded history, follow/pause, asynchronous scroll
restoration, permissions, recovery and uncertain delivery reconciliation. These
tests use a local Vite server and fixture host; they do not launch Electron or a
provider. Native viewer state and image validation are covered by
`pnpm --filter native test`. Device interaction and real native/ACP handoffs
require a separate isolated host and configured device or simulator.
