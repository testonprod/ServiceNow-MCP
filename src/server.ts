import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import dotenv from "dotenv";
dotenv.config();

const server = new McpServer({
  name: "servicenow-mcp",
  version: "1.0.0",
});

// ========== AUTH: OAuth (pass-through or server-side) ==========

// AsyncLocalStorage carries the Bearer token from the Express request into MCP tool handlers
const tokenStore = new AsyncLocalStorage<string>();

const SN_INSTANCE = process.env.SN_INSTANCE!;
const SN_CLIENT_ID = process.env.SN_CLIENT_ID!;
const SN_CLIENT_SECRET = process.env.SN_CLIENT_SECRET!;
const SN_USERNAME = process.env.SN_USERNAME;
const SN_PASSWORD = process.env.SN_PASSWORD;

const SN_BASE = `https://${SN_INSTANCE}.service-now.com`;
const SN_BASE_URL = `${SN_BASE}/api/now/table/incident`;

// Server-side OAuth token cache
let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getServerToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at) return cachedToken.access_token;
  if (!SN_USERNAME || !SN_PASSWORD) throw new Error("No Bearer token provided and SN_USERNAME/SN_PASSWORD not configured for server-side OAuth.");
  const res = await fetch(`${SN_BASE}/oauth_token.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: SN_CLIENT_ID,
      client_secret: SN_CLIENT_SECRET,
      username: SN_USERNAME,
      password: SN_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`Failed to obtain server-side OAuth token (HTTP ${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(`OAuth token error: ${data.error_description || data.error}`);
  cachedToken = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function getAuthHeader(): Promise<string> {
  const clientToken = tokenStore.getStore();
  if (clientToken) return `Bearer ${clientToken}`;
  const serverToken = await getServerToken();
  return `Bearer ${serverToken}`;
}

async function snRequest(path: string, method: string, body?: Record<string, unknown>) {
  const auth = await getAuthHeader();
  const res = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: auth,
      "User-Agent": "ServiceNow-MCP/1.0",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ServiceNow error (${res.status}): ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Resolve the current authenticated user's sys_id and username
async function getCurrentUser(): Promise<{ sys_id: string; user_name: string; name: string; email: string }> {
  const url = `${SN_BASE}/api/now/table/sys_user?sysparm_query=user_name=javascript:gs.getUserName()&sysparm_limit=1&sysparm_fields=sys_id,user_name,name,email`;
  const data = await snRequest(url, "GET");
  if (!data?.result?.length) throw new Error("Could not identify the authenticated user from the OAuth token.");
  return data.result[0];
}

async function resolveIncidentSysId(identifier: string): Promise<string> {
  if (/^[a-f0-9]{32}$/.test(identifier)) return identifier;
  const data = await snRequest(
    `${SN_BASE_URL}?sysparm_query=number=${encodeURIComponent(identifier)}&sysparm_limit=1&sysparm_fields=sys_id`,
    "GET"
  );
  if (!data?.result?.length) throw new Error(`Incident not found: ${identifier}`);
  return data.result[0].sys_id;
}

// ========== GET INCIDENTS ==========

server.tool(
  "get-servicenow-incidents",
  "Search and retrieve ServiceNow incidents. Supports filtering by incident number, assigned user, assignment group, state, priority, category, date range, and keyword search.",
  {
    number: z.string().optional().describe("Incident number (e.g. INC0010001) or comma-separated numbers"),
    assigned_to: z.string().optional().describe("User ID or display name to filter by assigned user"),
    assignment_group: z.string().optional().describe("Assignment group name (e.g. Network, Database, Desktop Support)"),
    state: z.string().optional().describe("State: 1=New, 2=In Progress, 3=On Hold, 6=Resolved, 7=Closed. Use 'open' for all active"),
    priority: z.string().optional().describe("Priority: 1=Critical, 2=High, 3=Moderate, 4=Low, 5=Planning"),
    category: z.string().optional().describe("Category (e.g. software, hardware, network, inquiry)"),
    short_description: z.string().optional().describe("Keyword to search in short description"),
    created_after: z.string().optional().describe("Show incidents created after this date (YYYY-MM-DD)"),
    created_before: z.string().optional().describe("Show incidents created before this date (YYYY-MM-DD)"),
    order_by: z.string().optional().describe("Sort field (prefix with - for descending). Default: -opened_at"),
    limit: z.number().optional().describe("Number of incidents to retrieve (default 10, max 100)"),
  },
  async (params) => {
    const queryParts: string[] = [];

    if (params.number?.trim()) {
      const numbers = params.number.split(",").map(n => n.trim()).filter(Boolean);
      if (numbers.length === 1) {
        queryParts.push(`number=${numbers[0]}`);
      } else {
        queryParts.push(`numberIN${numbers.join(",")}`);
      }
    }
    if (params.assigned_to?.trim()) queryParts.push(`assigned_to=${params.assigned_to.trim()}`);
    if (params.assignment_group?.trim()) queryParts.push(`assignment_group=${params.assignment_group.trim()}`);
    if (params.state?.trim()) {
      if (params.state.toLowerCase() === "open") {
        queryParts.push("stateIN1,2,3");
      } else {
        queryParts.push(`state=${params.state.trim()}`);
      }
    }
    if (params.priority?.trim()) queryParts.push(`priority=${params.priority.trim()}`);
    if (params.category?.trim()) queryParts.push(`category=${params.category.trim()}`);
    if (params.short_description?.trim()) queryParts.push(`short_descriptionLIKE${params.short_description.trim()}`);
    if (params.created_after?.trim()) queryParts.push(`sys_created_on>${params.created_after.trim()}`);
    if (params.created_before?.trim()) queryParts.push(`sys_created_on<${params.created_before.trim()}`);

    const orderBy = params.order_by?.trim() || "-opened_at";
    const orderDir = orderBy.startsWith("-") ? "ORDERBYDESC" : "ORDERBY";
    const orderField = orderBy.replace(/^-/, "");
    queryParts.push(`${orderDir}${orderField}`);

    const sysparm_query = queryParts.join("^");
    const sysparm_limit = Math.min(params.limit ?? 10, 100);

    const url = `${SN_BASE_URL}?sysparm_limit=${sysparm_limit}&sysparm_query=${encodeURIComponent(sysparm_query)}&sysparm_display_value=true&sysparm_fields=sys_id,number,short_description,state,priority,assigned_to,assignment_group,category,opened_at,sys_updated_on`;

    const data = await snRequest(url, "GET");
    const incidents = data.result.map((i: any) =>
      `#${i.number}: ${i.short_description} | State: ${i.state} | Priority: ${i.priority} | Assigned to: ${i.assigned_to || "Unassigned"} | Group: ${i.assignment_group || "None"} | Opened: ${i.opened_at}`
    ).join("\n");

    return {
      content: [{ type: "text", text: incidents || "No incidents found matching the criteria." }],
    };
  }
);

// ========== CREATE INCIDENT ==========

server.tool(
  "create-servicenow-incident",
  "Create a new ServiceNow incident.",
  {
    short_description: z.string().describe("Brief summary of the incident (required)"),
    description: z.string().optional().describe("Detailed description of the incident"),
    priority: z.string().optional().describe("Priority level (1=Critical, 2=High, 3=Moderate, 4=Low, 5=Planning)"),
    urgency: z.string().optional().describe("Urgency level (1=High, 2=Medium, 3=Low)"),
    impact: z.string().optional().describe("Impact level (1=High, 2=Medium, 3=Low)"),
    assigned_to: z.string().optional().describe("User ID or name to assign the incident to"),
    assignment_group: z.string().optional().describe("Assignment group name"),
    category: z.string().optional().describe("Category (e.g. software, hardware, network, inquiry)"),
    subcategory: z.string().optional().describe("Subcategory (e.g. email, OS, DNS, DHCP, vpn)"),
    caller_id: z.string().optional().describe("User ID or name of the caller/requester"),
    cmdb_ci: z.string().optional().describe("Configuration item / affected service name"),
    work_notes: z.string().optional().describe("Internal work notes (not visible to caller)"),
  },
  async (params) => {
    const body: Record<string, unknown> = { short_description: params.short_description };
    if (params.description) body.description = params.description;
    if (params.priority) body.priority = params.priority;
    if (params.urgency) body.urgency = params.urgency;
    if (params.impact) body.impact = params.impact;
    if (params.assigned_to) body.assigned_to = params.assigned_to;
    if (params.assignment_group) body.assignment_group = params.assignment_group;
    if (params.category) body.category = params.category;
    if (params.subcategory) body.subcategory = params.subcategory;
    if (params.caller_id) body.caller_id = params.caller_id;
    if (params.cmdb_ci) body.cmdb_ci = params.cmdb_ci;
    if (params.work_notes) body.work_notes = params.work_notes;

    const data = await snRequest(SN_BASE_URL, "POST", body);
    const inc = data.result;

    return {
      content: [{
        type: "text",
        text: `Incident created successfully.\nNumber: ${inc.number}\nSys ID: ${inc.sys_id}\nShort Description: ${inc.short_description}`,
      }],
    };
  }
);

// ========== UPDATE INCIDENT ==========

server.tool(
  "update-servicenow-incident",
  "Update an existing ServiceNow incident by number or sys_id.",
  {
    identifier: z.string().describe("The incident number (e.g. INC0010001) or sys_id to update"),
    short_description: z.string().optional().describe("Updated short description"),
    description: z.string().optional().describe("Updated detailed description"),
    state: z.string().optional().describe("Incident state (1=New, 2=In Progress, 3=On Hold, 6=Resolved, 7=Closed)"),
    priority: z.string().optional().describe("Priority level (1=Critical, 2=High, 3=Moderate, 4=Low, 5=Planning)"),
    urgency: z.string().optional().describe("Urgency level (1=High, 2=Medium, 3=Low)"),
    impact: z.string().optional().describe("Impact level (1=High, 2=Medium, 3=Low)"),
    assigned_to: z.string().optional().describe("User ID or name to reassign"),
    assignment_group: z.string().optional().describe("Assignment group name to reassign to"),
    category: z.string().optional().describe("Updated category"),
    work_notes: z.string().optional().describe("Internal work notes — visible only to IT staff"),
    comments: z.string().optional().describe("Customer-visible comments"),
    hold_reason: z.string().optional().describe("Reason for putting on hold (1=Awaiting Caller, 2=Awaiting Change, 3=Awaiting Problem, 4=Awaiting Vendor)"),
    close_notes: z.string().optional().describe("Notes when resolving or closing the incident"),
    close_code: z.string().optional().describe("Close code (e.g. Solved (Permanently), Closed/Resolved by Caller)"),
  },
  async (params) => {
    const sysId = await resolveIncidentSysId(params.identifier);

    const body: Record<string, unknown> = {};
    if (params.short_description) body.short_description = params.short_description;
    if (params.description) body.description = params.description;
    if (params.state) body.state = params.state;
    if (params.priority) body.priority = params.priority;
    if (params.urgency) body.urgency = params.urgency;
    if (params.impact) body.impact = params.impact;
    if (params.assigned_to) body.assigned_to = params.assigned_to;
    if (params.assignment_group) body.assignment_group = params.assignment_group;
    if (params.category) body.category = params.category;
    if (params.work_notes) body.work_notes = params.work_notes;
    if (params.comments) body.comments = params.comments;
    if (params.hold_reason) body.hold_reason = params.hold_reason;
    if (params.close_notes) body.close_notes = params.close_notes;
    if (params.close_code) body.close_code = params.close_code;

    const data = await snRequest(`${SN_BASE_URL}/${sysId}`, "PATCH", body);
    const inc = data.result;

    return {
      content: [{
        type: "text",
        text: `Incident updated successfully.\nNumber: ${inc.number}\nState: ${inc.state}\nShort Description: ${inc.short_description}`,
      }],
    };
  }
);

// ========== DELETE INCIDENT ==========

server.tool(
  "delete-servicenow-incident",
  "Delete a ServiceNow incident by sys_id or incident number.",
  {
    identifier: z.string().describe("The incident number (e.g. INC0010001) or sys_id to delete"),
  },
  async (params) => {
    const sysId = await resolveIncidentSysId(params.identifier);
    await snRequest(`${SN_BASE_URL}/${sysId}`, "DELETE");
    return {
      content: [{ type: "text", text: `Incident ${params.identifier} deleted successfully.` }],
    };
  }
);

// ========== GET INCIDENT DETAILS ==========

server.tool(
  "get-incident-details",
  "Get full details of a single ServiceNow incident by number or sys_id.",
  {
    identifier: z.string().describe("The incident number (e.g. INC0010001) or sys_id"),
  },
  async (params) => {
    const sysId = await resolveIncidentSysId(params.identifier);
    const url = `${SN_BASE_URL}/${sysId}?sysparm_display_value=true`;
    const data = await snRequest(url, "GET");
    const i = data.result;

    const details = [
      `Number: ${i.number}`,
      `Short Description: ${i.short_description}`,
      `Description: ${i.description || "—"}`,
      `State: ${i.state}`,
      `Priority: ${i.priority}`,
      `Urgency: ${i.urgency}`,
      `Impact: ${i.impact}`,
      `Category: ${i.category || "—"}`,
      `Subcategory: ${i.subcategory || "—"}`,
      `Caller: ${i.caller_id || "—"}`,
      `Assigned to: ${i.assigned_to || "Unassigned"}`,
      `Assignment group: ${i.assignment_group || "None"}`,
      `Configuration item: ${i.cmdb_ci || "—"}`,
      `Opened: ${i.opened_at}`,
      `Updated: ${i.sys_updated_on}`,
      `Resolved: ${i.resolved_at || "—"}`,
      `Closed: ${i.closed_at || "—"}`,
      `Close code: ${i.close_code || "—"}`,
      `Close notes: ${i.close_notes || "—"}`,
      `SLA due: ${i.sla_due || "—"}`,
      `Sys ID: ${i.sys_id}`,
    ].join("\n");

    return { content: [{ type: "text", text: details }] };
  }
);

// ========== ADD WORK NOTE / COMMENT ==========

server.tool(
  "add-work-note",
  "Add a work note (internal) or customer-visible comment to an incident.",
  {
    identifier: z.string().describe("The incident number (e.g. INC0010001) or sys_id"),
    work_notes: z.string().optional().describe("Internal work notes — visible only to IT staff"),
    comments: z.string().optional().describe("Customer-visible comment — visible to the caller"),
  },
  async (params) => {
    if (!params.work_notes && !params.comments) {
      return { content: [{ type: "text", text: "Please provide either work_notes or comments text." }] };
    }
    const sysId = await resolveIncidentSysId(params.identifier);
    const body: Record<string, unknown> = {};
    if (params.work_notes) body.work_notes = params.work_notes;
    if (params.comments) body.comments = params.comments;

    await snRequest(`${SN_BASE_URL}/${sysId}`, "PATCH", body);

    const parts: string[] = [];
    if (params.work_notes) parts.push("Work note added");
    if (params.comments) parts.push("Customer comment added");

    return {
      content: [{ type: "text", text: `${parts.join(" and ")} to ${params.identifier} successfully.` }],
    };
  }
);

// ========== GET INCIDENT COMMENTS / WORK NOTES ==========

server.tool(
  "get-incident-comments",
  "Retrieve the work notes and comments history for an incident.",
  {
    identifier: z.string().describe("The incident number (e.g. INC0010001) or sys_id"),
    type: z.enum(["work_notes", "comments", "all"]).optional().describe("Filter: 'work_notes', 'comments', or 'all' (default: all)"),
    limit: z.number().optional().describe("Max entries to return (default 20)"),
  },
  async (params) => {
    const sysId = await resolveIncidentSysId(params.identifier);
    const filterType = params.type ?? "all";
    const limit = Math.min(params.limit ?? 20, 100);

    let elementFilter = "";
    if (filterType === "work_notes") {
      elementFilter = "^element=work_notes";
    } else if (filterType === "comments") {
      elementFilter = "^element=comments";
    } else {
      elementFilter = "^elementINwork_notes,comments";
    }

    const url = `${SN_BASE}/api/now/table/sys_journal_field?sysparm_query=element_id=${sysId}${elementFilter}^ORDERBYDESCsys_created_on&sysparm_limit=${limit}&sysparm_fields=element,value,sys_created_on,sys_created_by`;
    const data = await snRequest(url, "GET");

    if (!data.result?.length) {
      return { content: [{ type: "text", text: `No ${filterType === "all" ? "notes or comments" : filterType} found for ${params.identifier}.` }] };
    }

    const entries = data.result.map((e: any) => {
      const label = e.element === "work_notes" ? "[Work Note]" : "[Comment]";
      return `${label} ${e.sys_created_on} by ${e.sys_created_by}\n${e.value}`;
    }).join("\n---\n");

    return { content: [{ type: "text", text: entries }] };
  }
);

// ========== GET MY INCIDENTS (identity-aware) ==========

server.tool(
  "get-my-incidents",
  "Get incidents raised by or assigned to the currently authenticated user.",
  {
    role: z.enum(["caller", "assigned", "both"]).optional().describe("'caller' = raised by me, 'assigned' = assigned to me, 'both' = either (default: both)"),
    state: z.string().optional().describe("Filter by state or 'open' for all active"),
    priority: z.string().optional().describe("Filter by priority (1-5)"),
    limit: z.number().optional().describe("Max incidents to return (default 10)"),
  },
  async (params) => {
    const user = await getCurrentUser();
    const role = params.role ?? "both";
    const limit = params.limit ?? 10;

    let query = "";
    if (role === "caller") {
      query = `caller_id=${user.sys_id}`;
    } else if (role === "assigned") {
      query = `assigned_to=${user.sys_id}`;
    } else {
      query = `caller_id=${user.sys_id}^ORassigned_to=${user.sys_id}`;
    }
    if (params.state?.trim()) {
      if (params.state.toLowerCase() === "open") {
        query += "^stateIN1,2,3";
      } else {
        query += `^state=${params.state.trim()}`;
      }
    }
    if (params.priority?.trim()) query += `^priority=${params.priority.trim()}`;

    const url = `${SN_BASE_URL}?sysparm_limit=${limit}&sysparm_query=${encodeURIComponent(query)}&sysparm_display_value=true&sysparm_fields=sys_id,number,short_description,state,priority,assigned_to,assignment_group,opened_at,sys_updated_on`;
    const data = await snRequest(url, "GET");
    const incidents = data.result.map((i: any) =>
      `#${i.number}: ${i.short_description} | State: ${i.state} | Priority: ${i.priority} | Assigned to: ${i.assigned_to || "Unassigned"} | Group: ${i.assignment_group || "None"} | Opened: ${i.opened_at}`
    ).join("\n");

    return {
      content: [{ type: "text", text: incidents || `No incidents found for ${user.name} (${user.user_name}).` }],
    };
  }
);

// ========== WHO AM I ==========

server.tool(
  "whoami",
  "Returns the currently authenticated ServiceNow user's identity.",
  {},
  async () => {
    const user = await getCurrentUser();
    return {
      content: [{ type: "text", text: `You are logged in as: ${user.name} (${user.user_name})\nEmail: ${user.email}\nSys ID: ${user.sys_id}` }],
    };
  }
);

// ========== EXPRESS SERVER SETUP ==========

const app = express();
app.use(express.json());

const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});

const setupServer = async () => {
  await server.connect(transport);
};

app.get("/auth/config", (_req: Request, res: Response) => {
  res.json({
    authorization_url: `${SN_BASE}/oauth_auth.do`,
    token_url: `${SN_BASE}/oauth_token.do`,
    client_id: SN_CLIENT_ID,
    scopes: "useraccount",
    grant_type: "authorization_code",
    instance: SN_INSTANCE,
  });
});

app.post("/mcp", async (req: Request, res: Response) => {
  console.log("Received MCP request");

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  try {
    await tokenStore.run(token ?? "", async () => {
      await transport.handleRequest(req, res, req.body);
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

app.get("/", (_req: Request, res: Response) => {
  res.send("ServiceNow MCP Server is running. POST /mcp to interact. GET /auth/config for OAuth setup.");
});

const PORT = process.env.PORT || 3000;
setupServer()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`ServiceNow MCP Server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to set up the server:", err);
    process.exit(1);
  });
