
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import pg from "pg";
import express from "express";
import cors from "cors";

// Environment Variables
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL;
const MCP_API_KEY = process.env.MCP_API_KEY;

if (!DATABASE_URL) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
}

if (!MCP_API_KEY) {
    console.warn("WARNING: MCP_API_KEY is not set. Security is disabled!");
}

// Database Connection
const pool = new pg.Pool({
    connectionString: DATABASE_URL,
});

// MCP Server Setup
const server = new McpServer({
    name: "SupaCloud Postgres MCP",
    version: "1.0.0",
});

// Tool: Query SQL (Read-only recommended, but here simplistic)
server.tool(
    "query_sql",
    "Execute a read-only SQL query against the database",
    {
        query: z.string().describe("The SQL query to execute"),
    },
    async ({ query }) => {
        // Basic safety check for read-only
        if (!query.trim().toLowerCase().startsWith("select") && !query.trim().toLowerCase().startsWith("with")) {
            return {
                content: [{ type: "text", text: "Error: Only SELECT queries are allowed for safety." }]
            };
        }

        try {
            const result = await pool.query(query);
            return {
                content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
            };
        } catch (e: any) {
            return {
                content: [{ type: "text", text: `Database Error: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Tool: List Tables
server.tool(
    "list_tables",
    "List all tables in the public schema",
    {},
    async () => {
        try {
            const query = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name;
      `;
            const result = await pool.query(query);
            return {
                content: [{ type: "text", text: JSON.stringify(result.rows.map((r: any) => r.table_name), null, 2) }],
            };
        } catch (e: any) {
            return {
                content: [{ type: "text", text: `Error: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Tool: Get Schema
server.tool(
    "get_table_schema",
    "Get the schema definition of a specific table",
    {
        tableName: z.string().describe("The name of the table"),
    },
    async ({ tableName }) => {
        try {
            const query = `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
      `;
            const result = await pool.query(query, [tableName]);
            if (result.rows.length === 0) {
                return {
                    content: [{ type: "text", text: `Table '${tableName}' not found or empty.` }]
                };
            }
            return {
                content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
            };
        } catch (e: any) {
            return {
                content: [{ type: "text", text: `Error: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// Express Server with SSE
const app = express();
app.use(cors());

// Auth Middleware
const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Allow health check without auth
    if (req.path === "/health") return next();

    if (!MCP_API_KEY) return next();

    const apiKey = req.headers["x-api-key"] || req.query.apiKey;
    if (apiKey === MCP_API_KEY) {
        next();
    } else {
        res.status(401).json({ error: "Unauthorized: Invalid API Key" });
    }
};

app.use(authMiddleware);

app.get("/health", (req, res) => {
    res.send("OK");
});

// SSE Endpoint
let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(404).json({ error: "No active transport" });
    }
});

const port = PORT;
app.listen(port, () => {
    console.log(`MCP Server running on port ${port}`);
    console.log(`Auth Enabled: ${!!MCP_API_KEY}`);
});
