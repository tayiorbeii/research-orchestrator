import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResearchError } from "../core/errors.js";
import {
  findImplementations,
  findImplementationsInputShape,
} from "./tools/findImplementations.js";
import { scoreRepos, scoreReposInputShape } from "./tools/scoreRepos.js";
import {
  explainRepoPattern,
  explainRepoPatternInputShape,
} from "./tools/explainRepoPattern.js";
import {
  writePlanArtifact,
  writePlanArtifactInputShape,
} from "./tools/writePlanArtifact.js";

/**
 * MCP server exposing the research.* tools (docs/08_mcp_tool_spec.md).
 * Tools call the same core services as the CLI, support mock mode, and
 * return structured errors instead of throwing opaque failures. Large
 * artifacts are written to files, never dumped into responses.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "research-orchestrator", version: "0.1.0" });

  register(
    server,
    "research.findImplementations",
    "Find, score, and optionally prove repositories that implement a requested feature. Defaults to mock mode; pass mode:'octocode'|'github' when those providers are configured.",
    findImplementationsInputShape,
    findImplementations,
  );
  register(
    server,
    "research.scoreRepos",
    "Score existing candidate repositories against a feature spec, with optional exact evidence anchors.",
    scoreReposInputShape,
    scoreRepos,
  );
  register(
    server,
    "research.explainRepoPattern",
    "Answer implementation questions for one or more selected repositories, with evidence anchors. DeepWiki enrichment is used only when configured and never as sole proof.",
    explainRepoPatternInputShape,
    explainRepoPattern,
  );
  register(
    server,
    "research.writePlanArtifact",
    "Write research.md, plan.md, evidence.json, and implementation-checklist.md from a research run (inline or cached runId). Artifacts are secret-redacted.",
    writePlanArtifactInputShape,
    writePlanArtifact,
  );

  return server;
}

function register<Shape extends Record<string, import("zod").ZodTypeAny>>(
  server: McpServer,
  name: string,
  description: string,
  inputShape: Shape,
  handler: (input: never) => Promise<unknown>,
): void {
  server.registerTool(name, { description, inputSchema: inputShape }, (async (args: unknown) => {
    try {
      const result = await handler(args as never);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const payload =
        error instanceof ResearchError
          ? error.toJSON()
          : {
              code: "incomplete_results",
              message: (error as Error).message,
              recoverable: false,
            };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: payload }, null, 2) }],
      };
    }
  }) as never);
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error("research-orchestrator MCP server listening on stdio");
}
