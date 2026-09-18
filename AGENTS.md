# OpenCode Agent development

## Scope

Read `README.md` and `docs/implementation.md` before you change the design.

- Use upstream OpenCode V2 as the agent runtime. Do not copy or fork the runtime.
- Keep model providers, tool execution, sessions, permissions, MCP, and file access in OpenCode.
- Use Telegram as the first interface.
- Add shared transport code only when a second implemented interface requires it.
- Use small OpenCode plugins for additional functions when the plugin lifecycle supports them.
- Keep memory, scheduled tasks, and other interfaces outside the first version.

## Documentation and text

Use ASD-STE100 Simplified Technical English for all documentation and project-written user interface text.
This rule includes README files, design notes, instructions, help text, prompts, and error messages.

- Use approved words with their approved meanings and parts of speech.
- Use necessary technical names and technical verbs consistently. Explain unfamiliar technical terms at first use.
- Keep product names, API names, paths, commands, and code identifiers exact.
- Use a maximum of 20 words per instruction sentence and 25 words per descriptive sentence.
- Put one instruction in each sentence. Use numbered steps for procedures.
- Use the imperative for instructions. Use active voice where possible.
- Use short paragraphs with one subject in each paragraph.
- Use the same term for the same item. Avoid idioms, contractions, promotional text, and unnecessary words.
- Keep technical details and required legal text accurate when you simplify them.
- Do not claim verified ASD-STE100 compliance without a check against the standard and its dictionary.

Keep terminal output plain. Do not add boxes, banners, colors, icons, or decorative lines.
Use short prompts and plain status messages. Hide credentials during input.

## Implementation

- Check API and plugin behavior against the V2 documentation and the installed upstream API.
- Do not assume that V1 examples apply to V2.
- Record design decisions in `docs/implementation.md`. Identify open questions separately.
- Add dependencies and build tools only when the implementation requires them.
- Keep bot tokens, credentials, and local runtime data out of version control.
- Keep the unofficial-project notice near the top of `README.md`.
- Run the checks for each change. Keep documented commands current.

## Current version

- Use Linux, Bun, TypeScript, grammY, and the official V2 client.
- Accept messages from one owner in a private Telegram chat. Use long polling.
- Give the agent a separate V2 binary, HOME/XDG directories, credentials, service registration, and loopback port.
- Do not connect to or change an existing host OpenCode installation without an explicit user instruction.
- Run `bun run check` and `bun test` for implementation changes.
- Use `bun run test:live` only with a temporary `OPENCODE_AGENT_HOME` directory under `/tmp/opencode`.
- Keep the runtime and client versions matched. Check the upstream API when you update them.
