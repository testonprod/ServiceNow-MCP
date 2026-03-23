# ServiceNow MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI agents to **ServiceNow** for incident management. Deploy it to Azure App Service and connect it to **Microsoft Copilot Studio**, **VS Code**, or any MCP-compatible client.

![Architecture](assets/architecture.png)

## What It Does

This server exposes ServiceNow incident operations as MCP tools that AI agents can call:

| Tool | Description |
|------|-------------|
| `get-servicenow-incidents` | Search incidents with rich filtering (number, state, priority, assigned user, date range, keyword) |
| `create-servicenow-incident` | Create a new incident with full field support |
| `update-servicenow-incident` | Update any incident field (state, priority, assignment, notes, etc.) |
| `delete-servicenow-incident` | Delete an incident by number or sys_id |
| `get-incident-details` | Get all fields for a single incident |
| `add-work-note` | Add internal work notes or customer-visible comments |
| `get-incident-comments` | Retrieve work note and comment history |
| `get-my-incidents` | Get incidents for the authenticated user (caller or assignee) |
| `whoami` | Return the current authenticated user's identity |

## Architecture

```
┌────────────────────┐         ┌─────────────────────┐         ┌────────────────────┐
│                    │   MCP   │                     │  REST   │                    │
│  Copilot Studio /  │ ──────► │  MCP Server         │ ──────► │  ServiceNow        │
│  VS Code / Client  │ ◄────── │  (Azure App Service)│ ◄────── │  Instance          │
│                    │         │                     │         │                    │
└────────────────────┘         └─────────────────────┘         └────────────────────┘
         Agent                    Express + MCP SDK              OAuth2 + REST API
```

**Authentication modes:**
1. **Pass-through** — The client sends a Bearer token; the server forwards it to ServiceNow.
2. **Server-side OAuth** — No token from the client; the server acquires one using stored credentials (ideal for multi-agent scenarios in Copilot Studio where tokens don't flow between agents).

---

## Prerequisites

- [Node.js 22+](https://nodejs.org/) (LTS recommended)
- A **ServiceNow** instance (a [free developer instance](https://developer.servicenow.com/) works)
- An **Azure subscription** (for cloud deployment) — [free trial](https://azure.microsoft.com/free/)
- (Optional) **Microsoft Copilot Studio** access for agent integration

---

## 1. ServiceNow OAuth Setup

You need an OAuth application in ServiceNow so the MCP server can authenticate.

1. Log in to your ServiceNow instance as an admin.
2. Navigate to **System OAuth → Application Registry**.
3. Click **New** → **Create an OAuth API endpoint for external clients**.
4. Fill in:
   - **Name**: `MCP Server` (or any label)
   - **Redirect URL**: `https://localhost/callback` (not used for password grant, but required)
   - **Active**: checked
5. Click **Submit**.
6. Open the record you just created and note the **Client ID** and **Client Secret**.

> **Important:** The user account you configure must have the `itil` role (or equivalent) to read/write incidents via the REST API.

---

## 2. Local Development

### Clone and install

```bash
git clone https://github.com/testonprod/ServiceNow-MCP.git
cd ServiceNow-MCP
npm install
```

### Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
SN_INSTANCE=dev12345
SN_CLIENT_ID=your-client-id-from-step-above
SN_CLIENT_SECRET="your-client-secret"
SN_USERNAME=admin
SN_PASSWORD="your-password"
```

> **Tip:** Wrap values containing special characters (`#`, `!`, etc.) in double quotes.

### Build and run

```bash
npm run build
npm start
```

Or run directly in development mode:

```bash
npm run dev
```

The server starts on `http://localhost:3000`. You can verify it's running:

```bash
curl http://localhost:3000/
# → "ServiceNow MCP Server is running. POST /mcp to interact. GET /auth/config for OAuth setup."
```

### Test with a raw MCP request

```bash
# Initialize the MCP session
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# List available tools
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Call a tool (get incidents)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get-servicenow-incidents","arguments":{"limit":3}}}'
```

---

## 3. Deploy to Azure App Service

### Option A: Azure Portal (quick)

1. Create a new **App Service** (Linux, Node 22 LTS).
2. In **Configuration → Application settings**, add these environment variables:

   | Name | Value |
   |------|-------|
   | `SN_INSTANCE` | Your ServiceNow subdomain (e.g. `dev12345`) |
   | `SN_CLIENT_ID` | OAuth Client ID |
   | `SN_CLIENT_SECRET` | OAuth Client Secret |
   | `SN_USERNAME` | ServiceNow username |
   | `SN_PASSWORD` | ServiceNow password |

3. Set up **Deployment Center** → connect your GitHub fork → select `main` branch.
4. Azure will auto-deploy on push.

### Option B: GitHub Actions (CI/CD)

1. In the Azure Portal, go to your App Service → **Deployment Center** → **Manage publish profile** → **Download**.
2. In your GitHub repo, go to **Settings → Secrets and variables → Actions** → **New repository secret**.
3. Name: `AZURE_WEBAPP_PUBLISH_PROFILE`, Value: paste the contents of the downloaded file.
4. Edit `.github/workflows/deploy-azure.yml` and set `AZURE_WEBAPP_NAME` to your App Service name.
5. Push to `main` — the workflow will build and deploy automatically.

### Option C: Docker

```bash
docker build -t servicenow-mcp .
docker run -p 3000:3000 --env-file .env servicenow-mcp
```

Deploy the container to Azure Container Apps, AWS ECS, or any container host.

---

## 4. Connect to Copilot Studio

### Single Agent (Direct MCP)

1. In [Copilot Studio](https://copilotstudio.microsoft.com/), create or open an agent.
2. Go to **Tools** → **Add a tool** → **Model Context Protocol (MCP)**.
3. Enter the server URL: `https://your-app-name.azurewebsites.net/mcp`
4. For authentication, choose one of:
   - **No authentication** — if your server has `SN_USERNAME`/`SN_PASSWORD` configured (server-side OAuth).
   - **Bearer token** — if you want to pass an OAuth token from the client.
5. Save and test. The agent will see all 9 tools and can call them conversationally.

### Multi-Agent Setup

In Copilot Studio multi-agent scenarios, the parent agent typically does not forward Bearer tokens to child agents. Use **server-side OAuth** (configure `SN_USERNAME`/`SN_PASSWORD` on the App Service) so the MCP server acquires its own token.

1. Create a **child agent** with the MCP connection (as above, no authentication needed).
2. Create a **parent agent** (e.g., "Help Desk Assistant").
3. In the parent agent, add the child agent as a connected agent.
4. The parent delegates ServiceNow tasks to the child, which calls the MCP server.

---

## 5. Connect to VS Code (GitHub Copilot)

Add this to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "servicenow": {
        "type": "http",
        "url": "https://your-app-name.azurewebsites.net/mcp"
      }
    }
  }
}
```

Or for local development:

```json
{
  "mcp": {
    "servers": {
      "servicenow": {
        "type": "http",
        "url": "http://localhost:3000/mcp"
      }
    }
  }
}
```

Then use GitHub Copilot Chat in Agent mode — it will discover the ServiceNow tools automatically.

---

## Project Structure

```
ServiceNow-MCP/
├── src/
│   └── server.ts          # MCP server — all tools and Express setup
├── package.json            # Dependencies and scripts
├── tsconfig.json           # TypeScript configuration
├── Dockerfile              # Multi-stage Docker build
├── .env.example            # Environment variable template
├── .github/
│   └── workflows/
│       └── deploy-azure.yml  # GitHub Actions deployment workflow
└── README.md
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SN_INSTANCE` | Yes | ServiceNow instance subdomain (e.g. `dev12345`) |
| `SN_CLIENT_ID` | Yes | OAuth2 Client ID from ServiceNow Application Registry |
| `SN_CLIENT_SECRET` | Yes | OAuth2 Client Secret |
| `SN_USERNAME` | No* | ServiceNow username for server-side token acquisition |
| `SN_PASSWORD` | No* | ServiceNow password for server-side token acquisition |
| `PORT` | No | HTTP port (default: `3000`) |

\* Required if you want **server-side OAuth** (no client token needed). If clients always send their own Bearer tokens, these can be omitted.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mcp` | MCP protocol endpoint (JSON-RPC over HTTP) |
| `GET` | `/auth/config` | Returns OAuth configuration for client-side flows |
| `GET` | `/` | Health check |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Missing Bearer token` on tool calls | No token provided and `SN_USERNAME`/`SN_PASSWORD` not set | Set the credentials in App Settings or pass a Bearer token |
| `401 Unauthorized` from ServiceNow | Invalid credentials or expired token | Verify OAuth credentials; ensure the user has the `itil` role |
| ServiceNow returns HTML instead of JSON | Instance is hibernating (developer instances sleep after inactivity) | Visit your instance URL in a browser to wake it up |
| `oauth_token.do` fails | Client secret contains special characters | Wrap the value in double quotes in `.env` |
| Tools not appearing in Copilot Studio | MCP endpoint not reachable | Check your App Service is running and the URL is correct |

---

## License

[MIT](LICENSE)

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
