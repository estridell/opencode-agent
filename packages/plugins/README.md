# Personal-agent plugins

`context.ts` adds the OpenCode Agent role and Telegram environment to model requests.
Its `context` hook appends the note after the existing system instructions.
It applies to Telegram gateway sessions and their descendants.
It preserves the model-specific base prompt, custom agent instructions, and tools.

The plugin registers no tools and stores no memory.
Its only import contains development types and is removed when OpenCode loads the TypeScript file.

The gateway installs a copy in the separate runtime's global plugin directory.
A changed copy triggers an OpenCode restart during startup.
Edit `applicationContext` in `context.ts` to change the note through a normal application update.

Add a plugin only when a specific function requires it and the V2 plugin API supports it.
