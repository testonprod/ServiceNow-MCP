# ServiceNow MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI agents to **ServiceNow** for incident management. The agent authenticates via **OAuth 2.0** and passes its Bearer token to the server — **no credentials are stored on the server**.

Deploy to Azure App Service and connect to **Microsoft Copilot Studio**, **VS Code**, or any MCP-compatible client.

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
│                    │  Bearer  │                     │  REST   │                    │
│  Agent (Copilot    │  Token   │  MCP Server         │ ──────► │  ServiceNow        │
│  Studio / VS Code) │ ──────► │  (Azure App Service)│ ◄────── │  Instance          │
│                    │   MCP   │                     │         │                    │
└────────────────────┘         └─────────────────────┘         └────────────────────┘
```

**Authentication:** The agent obtains an OAuth token from ServiceNow and includes it as `Authorization: Bearer <token>` in every MCP request. The server forwards that token to ServiceNow — it never stores credentials or acquires tokens itself.

---

## Prerequisites

- [Node.js 22+](https://nodejs.org/) (LTS recommended)
- A **ServiceNow** instance (a [free developer instance](https://developer.servicenow.com/) works)
- An **Azure subscription** (for cloud deployment) — [free trial](https://azure.microsoft.com/free/)
- (Optional) **Microsoft Copilot Studio** access for agent integration

---

## 1. ServiceNow OAuth Setup

Create an OAuth application in ServiceNow so agents can authenticate.

1. Log in to your ServiceNow instance as an admin.
2. Navigate to **System OAuth → Application Registry**.
3. Click **New** → **Create an OAuth API endpoint for external clients**.
4. Fill in:
   - **Name**: `MCP Server` (or any label)
   - **Redirect URL**: your agent's OAuth callback URL
   - **Active**: checked
5. Click **Submit**.
6. Open the record you just created and note the **Client ID**.

> **Important:** The ServiceNow user account the agent authenticates as must have the `itil` role (or equivalent) to read/write incidents via the REST API.

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

Edit `.env`:

```env
SN_INSTANCE=dev12345
SN_CLIENT_ID=your-client-id-from-step-above
```

That's it — no passwords, no client secrets on the server.

### Build and run

```bash
npm run build
npm start
```

Or run directly in development mode:

```bash
npm run dev
```

The server starts on `http://localhost:3000`. Verify:

```bash
curl http://localhost:3000/
# → "MCP Server (OAuth) is running. POST /mcp with Bearer token to interact. GET /auth/config for OAuth setup."
```

### Test with a raw MCP request

First, obtain an OAuth token from ServiceNow (your agent does this automatically in production):

```bash
TOKEN="your-oauth-bearer-token"

# Initialize the MCP session
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# Call a tool (get P1 incidents)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get-servicenow-incidents","arguments":{"priority":"1","limit":5}}}'
```

---

## 3. Deploy to Azure App Service

### Option A: Azure Portal (quick)

1. Create a new **App Service** (Linux, Node 22 LTS).
2. In **Configuration → Application settings**, add:

   | Name | Value |
   |------|-------|
   | `SN_INSTANCE` | Your ServiceNow subdomain (e.g. `dev12345`) |
   | `SN_CLIENT_ID` | OAuth Client ID |

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

1. In [Copilot Studio](https://copilotstudio.microsoft.com/), create or open an agent.
2. Go to **Tools** → **Add a tool** → **Model Context Protocol (MCP)**.
3. Enter the server URL: `https://your-app-name.azurewebsites.net/mcp`
4. For authentication, select **OAuth 2.0** and configure:
   - **Authorization URL**: `https://<instance>.service-now.com/oauth_auth.do`
   - **Token URL**: `https://<instance>.service-now.com/oauth_token.do`
   - **Client ID**: your ServiceNow OAuth Client ID
   - **Scopes**: `useraccount`
5. Save and test. The agent will see all 9 tools and can call them conversationally.

> **Tip:** The server exposes `GET /auth/config` which returns the OAuth URLs and Client ID — useful for programmatic agent setup.

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
| `PORT` | No | HTTP port (default: `3000`) |

The server does **not** store `SN_CLIENT_SECRET`, `SN_USERNAME`, or `SN_PASSWORD`. The agent handles OAuth authentication and passes the Bearer token per-request.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mcp` | MCP protocol endpoint (JSON-RPC over HTTP). Requires `Authorization: Bearer <token>` header. |
| `GET` | `/auth/config` | Returns OAuth configuration (URLs, Client ID) for agent-side flows |
| `GET` | `/` | Health check |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No Bearer token provided` on tool calls | Agent didn't send `Authorization` header | Configure OAuth on the agent; ensure it sends `Bearer <token>` |
| `401 Unauthorized` from ServiceNow | Invalid or expired token | Ensure the agent refreshes tokens; verify the user has the `itil` role |
| ServiceNow returns HTML instead of JSON | Instance is hibernating (developer instances sleep after inactivity) | Visit your instance URL in a browser to wake it up |
| Tools not appearing in Copilot Studio | MCP endpoint not reachable | Check your App Service is running and the URL is correct |

---

## License

[MIT](LICENSE)

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
