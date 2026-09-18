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
| Permissions | OpenCode permission requests and decisions |
| Models | Model, variant, and agent selection, with optional defaults for new bot sessions |
| Setup | Plain terminal prompts and direct Telegram user-ID entry |
| Background operation | A systemd user service |

Earlier sessions can continue to work after the owner selects a different session.
The owner can specify a repository in a normal text message.

## Separate gateway process

The V2 client provides session, event, permission, form, model, and service APIs.
The gateway uses these APIs without an OpenCode plugin.
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

## Pickers and defaults

The model, agent, and session pickers use one Telegram message for all pages.
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

## Permissions and questions

Before it sends a permission decision, the gateway checks that the request is still pending.
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

Text answers must reply to the applicable question message.
Other messages remain available for instructions to the current task.
OpenCode checks the complete answer.
The gateway removes active buttons after it detects a completed interaction.

Only the configured owner in the private chat can submit a prompt or use an action button.
Button data contains a short local ID. It does not contain credentials or a complete upstream action.

## API versions

The tested versions are OpenCode V2 **2.0.8** and `@opencode/client` **2.0.8**.
Some published documentation examples differ from the installed client:

- Permission replies use `decision`.
- Interruption uses `resume`.
- Message history uses `client.message.list`.

The implementation follows the installed client types.
The live test checks the API with a real, separate V2 service.

## Current limits

- Telegram input supports text only.
- Text formatting supports bold text, inline code, and code blocks. Other Markdown stays as text.
- There are no additional memory, scheduling, or personal-agent plugins.
- Session selection shows sessions from this bot only.
- Each installation supports one owner.
- Background installation supports Linux systemd user services.
- Parent agents summarize child-agent responses. Child permission requests and questions are sent to the owner.

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
