# Installation and operation

## Install from GitHub

Run this command in a terminal on the agent machine:

```sh
curl -fsSL https://raw.githubusercontent.com/estridell/opencode-agent/main/install.sh | bash -s -- --repo https://github.com/estridell/opencode-agent.git
```

The installer downloads the repository to `~/.opencode-agent/app` and starts setup.

## Install from a repository copy

1. Open a terminal in the repository directory.
2. Run this command as the Linux user that will run the agent:

   ```sh
   bash install.sh
   ```

The installer supports apt, dnf, and pacman.
It uses root access or sudo to install missing system packages.
On other Linux distributions, install these packages first:

- `curl`
- `git`
- `unzip`
- `tar`
- `util-linux`, which supplies `flock`

The installer puts Bun 1.3.14 in the agent directory.
It then runs `bun install --frozen-lockfile`.
The command launcher uses absolute paths to Bun and the repository.
Keep the repository at that location.

## Other installation methods

To download a repository with the installer, supply its Git URL:

```sh
bash install.sh --repo <git-url> --ref main
```

The public repository is [estridell/opencode-agent](https://github.com/estridell/opencode-agent).

Use `--source /path/to/checkout` to select an existing repository copy.
Use `--no-setup` to install only the command launcher and dependencies.
Then run `opencode-agent setup` to install and configure OpenCode V2.
The installer keeps existing repository files.

## Setup

1. Run the setup command:

   ```sh
   opencode-agent setup
   ```

2. Select whether to sign in to a model provider.
3. Enter the Telegram bot token from @BotFather.
4. Enter your numeric Telegram user ID.
5. Select the working directory.
6. Select whether to install and start the Telegram service.
7. Open the private chat with your bot.
8. Press **Start** to let the bot send messages to you.

Setup uses plain text prompts. Token input is hidden.
The configuration file uses mode `0600`, which permits access only by its Linux owner.
Setup does not wait for a Telegram pairing message.

To sign in to a provider later, run:

```sh
opencode-agent opencode auth login
```

Run `opencode-agent` to open the separate OpenCode terminal interface.
Use that interface to select default settings.
Telegram commands `/model` and `/agent` ask whether to save the choice for new bot sessions.
Select **Yes** to save a default or **No** to change only the selected session.
The model default includes the selected variant and remains available after a restart.

## Files

The default installation directory is `~/.opencode-agent`.
All paths in this table are relative to that directory.

| Path | Contents |
| --- | --- |
| `app/` | Repository copy from `--repo` |
| `config.json` | Telegram token, user ID, and working directory |
| `telegram.sqlite` | Gateway state and delivery records |
| `gateway.lock` | Lock that prevents a second gateway process |
| `tools/bun/` | Bun runtime from the installer |
| `workspace/` | Default working directory |
| `runtime/home/.opencode/bin/` | OpenCode V2 binaries |
| `runtime/config/opencode/` | OpenCode configuration, plugins, and service settings |
| `runtime/data/opencode/` | OpenCode database, credentials, sessions, and logs |
| `runtime/state/opencode/` | OpenCode service registration |
| `runtime/cache/` | Cache files |
| `runtime/run/` | Runtime files |
| `runtime/tmp/` | Temporary files |

The launcher path is `~/.local/bin/opencode-agent`.
The installer keeps your existing `opencode` and `opencode2` launchers.

OpenCode and its tools use `runtime/home` as HOME.
Configure SSH, Git, and other tools in that environment as necessary.
The runtime does not import host provider API keys.
Configuration files in a working repository still apply.

Set `OPENCODE_AGENT_HOME=/absolute/path` to use a different installation directory.
The service installer creates one `opencode-agent.service` for each Linux user.

See [`config/telegram.example.json`](../config/telegram.example.json) for a configuration example.
Use setup to check the bot token and user ID format.

## Background service

systemd controls the background Telegram service.
Use these commands to install and control it:

```sh
opencode-agent gateway install
opencode-agent gateway status
opencode-agent gateway stop
opencode-agent gateway start
opencode-agent gateway restart
opencode-agent gateway logs
```

The service file is `~/.config/systemd/user/opencode-agent.service`.
If the host sets `XDG_CONFIG_HOME`, the service file uses that configuration directory instead.
The installer checks the generated file with `systemd-analyze verify` before it replaces or starts the service.

To start the service at boot and keep it active after logout, run:

```sh
loginctl enable-linger "$USER"
```

Some systems require administrator access for this command.
Ask the administrator to enable it for the agent user if necessary.

If a systemd user manager is not available, run the gateway in a terminal:

```sh
opencode-agent gateway run
```

When you stop the Telegram gateway, OpenCode and its active tasks continue to run.
To stop the separate OpenCode service, run:

```sh
opencode-agent opencode service stop
```

## Diagnostics

Use these commands to find configuration and connection problems:

```sh
opencode-agent doctor
opencode-agent gateway logs
opencode-agent opencode service status
opencode-agent opencode debug paths
```

The `doctor` command can start the separate OpenCode service.
It checks the Telegram connection and shows the number of enabled models.
It does not print credentials.

If another process uses the service port, select an available port:

```sh
opencode-agent opencode service set port 49375
opencode-agent gateway restart
```

The Telegram bot must not have an active webhook or another polling process.
The gateway reports these conditions and keeps any existing webhook.
Stop the background gateway before you start a terminal copy.

## Update the repository

1. Update the repository with Git.
2. Run `bun install --frozen-lockfile`.
3. Run `bun run check`.
4. Run `bun test`.
5. Restart the gateway.

When you change an API or client version, test the client and runtime together with `bun run test:live`.
The runtime version is in `packages/telegram/src/runtime.ts`.
The client version is in `packages/telegram/package.json`.

## Acceptance test

Configure a real Telegram bot and sign in to a model provider before this test.

1. Send `/start`.
2. Ask the agent to list the working directory.
3. Check that the typing indicator and a final response appear without extra status messages.
4. Send new instructions while the agent works.
5. Check that the agent uses the instructions in the same session.
6. Send `/stop` to test interruption.
7. Send `/new` to create another session.
8. Use `/sessions` to select the earlier session.
9. Use `/model` and `/agent` to change the selections.
10. Use `/status` to check the selections.
11. Request an action that requires permission under your OpenCode rules.
12. Test **Allow once** and **Reject** with separate permission requests.
13. Check **Always allow** against the resource patterns in its request.
14. Ask the agent to use its question tool.
15. Test a choice, a text reply, and multiple selections.
16. Restart the gateway during a task and during an unanswered question.
17. Check that responses and question controls are available after the restart.
18. Request a long response with code and Unicode characters.
19. Check the message divisions and text format.
20. Use the model picker to change pages and select a variant.
21. Check that each step changes the same message.
22. Select **Yes** when asked to save the default.
23. Send `/new`, then `/status`, to check the saved model and variant.
24. Repeat with **No** to check that the saved default stays unchanged.

Automated tests use a simulated Telegram API.
The live API test uses a real temporary V2 service without a model provider call.
This acceptance test checks the complete connection with a real bot and provider.

To test picker message edits with the configured bot, run:

```sh
OPENCODE_AGENT_TEST_TELEGRAM=1 bun run test:telegram
```

This test sends one Telegram message and changes its pages, selection, and final text.
It also checks the selected default in a new temporary OpenCode session.
It deletes the test message and temporary sessions when it finishes.
It does not call a model or change your saved gateway defaults.
