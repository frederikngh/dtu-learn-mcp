/**
 * A small, dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * It implements the parts of the protocol a tools-only server needs:
 * initialize, ping, tools/list and tools/call.
 */
import readline from "node:readline";
import { VERSION, log } from "./config.js";
import { AuthRequiredError } from "./client.js";
import { tools, findTool } from "./tools.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Read-only access to the user's DTU Learn (Brightspace) courses at the Technical University of Denmark.",
  "Typical flow: list_courses → get_course_outline (optionally with search) → read_file / get_topic; get_upcoming for deadlines; get_assignment for hand-in details.",
  "Courses can be referred to by DTU course number (e.g. 02450) or name.",
  "If a tool says the user is not signed in, call login (it opens a browser window on the user's computer) and tell the user to complete the sign-in there.",
].join(" ");

type Id = string | number;
interface Request {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: Id, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: Id | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(req: Request): Promise<void> {
  const { id, method, params = {} } = req;
  const isNotification = id === undefined;

  switch (method) {
    case "initialize": {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return reply(id!, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dtu-learn", title: "DTU Learn (unofficial)", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return isNotification ? undefined : reply(id!, {});
    case "tools/list":
      return reply(id!, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const name = String(params.name ?? "");
      const tool = findTool(name);
      if (!tool) return fail(id!, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await tool.run(args);
        return reply(id!, { content: [{ type: "text", text }] });
      } catch (err) {
        const message =
          err instanceof AuthRequiredError
            ? `${err.message}`
            : `Error: ${(err as Error).message ?? String(err)}`;
        if (!(err instanceof AuthRequiredError)) log(`tool ${name} failed:`, err);
        return reply(id!, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    // Capabilities we don't offer, answered politely for clients that ask anyway.
    case "resources/list":
      return reply(id!, { resources: [] });
    case "resources/templates/list":
      return reply(id!, { resourceTemplates: [] });
    case "prompts/list":
      return reply(id!, { prompts: [] });
    default:
      if (isNotification) return; // e.g. notifications/initialized, notifications/cancelled
      return fail(id!, -32601, `Method not found: ${method}`);
  }
}

export function startMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: Request;
    try {
      req = JSON.parse(trimmed) as Request;
    } catch {
      return fail(null, -32700, "Parse error");
    }
    if (Array.isArray(req)) {
      return fail(null, -32600, "Batch requests are not supported");
    }
    if (typeof req.method !== "string") return; // a response to us; we never send requests
    handle(req).catch((err) => {
      log("internal error:", err);
      if (req.id !== undefined) fail(req.id, -32603, (err as Error).message);
    });
  });
  rl.on("close", () => process.exit(0));
  log(`DTU Learn MCP server ${VERSION} ready (stdio).`);
}
