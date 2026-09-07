# Official ServiceNow MCP Server — What It Is & How to Set It Up

This folder documents ServiceNow's **native, official MCP Server** (the "MCP Server Console", part of
**AI Agent Studio** / **Now Assist**) — as opposed to this repository, which is a **custom, self-hosted**
MCP server that we built and deploy to Azure App Service.

Use this as a reference if you want to evaluate or adopt the official offering alongside (or instead of)
the custom server in this repo.

---

## 1. Where does it run? (the question everyone asks first)

**The official MCP Server is hosted *inside* your ServiceNow instance itself — not on Azure, AWS, or any
external host.** There is nothing to deploy or run outside ServiceNow.

| | This repo (custom) | Official ServiceNow MCP Server |
|---|---|---|
| **Hosting** | Self-hosted — you deploy the Node.js app to Azure App Service (or any host) | Native — runs on the ServiceNow instance itself (Now Platform) |
| **What you deploy** | This repository's code | Nothing — it's a plugin/capability you *activate*, not code you write |
| **Where config lives** | `.env` file / App Service application settings | ServiceNow system properties, OAuth Application Registry, and the MCP Server Console UI |
| **Auth model** | Agent-supplied OAuth token, forwarded by our server to ServiceNow | OAuth 2.0 (auth-code + PKCE) brokered via ServiceNow's Machine Identity Console; governed by the AI Control Tower |
| **Tool surface** | Whatever we hand-write (currently: incident CRUD, work notes, `whoami`) | Now Assist skills, Knowledge Graph search, Flow Designer subflows/actions, scripted REST steps, playbooks — configured via UI, no code |
| **Table API (raw CRUD on any table)** | Yes — this is exactly what our tools do | **No** — ServiceNow states the Table API "cannot be converted to MCP tools regardless of configuration" |
| **Licensing** | Free (your own infra cost only) | Requires a **Now Assist / AI-Native SKU entitlement** |
| **Minimum release** | N/A (external) | Zurich (2025), P9+ for custom tools (Australia release: P2+) |
| **Governance/audit** | Whatever we add ourselves | Built-in: AI Control Tower, AI Gateway, per-tool permissions, instance audit logs |

**Bottom line:** the official server is not an alternative *deployment target* for our code — it's a
completely different mechanism you turn on *inside* ServiceNow. You don't choose "Azure vs. official
hosting" for the same server; you choose between two different products with different tool surfaces.

---

## 2. How the official MCP Server works

1. ServiceNow ships an **MCP Server Console** (part of the `sn_mcp_server` capability) as of the
   **Zurich** release, bundled with **Now Assist** / AI Agent Studio.
2. Administrators enable it and use the console UI to decide **which capabilities are exposed as MCP
   tools**: Now Assist skills, Knowledge Graph semantic search, Flow Designer subflows/actions, scripted
   REST endpoints, and playbooks.
3. External AI clients (Claude, Copilot Studio, custom agents) connect to the instance's MCP endpoint and
   authenticate via **OAuth 2.0 with PKCE**, brokered through the **Machine Identity Console** — no
   passwords or client secrets handled by a third-party server.
4. Every tool call is routed through the **AI Control Tower**, which enforces role-based access control,
   rate limits, and produces an audit trail — all inside ServiceNow, with nothing to log or secure on your
   side.
5. Raw Table API access (arbitrary CRUD on any table) is **intentionally excluded** — the official server
   is designed around governed, higher-level business actions, not generic data-plane access.

## 3. What you'd need to do to use it

Since it's a platform capability rather than code, setup happens **inside ServiceNow**, not in this repo:

1. **Confirm your release & entitlement** — you need Zurich (or later) and a Now Assist / AI-Native SKU.
2. **Activate the MCP Server capability** (`sn_mcp_server`) — typically via Plugin/Store activation,
   done by a ServiceNow admin.
3. **Open the MCP Server Console** and choose which tools to expose:
   - Now Assist skills
   - Knowledge Graph search
   - Flow Designer subflows / actions
   - Scripted REST steps
   - Playbooks
4. **Register the AI client** in the **Machine Identity Console** so it can complete the OAuth 2.0 + PKCE
   flow (this replaces the "Application Registry" OAuth step used in our custom server).
5. **Assign roles/ACLs** to control which users/agents can invoke which tools.
6. **Point your MCP client** (Claude, Copilot Studio, etc.) at the instance's MCP endpoint URL and
   credentials from the Machine Identity Console.

There is **no `.env` file or environment-variable setup** for the native server — all configuration lives
in ServiceNow records and UI, not on a filesystem. This is different from our repo, where `SN_INSTANCE`
and `SN_CLIENT_ID` are read from environment variables (see the root [`.env.example`](../../.env.example)
and the main [`README.md`](../../README.md#environment-variables-reference)).

## 4. When to use which

- **Use the official/native MCP Server** if you're already on Zurich+ with a Now Assist entitlement, want
  governed access to Now Assist skills/flows/playbooks, and don't need raw Table API access.
- **Keep this repo's custom server** if you need direct, arbitrary table access (incidents today, other
  tables tomorrow), want to run on any ServiceNow release, don't have a Now Assist entitlement, or want
  full control over hosting and cost.
- **Both can run side by side** — they don't conflict, since they expose different tool names/surfaces.
  Native tells an agent what ServiceNow "means" (skills, summaries); a custom server like this one tells
  it what ServiceNow "contains" (raw records).

## 5. References

- ServiceNow Community: *Understanding MCP: How ServiceNow Connects, Discovers, and Governs*
- ServiceNow docs: *MCP Server Console* (Intelligent Experiences documentation set — search "MCP Server"
  on `docs.servicenow.com` for your release)
- [modelcontextprotocol.io](https://modelcontextprotocol.io/) — the underlying open MCP specification
