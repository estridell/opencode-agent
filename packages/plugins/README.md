# Bundled OpenCode plugins

This directory contains the application's OpenCode V2 server plugins.
The updater supports additions, changes, renames, and removals without restarting Telegram or OpenCode.

## Plugin layout

1. Add a standalone `.ts` or `.js` plugin directly to this directory, or add a plugin package directory.
2. Export a V2 plugin definition as the default export.
3. For a package, use a `server` entrypoint, a package `main` entrypoint, or an `index` file.
4. Keep helper modules and data files inside the plugin package directory.
5. Declare package dependencies in its `package.json`.
6. Include dependency-bearing plugin packages in the root `workspaces` list.

OpenCode loads each direct `.ts` or `.js` file as a separate plugin.
Declaration files, hidden entries, and `node_modules` are excluded.
Directories without a server entrypoint or package manifest can contain shared files.

The installer creates managed entrypoint files in the separate runtime's global plugin directory.
Each entrypoint imports its plugin from the selected application directory.
Relative imports, assets, and installed package dependencies therefore resolve from the plugin's source location.
An inventory identifies the generated files, so removal does not affect unrelated user plugins.

OpenCode watches the entrypoints and their local imports.
It automatically loads, reloads, or unloads plugins when the installed set changes.
Reconnection uses the current installed set, including an empty set after all bundled plugins are removed.

## Application context

`context.ts` adds the OpenCode Agent role and Telegram environment to model requests.
Its `context` hook appends the note after the existing system instructions.
It applies to Telegram gateway sessions and their descendants.
It preserves the model-specific base prompt, custom agent instructions, and tools.

The plugin registers no tools and stores no memory.
An active model request keeps its current instructions; subsequent requests receive the new note after reload.
Edit `applicationContext` in `context.ts` to change the note through a normal application update.
