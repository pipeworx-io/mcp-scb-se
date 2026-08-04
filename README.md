# @pipeworx/scb-se

[Statistics Sweden (SCB)](https://www.scb.se) MCP — PxWeb JSON-stat API serving the Swedish statistical database. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `subjects(path?)` — navigate the subject tree (root or sub-path)
- `table_meta(path)` — table definition (dimensions, valid values)
- `query_table(path, body)` — request data from a table; `body` is a PxWeb query (`{query: [{code, selection: ...}], response: {format: "json-stat2"}}`)

## Data source

`https://api.scb.se/OV0104/v1/doris/en/ssd/`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "scb-se": {
      "url": "https://gateway.pipeworx.io/scb-se/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Scb Se data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
