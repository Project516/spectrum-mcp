// The full tool list: the generic collection tools plus the scout-config
// tools, kept in separate files (scout-config-tools.ts imports ToolError and
// friends from tools.ts, so tools.ts cannot import back from it without a
// cycle).
import { SCOUT_CONFIG_TOOLS } from './scout-config-tools.js';
import { TOOLS as GENERIC_TOOLS, type ToolDefinition } from './tools.js';

export const TOOLS: ToolDefinition[] = [...GENERIC_TOOLS, ...SCOUT_CONFIG_TOOLS];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

export { ToolError } from './tools.js';
export type { ToolContext, ToolDefinition } from './tools.js';
