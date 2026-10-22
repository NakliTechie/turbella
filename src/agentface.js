// Publish a page's tools to agents, from the manifest: navigator.modelContext
// (WebMCP) where the browser has it, and window.turbella.tools always. Throws
// if a manifest tool for this page has no handler, so the page fails loudly.

import { toolsFor } from './manifest.js';

export function publishTools(place, handlers) {
  const tools = toolsFor(place);
  for (const t of tools) {
    if (!handlers[t.name]) throw new Error(`manifest tool "${t.name}" has no ${place} handler`);
  }
  window.turbella = { tools: Object.fromEntries(tools.map((t) => [t.name, (args = {}) => handlers[t.name](args)])) };
  if (navigator.modelContext?.registerTool) {
    for (const t of tools) {
      navigator.modelContext.registerTool({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
        execute: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await handlers[t.name](args ?? {})) }] }),
      });
    }
  }
}
