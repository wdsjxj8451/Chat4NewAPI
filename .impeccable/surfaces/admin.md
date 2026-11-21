# Admin console

Mode: Operate

## Direction contract

**Thesis.** Connect a model gateway first, then manage its available models and the people who use them.

**Own-world.** Inherit porcelain, graphite, and iris from the Chat4NewAPI workspace. Keep section rules light, tables compact, and status colours semantic.

**Story.** An administrator enters a compatible aggregation endpoint and key, tests the connection, reviews returned models, and edits shared chat settings without exposing credentials to visitors.

**First viewport.** A restrained top bar leads to a wide centered workspace. A clear page title and connection state sit above navigation tabs. The gateway form spans the width; below it, the model directory and concise connection guidance share a two-column row. On smaller screens, the form stacks and guidance follows the model list.

**Form.** Assigned surface structure, first of three: a connection-first wide workspace, seed:d376ac21e4900afd. The signature interaction is a single save-and-test action that turns the connection status into a clear result.

**Finish.** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Current refinement

Support generic Anthropic Messages-compatible aggregation services such as New API and Sub2API without bundling a model gateway into the chat application. Add an administrator-editable system prompt and keep the existing authentication, model capability, user, usage, and appearance workflows available. The previous admin implementation is backed up under `.impeccable/backups/admin-current/`.
