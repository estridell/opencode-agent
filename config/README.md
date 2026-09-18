# Configuration

`telegram.example.json` shows the Telegram gateway settings.
The setup command saves these settings in `~/.opencode-agent/config.json`.

Setup checks the bot token and asks for your numeric Telegram user ID.
Keep credentials in the local configuration file. Do not add them to this repository.

`autoApprove` defaults to `true`, including in existing configurations without this field.
The gateway approves pending OpenCode permission requests once, without Telegram prompts.
This applies to bot sessions and their child sessions.
Explicit deny rules still apply, and questions still require an answer.

To use manual permission buttons:

1. Set `"autoApprove": false` in `~/.opencode-agent/config.json`.
2. Run `opencode-agent gateway restart`.

Setup preserves this setting when you change the other configuration values.

OpenCode configuration is separate from Telegram configuration.
Its directory is `runtime/config/opencode/` inside the agent installation.
See [Installation and operation](../docs/installation.md) for all paths.
