import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OctocodeEvidenceProvider,
  type OctocodeToolCaller,
} from "./OctocodeEvidenceProvider.js";
import { DeepWikiExplainer, type DeepWikiExplainerConfig } from "./DeepWikiExplainer.js";
import { ResearchError, providerNotConfigured } from "../core/errors.js";

/**
 * End-to-end wiring for injected provider bridges (docs/04, docs/05).
 *
 * The orchestrator never embeds MCP clients. A host can configure the live
 * Octocode/DeepWiki bridges three ways, in precedence order:
 *
 * 1. Explicitly, per call: `new OctocodeEvidenceProvider({ callTool })`.
 * 2. Programmatically, per process: `setOctocodeToolCaller(callTool)` /
 *    `setDeepWikiAskQuestion(ask)` before running the CLI/MCP entry points.
 * 3. Via environment: `RESEARCH_OCTOCODE_BRIDGE` / `RESEARCH_DEEPWIKI_BRIDGE`
 *    point at an ES module that exports the bridge function (default export,
 *    a named export, or a `create*` factory — see the loaders below).
 */

export const OCTOCODE_BRIDGE_ENV = "RESEARCH_OCTOCODE_BRIDGE";
export const DEEPWIKI_BRIDGE_ENV = "RESEARCH_DEEPWIKI_BRIDGE";

export const OCTOCODE_WIRING_HINT =
  "Wire a live Octocode bridge: pass callTool to new OctocodeEvidenceProvider({ callTool }), " +
  "call setOctocodeToolCaller(callTool) from host code, or set " +
  `${OCTOCODE_BRIDGE_ENV}=<path to a module exporting an OctocodeToolCaller> ` +
  "(default export, `callTool`, or a `createOctocodeToolCaller` factory). " +
  "Otherwise run with --mock. See docs/04_octocode_integration.md.";

export const DEEPWIKI_WIRING_HINT =
  "Wire a DeepWiki bridge: pass askQuestion to new DeepWikiExplainer({ askQuestion }), " +
  "call setDeepWikiAskQuestion(ask) from host code, or set " +
  `${DEEPWIKI_BRIDGE_ENV}=<path to a module exporting an askQuestion(repo, question) function> ` +
  "(default export, `askQuestion`, or a `createAskQuestion` factory). " +
  "DeepWiki is enrichment only; the Octocode-style fallback is always available.";

export type DeepWikiAskQuestion = NonNullable<DeepWikiExplainerConfig["askQuestion"]>;

let registeredOctocodeCaller: OctocodeToolCaller | undefined;
let registeredDeepWikiAsk: DeepWikiAskQuestion | undefined;

/** Programmatic entry point: register a process-wide Octocode bridge. */
export function setOctocodeToolCaller(caller: OctocodeToolCaller | undefined): void {
  registeredOctocodeCaller = caller;
}

export function getOctocodeToolCaller(): OctocodeToolCaller | undefined {
  return registeredOctocodeCaller;
}

/** Programmatic entry point: register a process-wide DeepWiki bridge. */
export function setDeepWikiAskQuestion(ask: DeepWikiAskQuestion | undefined): void {
  registeredDeepWikiAsk = ask;
}

export function getDeepWikiAskQuestion(): DeepWikiAskQuestion | undefined {
  return registeredDeepWikiAsk;
}

async function loadBridgeModule(spec: string, envName: string): Promise<Record<string, unknown>> {
  const url = /^(file|node|data|https?):/.test(spec)
    ? spec
    : pathToFileURL(isAbsolute(spec) ? spec : resolve(spec)).href;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch (error) {
    throw new ResearchError(
      "provider_not_configured",
      `Failed to load bridge module from ${envName}=${spec}: ${(error as Error).message}`,
      { recoverable: true, suggestedAction: `Fix or unset ${envName}.` },
    );
  }
}

async function bridgeFunctionFromModule(
  mod: Record<string, unknown>,
  factoryName: string,
  namedExport: string,
  envName: string,
): Promise<(...args: never[]) => Promise<unknown>> {
  const factory = mod[factoryName];
  if (typeof factory === "function") {
    const created: unknown = await (factory as () => unknown)();
    if (typeof created === "function") return created as (...args: never[]) => Promise<unknown>;
    throw new ResearchError(
      "provider_not_configured",
      `${envName} module's ${factoryName}() did not return a function.`,
      { recoverable: true, suggestedAction: `Return the bridge function from ${factoryName}().` },
    );
  }
  const direct = [mod.default, mod[namedExport]].find((v) => typeof v === "function");
  if (direct) return direct as (...args: never[]) => Promise<unknown>;
  throw new ResearchError(
    "provider_not_configured",
    `${envName} module does not export a bridge function.`,
    {
      recoverable: true,
      suggestedAction: `Export the bridge as the default export, as \`${namedExport}\`, or via a \`${factoryName}\` factory.`,
    },
  );
}

/** Load an OctocodeToolCaller from RESEARCH_OCTOCODE_BRIDGE, if set. */
export async function loadOctocodeToolCallerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OctocodeToolCaller | undefined> {
  const spec = env[OCTOCODE_BRIDGE_ENV];
  if (!spec || spec.trim() === "") return undefined;
  const mod = await loadBridgeModule(spec.trim(), OCTOCODE_BRIDGE_ENV);
  return (await bridgeFunctionFromModule(
    mod,
    "createOctocodeToolCaller",
    "callTool",
    OCTOCODE_BRIDGE_ENV,
  )) as OctocodeToolCaller;
}

/** Load a DeepWiki askQuestion bridge from RESEARCH_DEEPWIKI_BRIDGE, if set. */
export async function loadDeepWikiAskQuestionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeepWikiAskQuestion | undefined> {
  const spec = env[DEEPWIKI_BRIDGE_ENV];
  if (!spec || spec.trim() === "") return undefined;
  const mod = await loadBridgeModule(spec.trim(), DEEPWIKI_BRIDGE_ENV);
  return (await bridgeFunctionFromModule(
    mod,
    "createAskQuestion",
    "askQuestion",
    DEEPWIKI_BRIDGE_ENV,
  )) as DeepWikiAskQuestion;
}

export interface ResolveOctocodeProviderOptions {
  /** Explicit bridge; wins over the registry and the environment. */
  callTool?: OctocodeToolCaller;
  env?: NodeJS.ProcessEnv;
  maxResultsPerProbe?: number;
  /** Throw a structured provider_not_configured error when no bridge is found. */
  requireConfigured?: boolean;
}

/**
 * Resolve an OctocodeEvidenceProvider from explicit config, the programmatic
 * registry, or the environment bridge — in that order. When nothing is wired
 * and `requireConfigured` is not set, the returned provider throws structured
 * provider_not_configured errors on first use (the interface is the contract).
 */
export async function resolveOctocodeProvider(
  options: ResolveOctocodeProviderOptions = {},
): Promise<OctocodeEvidenceProvider> {
  let callTool: OctocodeToolCaller | undefined;
  try {
    callTool =
      options.callTool ??
      registeredOctocodeCaller ??
      (await loadOctocodeToolCallerFromEnv(options.env));
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw providerNotConfigured(
      "Octocode",
      `${OCTOCODE_WIRING_HINT} Bridge setup failed: ${(error as Error).message}`,
    );
  }
  const provider = new OctocodeEvidenceProvider({
    callTool,
    maxResultsPerProbe: options.maxResultsPerProbe,
  });
  if (options.requireConfigured && !provider.configured) {
    throw providerNotConfigured("Octocode", OCTOCODE_WIRING_HINT);
  }
  return provider;
}

export interface ResolveDeepWikiExplainerOptions {
  askQuestion?: DeepWikiAskQuestion;
  env?: NodeJS.ProcessEnv;
  config?: Omit<DeepWikiExplainerConfig, "askQuestion">;
}

/**
 * Resolve a DeepWikiExplainer from explicit config, the programmatic
 * registry, or the environment bridge. An unconfigured explainer is still
 * returned (it reports available:false) so callers can fall back cleanly.
 */
export async function resolveDeepWikiExplainer(
  options: ResolveDeepWikiExplainerOptions = {},
): Promise<DeepWikiExplainer> {
  const askQuestion =
    options.askQuestion ??
    registeredDeepWikiAsk ??
    (await loadDeepWikiAskQuestionFromEnv(options.env));
  return new DeepWikiExplainer({ ...options.config, askQuestion });
}
