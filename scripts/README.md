# Scripts

The main installer is [`install.sh`](../install.sh) in the repository root.
This location lets a user download it as one script.

Setup and systemd installation commands are in `packages/telegram/src/`.

| Command | Function |
| --- | --- |
| `bun run setup` | Run the setup procedure |
| `bun run service:install` | Install the systemd user service |
| `bun run test:live` | Test the API with a temporary V2 service |

Add maintenance scripts to this directory when required.
