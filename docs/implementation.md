# Implementation

## Design decisions

The first version supports one owner on a Linux machine or virtual machine.
It uses an unchanged upstream OpenCode V2 runtime in a separate installation.

| Item | Decision |
| --- | --- |
| Gateway | A Bun/TypeScript program with `@opencode/client` and grammY |
| Telegram connection | Long polling in one private chat |
| Owner access | Numeric Telegram user ID entered during setup |
| Sessions | One selected session, with commands to create and select sessions |
| Working directory | A configurable directory, initially `~/.opencode-agent/workspace` |
| New instructions | Upstream `delivery: "steer"` for tasks in progress |
| Interruption | The upstream session interrupt API |
| Output | Completed assistant messages and a temporary Telegram typing indicator |
| Questions | OpenCode forms with buttons or text replies |
| Permissions | Automatic one-time approval by default; optional manual decisions |
| Models | Model, variant, and agent selection, with optional defaults for new bot sessions |
| Setup | Plain terminal prompts and direct Telegram user-ID entry |
| Background operation | A systemd user service |

Earlier sessions can continue to work after the owner selects a different session.
The owner can specify a repository in a normal text message.

## Separate gateway process

The V2 client provides session, event, permission, form, model, and service APIs.
The gateway uses these APIs for transport and session control.
Its process controls the Telegram connection independently of plugins that load for each working directory.
OpenCode supplies the agent loop, provider support, and tool execution.

## Separate runtime

`runtime.ts` installs the specified binary with the upstream V2 installer.
The runtime uses separate HOME and XDG directories for configuration, data, state, cache, runtime files, and temporary files.
Only selected system and proxy environment variables are copied from the host.
Host provider keys and OpenCode settings are not copied.

Service startup uses `env -i` to prevent other host environment variables from entering the runtime.
The client service helper would otherwise combine host and runtime variables.

`opencode.ts` gives the official service helper the separate registration file and binary path.
Setup selects an available loopback port, which accepts connections from the local machine.
It saves that port with the upstream `service set port` command.
The managed V2 service rejects port zero and uses a fixed default port.
Separate file paths alone do not prevent a port conflict.

The command `opencode-agent opencode <args>` uses the same separate environment.
OpenCode controls provider sign-in, models, permissions, plugins, tools, and agent behavior.
OpenCode still reads configuration from working repositories.

## Application context plugin

`packages/plugins/context.ts` exports the `opencode-agent.context` plugin.
It appends a short application note through the V2 `context` hook before each agent-loop model request.
The note describes a general-purpose assistant that communicates through Telegram and operates on the configured agent machine.
It preserves all upstream model-specific instructions and any custom agent system prompt.
The plugin registers no tools and does not add conversation messages.

The plugin checks session metadata for `source: "opencode-agent"` and `transport: "telegram"`.
It follows parent session IDs so child agents receive the same context.
Unrelated sessions do not receive the note.
Each outgoing request receives at most one copy.
Title, compaction, and transient generation requests retain their existing instructions.

## Bundled plugin installation

Startup and update activation synchronize all server plugins in `packages/plugins/`.
Direct `.ts` and `.js` files are plugins; package directories use the V2 server, main, or index entrypoint conventions.
Helper modules, assets, and dependencies remain in the prepared application directory.
Generated entrypoint files import the plugins from their source locations, so their relative imports and package dependencies remain available.

The destination is `runtime/config/opencode/plugins/` under the agent directory.
The managed names start with `opencode-agent-file-` or `opencode-agent-package-`.
`runtime/config/opencode/opencode-agent-plugins.json` records the managed entrypoint names.
The installer atomically replaces changed entrypoints and removes entries for deleted or renamed plugins.
It records planned additions before file changes so recovery can restore the previous complete set.
Unrelated user plugins remain outside this inventory.
The installer migrates the original managed `opencode-agent-context.ts` file to this layout.
OpenCode's file watcher loads changed local plugins after its notification and debounce delay.
Plugin installation does not stop either service.
An active model request keeps its current instructions; subsequent requests receive the changed note after reload.
Runtime preparation reads the plugin set from `current` when an installed application exists.
Thus, a gateway from an earlier application directory cannot restore old or removed plugins during reconnection.

The official plugin package supplies development types; its version follows the runtime and client during updates.
The context plugin needs no additional runtime dependencies.

## Gateway data

The gateway stores connection data in SQLite:

- Session IDs and the selected session.
- The Telegram polling offset, which identifies the next update to request.
- The session assigned to each input message.
- Delivery records for response messages.
- Button actions.
- Answers to questions that are not yet complete.
- Picker message IDs, page revisions, and completion state.
- Model, variant, and agent defaults for new bot sessions.

OpenCode stores session history and execution state.

Plugin installation and update state use `files.ts` to replace files through a private temporary file in the same directory.

## Pickers and defaults

The model, agent, and session pickers use one Telegram message for all pages.
`pickers.ts` controls page limits and navigation for all three pickers.
Model variants and the default question use that same message.
When selection finishes, a short result replaces the message and its buttons.
Buttons from previous pages or completed pickers cannot change a selection.
Cancel closes the picker without changing the session or defaults.

Model and agent selection asks whether to save the choice for new bot sessions.
The gateway saves the complete model reference, including its variant, in SQLite.
It sends these saved defaults to OpenCode when it creates a session.
OpenCode still controls model availability and execution.
This preference applies to new Telegram sessions, not the global OpenCode configuration or existing sessions.
Without a saved preference, OpenCode uses its normal defaults.

The gateway does not send automatic working or ready messages.
Telegram shows a temporary typing indicator during work in the selected session.
The `/status` command shows details only when requested.

## Message delivery and recovery

Each Telegram input has a stable OpenCode message ID.
If a submission fails without a clear result, the gateway submits the same ID again.
OpenCode uses the ID to prevent a second execution of the same input.

The gateway saves the assigned session before it submits the message.
A retry therefore uses the original session, even if the owner selects another session.
The polling offset changes after the gateway processes an update.
Network failures during submission cause a retry.

The gateway gets completed assistant messages from OpenCode in pages.
It saves a record for each part sent to Telegram and the last processed OpenCode message ID.
This information lets it continue after a restart.

The event reader does not send Telegram requests.
Events start a state check through the OpenCode APIs.
Periodic checks also find missed responses, pending permissions, unanswered forms, and child sessions.
After an event connection failure, the gateway finds the service again and opens a new event connection.
OpenCode does not replay missed events.

Response delivery does not lock input processing.
The owner can send new instructions or interrupt work while the gateway sends a long response.
An advisory `flock` lock prevents two gateway processes for one installation directory.

Telegram `sendMessage` does not accept a key that prevents duplicate delivery.
A connection failure can occur after Telegram accepts a response but before the gateway saves its delivery record.
A retry can then send the response again.
Stable OpenCode input IDs prevent this delivery problem from repeating the agent task.

## Image input

The gateway accepts Telegram photos and image documents.
For photos, it selects the size with the largest pixel area.
It downloads the file through Telegram `getFile` and checks the byte signature.
Accepted formats are PNG, JPEG, GIF, and WebP.
The download checks declared sizes and limits streamed content to 20 MiB.

The gateway submits image bytes as a `data:` URI in the upstream prompt's `files` field.
The Telegram download URL contains the bot token and never enters the OpenCode prompt.
OpenCode decodes the image and applies its own media processing and model limits.
The gateway does not add tools or dependencies for image input.

The caption becomes the request text.
Without a caption, the request text is `Analyze the attached image.`
Captions do not execute bot commands.
Image replies to structured questions require a separate image message; question answers remain text or button selections.

Images use the same saved session route and stable message ID as text input.
Download connection failures and ambiguous admission failures can retry without a second model execution.
The gateway keeps downloads in memory; OpenCode stores admitted attachments with session data.
Each image in a Telegram album becomes a separate request.

## Permissions and questions

Before it sends a permission decision, the gateway checks that the request is still pending.
The gateway approves pending requests with `once` unless `autoApprove` is false in the gateway configuration.
This default also applies when the configuration does not contain the setting.
It covers tracked bot sessions and their child sessions, including requests found after a restart.
It does not save permanent rules or override OpenCode deny rules.
Failed requests remain available for the next reconciliation attempt.
Automatic approvals do not add Telegram messages.

When automatic approval is disabled, the gateway shows permission buttons.
Buttons send the upstream `once`, `always`, or `reject` decision.
The message shows the requested resources and available patterns for saved permissions.
OpenCode controls the effect and storage of the decision.

The gateway shows one form field at a time.
It supports these field functions:

- Single choices and multiple selections.
- Boolean, text, and numeric answers.
- Default values and optional answers.
- Conditional fields.
- Cancellation and external links.

Form reconciliation reads pending forms once, inside the same lock that protects answers.

Text answers must reply to the applicable question message.
Other messages remain available for instructions to the current task.
OpenCode checks the complete answer.
The gateway removes active buttons after it detects a completed interaction.

Only the configured owner in the private chat can submit a prompt or use an action button.
Button data contains a short local ID. It does not contain credentials or a complete upstream action.

## Updates

The terminal `update` command and Telegram `/update` start the same systemd user worker.
A unit name derived from the agent directory and an advisory lock prevent concurrent updates.
The worker runs independently of the gateway service and the terminal.

Each update clones `main` into a new application directory.
It resolves the latest V2 release through the upstream update API.
It selects that exact version for `@opencode/client` and the `@opencode/plugin` development types in the prepared copy.
It installs dependencies and runs type checks and tests before activation.
Repository dependency versions otherwise follow the committed lockfile.
The installer selects the Bun version and regenerates the launcher.

The default update path keeps both services running.
`applyUpdate` uses its standard activation, verification, and recovery steps unless an explicit restart condition applies.
The restart steps are optional and separate from these standard steps.

`requiresGatewayRestart` checks explicit restart conditions:

- An OpenCode runtime version change.
- Added, changed, or removed files under `packages/telegram/src/`.
- Changes to `install.sh`, `bunfig.toml`, or `packages/telegram/bunfig.toml`.
- Changes to the gateway's resolved runtime dependencies or module execution settings.

For tracked runtime files, the comparison includes contents, file modes, and symbolic-link targets.
Other files use the default path, including new directories and file types.
Plugins, documentation, tests, and development files do not need individual exceptions.
When gateway code starts using another source directory, add that directory to the explicit restart conditions.

Package and lockfile changes are checked against the gateway's resolved runtime dependency graph.
The comparison includes transitive dependencies, optional dependencies, installed peer dependencies, nested resolutions, and package integrity values.
Plugin-only and development-only dependency changes do not require a gateway restart.
Changes to shared dependencies used by the gateway do require a restart.
An invalid or unsupported dependency snapshot fails preparation before activation.
It does not cause an automatic restart.

No-restart updates require a running gateway, a healthy owned OpenCode service, and the managed `current` link.
Failed prerequisite checks report an error without switching to the restart path.
The worker selects the prepared directory and synchronizes the complete plugin set without stopping either service.
OpenCode's native file watcher loads, reloads, and unloads plugins asynchronously.
The worker checks service availability, runtime version, and unchanged process IDs before recording the update.
This check does not send a model request or wait for a specific plugin generation.
An activation or health-check failure restores the previous application link and complete plugin set without restarting services.

The running gateway can remain in its previous application directory after a no-restart update.
New update workers start from the selected application's stable path.
Readiness continues to identify the running gateway; `installed.json` identifies the selected application.

An atomic link replacement selects the application directory at `current`.
For updates that restart the gateway, the new application's service installer checks and installs the systemd unit.
The worker replaces the runtime binary only after stopping the separate OpenCode service.
It retains the previous binary in the prepared application directory.
It does not change the host OpenCode installation.

The gateway records readiness after the first successful Telegram polling request.
Readiness includes the connection time, application directory, and connected runtime version.
The worker checks these values before reporting success.
It saves each progress stage to disk and changes the same Telegram message.
Telegram rate limits delay progress edits without cancelling the update.

Preparation failure leaves the gateway running.
Failure after shutdown triggers a restart attempt and a failure report.
Automatic database rollback is not implemented.
Previous application directories remain on disk.

### Open questions

- Define retention limits for application directories and update logs.

## API versions

The tested versions are OpenCode V2 **2.0.8** and `@opencode/client` **2.0.8**.
Some published documentation examples differ from the installed client:

- Permission replies use `decision`.
- Interruption uses `resume`.
- Message history uses `client.message.list`.

The implementation follows the installed client types.
The live test checks the API with a real, separate V2 service.

## Current limits

- Input supports text and images. Audio, video, PDF, and other document formats are not supported.
- Text formatting supports bold text, inline code, and code blocks. Other Markdown stays as text.
- There are no memory or scheduling plugins.
- Session selection shows sessions from this bot only.
- Each installation supports one owner.
- Background installation supports Linux systemd user services.
- Parent agents summarize child-agent responses. Child permissions use the configured approval mode; child questions go to the owner.

## References

- [V2 client](https://opencode.ai/v2/docs/build/client)
- [V2 API](https://opencode.ai/v2/docs/api)
- [V2 plugins](https://opencode.ai/v2/docs/build/plugins)
- [V2 service diagnostics](https://opencode.ai/v2/docs/troubleshooting)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Hermes installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- [Hermes gateway code](https://github.com/NousResearch/hermes-agent/blob/main/gateway/run.py)

Hermes messaging uses a configured working directory, with older overrides and a home-directory default.
OpenCode Agent uses the same general approach: a stable working directory without a required repository for each conversation.
