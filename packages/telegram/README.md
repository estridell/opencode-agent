# Telegram gateway

This package connects one owner's private Telegram chat to OpenCode V2.
It also supplies terminal commands and setup.

| File | Function |
| --- | --- |
| `src/main.ts` | Terminal commands and process control |
| `src/setup.ts` | Setup procedure |
| `src/prompts.ts` | Plain terminal prompts and hidden token input |
| `src/service.ts` | Linux user-service installation |
| `src/runtime.ts` | Separate upstream V2 installation and environment |
| `src/opencode.ts` | Official client connection |
| `src/gateway.ts` | Telegram commands, sessions, events, and state checks |
| `src/forms.ts` | OpenCode questions and answers |
| `src/pickers.ts` | Single-message pickers and checks for expired buttons |
| `src/images.ts` | Telegram image downloads and OpenCode attachments |
| `src/telegram.ts` | Telegram message delivery and rate control |
| `src/format.ts` | Telegram text formatting |
| `src/store.ts` | SQLite storage for gateway data |
| `test/` | Automated gateway tests and a live V2 API test |

Run development commands from the repository root:

```sh
bun run check
bun test
bun run setup
bun start
```

See [Implementation](../../docs/implementation.md) for design decisions and limits.
