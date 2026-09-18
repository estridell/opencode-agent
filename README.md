# OpenCode Agent

Use [OpenCode V2](https://opencode.ai/v2/) on your Linux machine through Telegram.

**OpenCode Agent is an unofficial community project.**
The OpenCode team does not create, maintain, or endorse this project.
This project is not affiliated with the OpenCode team.

## Purpose

Send a message from your phone. OpenCode can run commands, change files, use tools, and work on repositories.
The Telegram bot sends the results to you.

OpenCode Agent adds installation, setup, and a Telegram connection to upstream OpenCode.
OpenCode provides the agent runtime. This project does not maintain a separate version of that runtime.

## Current functions

The first version supports one owner on a Linux machine or virtual machine (VM).

- A separate OpenCode V2 installation, service, configuration, credentials, and session database.
- Text messages, photos, and image files in a private Telegram chat.
- New messages that change the instructions for a task in progress.
- Saved sessions with commands to create, select, and stop them.
- Agent responses with a temporary Telegram typing indicator during work.
- Automatic permission approval, optional permission buttons, and questions with buttons or text answers.
- Model, model variant, and agent selection in a single message, with optional defaults for new sessions.
- Plain terminal setup with direct entry of your Telegram user ID.
- A systemd user service for background operation.
- A short general-purpose assistant context added to OpenCode's model-specific instructions.

Initial setup uses OpenCode V2 **2.0.8** and the matching official client.
The update command installs the latest V2 runtime and its matching client after application checks pass.

## Install

1. Open a terminal on the agent machine.
2. Run the installer:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/estridell/opencode-agent/main/install.sh | bash -s -- --repo https://github.com/estridell/opencode-agent.git
   ```

3. Follow the setup prompts.

If you already have a repository copy, run `bash install.sh` from that directory.

The installer adds missing Linux packages, a separate Bun runtime, and the `opencode-agent` command.
Setup installs OpenCode V2 and offers model provider sign-in.
Setup then asks for the bot token, your Telegram user ID, and the working directory.
The last prompt offers to install and start the Telegram service.

Add `~/.local/bin` to `PATH` if the installer requests it.
See [Installation and operation](docs/installation.md) for service setup and other installation methods.

## Use Telegram

1. Open the private chat with your bot.
2. Press **Start**.
3. Send a text request.

New sessions use `~/.opencode-agent/workspace` as the default working directory.
Tell the agent which repository or directory to use in your message.

| Command | Function |
| --- | --- |
| `/new [title]` | Create a session |
| `/sessions` | Select a previous bot session |
| `/stop` | Stop work in the selected session |
| `/status` | Show the directory, agent, model, and activity |
| `/model [search]` | Select a model and model variant |
| `/agent` | Select a primary agent |
| `/update` | Update the application and OpenCode |
| `/help` | Show the commands |

To answer an agent question, reply to that question message or use its buttons.
Other messages give new instructions to the current task.
When you select a different session, work in the previous session continues.
Responses from other sessions include the session title.

Send a photo or image file to ask about its contents.
Add your question as the caption. Without a caption, the agent receives a request to analyze the image.
Supported formats are PNG, JPEG, GIF, and WebP, up to 20 MiB per image.
Select a model with image input through `/model`.
Images use the current session and can add information to a task in progress.
Telegram albums send each image as a separate request.

The model, agent, and session pickers update the same message when you change pages.
The final selection replaces the picker and removes its buttons.
Model and agent selection asks: **Set as default for new sessions?**
Select **Yes** to use that choice for future bot sessions, including the selected model variant.
Select **No** to change only the current session.
Saved defaults remain available after a gateway restart.

The gateway automatically approves pending permission requests for bot sessions and their child sessions.
Each approval uses **Allow once**. It does not save a permanent permission rule.
Explicit OpenCode deny rules still apply. Questions still require your answer.
To use permission buttons, set `"autoApprove": false` in `~/.opencode-agent/config.json`.
Restart the gateway after this change.

## Use the terminal

```sh
opencode-agent                         # Open the agent's OpenCode terminal interface
opencode-agent setup                   # Run setup again
opencode-agent update                  # Update the application and OpenCode
opencode-agent gateway status          # Show the Telegram service status
opencode-agent gateway restart         # Restart the Telegram service
opencode-agent gateway logs            # Show the Telegram service logs
opencode-agent doctor                  # Check OpenCode and Telegram
opencode-agent opencode auth login     # Sign in to a model provider
```

## Updates

Run `opencode-agent update`, or send `/update` in Telegram.
Both commands update the application from `main`, its dependencies, the installer, and the separate OpenCode V2 runtime.
The installer also updates the private Bun runtime to the version selected by the project.

The terminal shows progress as the update runs.
Telegram uses one progress message, including the final result after a restart.
The update worker runs separately from the gateway.
It continues if the gateway stops or you close the terminal.

The updater prepares and checks a new application directory before activation.
Updates keep services running by default. Only explicit restart conditions stop a service.
Plugin additions, changes, renames, and removals keep Telegram and OpenCode running.
OpenCode automatically reloads the installed plugin set.
Documentation, tests, and development-only changes also keep both services running.
Plugin dependency changes require a gateway restart only when they also change the gateway's resolved dependencies.
Gateway code, gateway dependencies, execution settings, and installer changes restart the gateway.
Runtime version changes restart both services.
A runtime restart can interrupt active tasks.
An unchanged installation does not restart.

Updates require an installed systemd user service.
Configuration, credentials, sessions, and workspace files remain in the agent directory.
See [Update](docs/installation.md#update) for details and recovery commands.

## Separate OpenCode installation

The default installation directory is `~/.opencode-agent`.
Set `OPENCODE_AGENT_HOME` to use a different directory.

The agent has its own OpenCode binary, credentials, configuration, sessions, and service registration.
It uses separate HOME and XDG directories and a separate local network port.
It does not receive host model API keys or host `OPENCODE_*` settings.

Tools run as the Linux user that starts the service.
OpenCode still applies configuration and permission rules from the working repository.

Use `opencode-agent opencode <args>` to run upstream commands in the agent installation.
See [Installation and operation](docs/installation.md#files) for file paths.

## Design

The Telegram gateway is a small program that connects Telegram to OpenCode.
It uses Bun, TypeScript, the official `@opencode/client`, and grammY.
It uses long polling to get Telegram messages through outbound requests.
It does not require a public inbound network endpoint.

OpenCode controls models, providers, tools, sessions, permissions, MCP, file access, and agent execution.
The bundled context plugin describes the general-purpose assistant role, Telegram connection, and agent machine.
It appends these instructions for gateway sessions and their child sessions through OpenCode's `context` hook.
The source text is in [`packages/plugins/context.ts`](packages/plugins/context.ts).
See [Implementation](docs/implementation.md) for the design and current limits.

## Repository

| Path | Contents |
| --- | --- |
| `install.sh` | Linux installer |
| `config/` | Configuration example |
| `docs/` | Installation and design documentation |
| `packages/telegram/` | Terminal commands, setup, and Telegram gateway |
| `packages/plugins/` | Bundled OpenCode plugins |
| `scripts/` | Notes about script commands |

## Development

Run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

Use `bun run setup` to configure the agent.
Use `bun start` to run the gateway in the terminal.

The live API test uses a temporary OpenCode V2 service:

```sh
OPENCODE_AGENT_HOME=/tmp/opencode/agent-smoke bun run test:live
```

The test downloads the specified V2 binary if necessary.
It tests sessions, message submission, forms, permissions, interruption, history, and events.
It does not call a model provider. It stops the test service when it finishes.
See the [acceptance test](docs/installation.md#acceptance-test) for checks with a real Telegram bot.

## Future work

Possible functions include personal memory, scheduled tasks, notifications, personal tools, and other message interfaces.
These functions are outside the first version.

## Project name

OpenCode Agent is the current project name.
Other projects use similar names. Check package names before publication.
