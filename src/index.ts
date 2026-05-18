interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Statistics Sweden PxWeb MCP.
 */


const BASE = 'https://api.scb.se/OV0104/v1/doris/en/ssd';
const UA = 'pipeworx-mcp-scb-se/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'subjects',
    description: 'Navigate the subject tree.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Sub-path under /ssd/ (default empty = root).' } },
    },
  },
  {
    name: 'table_meta',
    description: 'Table definition (dimensions, valid values).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'e.g. "BE/BE0101/BE0101A/BefolkningNy"' } },
      required: ['path'],
    },
  },
  {
    name: 'query_table',
    description: 'Pull data from a table. body is a PxWeb query object.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        body: { type: 'object', description: '{query: [{code, selection: {filter, values}}], response: {format: "json-stat2"}}' },
      },
      required: ['path', 'body'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'subjects': {
      const path = (args.path as string | undefined)?.replace(/^\/+|\/+$/g, '') ?? '';
      return scbGet(path ? `/${path}` : '');
    }
    case 'table_meta':
      return scbGet(`/${reqStr(args, 'path', '"BE/BE0101/BE0101A/BefolkningNy"').replace(/^\/+|\/+$/g, '')}`);
    case 'query_table': {
      const path = reqStr(args, 'path', '"BE/BE0101/BE0101A/BefolkningNy"').replace(/^\/+|\/+$/g, '');
      const body = args.body;
      if (!body || typeof body !== 'object') throw new Error('body must be a PxWeb query object.');
      const res = await fetch(`${BASE}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`SCB: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
      return res.json();
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function scbGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`SCB: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  return res.json();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
