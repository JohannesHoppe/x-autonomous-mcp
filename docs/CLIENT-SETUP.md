# Client Setup

Pick your client below. You only need one.

In all examples, replace `/absolute/path/to/x-autonomous-mcp` with the actual path where the repo was cloned, and replace the credential values with the real keys from your X Developer Portal.

---

### Claude Code

```bash
claude mcp add --scope user x-twitter -- node /absolute/path/to/x-autonomous-mcp/dist/index.js
```

Then restart Claude Code. Verify with `claude mcp list` — the output should show `x-twitter: ... - Connected`.

### Claude Desktop

Add to `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/absolute/path/to/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "value",
        "X_API_SECRET": "value",
        "X_ACCESS_TOKEN": "value",
        "X_ACCESS_TOKEN_SECRET": "value",
        "X_BEARER_TOKEN": "value"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Cursor

Add to the Cursor MCP config:

- **Global** (all projects): `~/.cursor/mcp.json`
- **Project-scoped**: `.cursor/mcp.json` in your project root

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/absolute/path/to/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "value",
        "X_API_SECRET": "value",
        "X_ACCESS_TOKEN": "value",
        "X_ACCESS_TOKEN_SECRET": "value",
        "X_BEARER_TOKEN": "value"
      }
    }
  }
}
```

Verify in Cursor: Settings > MCP Servers — the server should appear as connected.

### OpenAI Codex

**Option A — CLI:**

```bash
codex mcp add x-twitter \
  --env X_API_KEY=value \
  --env X_API_SECRET=value \
  --env X_ACCESS_TOKEN=value \
  --env X_ACCESS_TOKEN_SECRET=value \
  --env X_BEARER_TOKEN=value \
  -- node /absolute/path/to/x-autonomous-mcp/dist/index.js
```

**Option B — config.toml:**

Add to `~/.codex/config.toml` (global) or `.codex/config.toml` (project-scoped):

```toml
[mcp_servers.x-twitter]
command = "node"
args = ["/absolute/path/to/x-autonomous-mcp/dist/index.js"]

[mcp_servers.x-twitter.env]
X_API_KEY = "value"
X_API_SECRET = "value"
X_ACCESS_TOKEN = "value"
X_ACCESS_TOKEN_SECRET = "value"
X_BEARER_TOKEN = "value"
```

The CLI and the Codex VS Code extension share this config — set it up once and both work.

### Windsurf

Add to the Windsurf MCP config:

- **macOS**: `~/.codeium/windsurf/mcp_config.json`
- **Windows**: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/absolute/path/to/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "value",
        "X_API_SECRET": "value",
        "X_ACCESS_TOKEN": "value",
        "X_ACCESS_TOKEN_SECRET": "value",
        "X_BEARER_TOKEN": "value"
      }
    }
  }
}
```

Can also be added from Windsurf Settings > Cascade > MCP Servers.

### Cline (VS Code)

Open Cline's MCP settings: click the MCP Servers icon in Cline's top navigation bar, then click "Configure MCP Servers" to open `cline_mcp_settings.json`. Add:

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/absolute/path/to/x-autonomous-mcp/dist/index.js"],
      "env": {
        "X_API_KEY": "value",
        "X_API_SECRET": "value",
        "X_ACCESS_TOKEN": "value",
        "X_ACCESS_TOKEN_SECRET": "value",
        "X_BEARER_TOKEN": "value"
      },
      "alwaysAllow": [],
      "disabled": false
    }
  }
}
```

### OpenClaw (ClawdBot)

OpenClaw has no native MCP support yet. MCP servers are integrated via [mcporter](https://github.com/nichochar/mcporter):

```bash
npm install -g mcporter
```

Register the server:

```bash
mcporter config add twitter \
  --command "node" --arg "/absolute/path/to/x-autonomous-mcp/dist/index.js" \
  --env "X_API_KEY=value" \
  --env "X_API_SECRET=value" \
  --env "X_ACCESS_TOKEN=value" \
  --env "X_ACCESS_TOKEN_SECRET=value" \
  --env "X_BEARER_TOKEN=value" \
  --scope home
```

Verify with `mcporter list twitter --schema`. Agents call tools via `exec`:

```bash
mcporter call twitter.search_tweets query="AI" max_results=10
mcporter call twitter.reply_to_tweet tweet_id="123" text="Hello"
```

### Any Other MCP Client

This is a standard stdio MCP server. Point your client at:

```
node /absolute/path/to/x-autonomous-mcp/dist/index.js
```

With environment variables: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_BEARER_TOKEN`.
