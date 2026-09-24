// Library entrypoint for research-orchestrator.
export * from "./schemas/index.js";
export { normalizeFeatureSpec } from "./core/normalizeFeatureSpec.js";
export { generateSearchProbes } from "./core/generateSearchProbes.js";
export { collectEvidence } from "./core/collectEvidence.js";
export { scoreCandidate } from "./core/scoreCandidate.js";
export { extractPattern, type ExtractedPattern } from "./core/extractPattern.js";
export { writeArtifacts, type WriteArtifactsOptions } from "./core/writeArtifacts.js";
export { runResearch, type RunResearchOptions, type RunResearchResult } from "./core/pipeline.js";
export { redactSecrets, redactObject } from "./core/redact.js";
export { ResearchError, providerNotConfigured, type ResearchErrorCode } from "./core/errors.js";
export * from "./adapters/EvidenceProvider.js";
export { MockEvidenceProvider, MOCK_FILE_CONTENTS } from "./adapters/MockEvidenceProvider.js";
export {
  OctocodeEvidenceProvider,
  normalizeSearchResponse,
  splitQueryTerms,
  type OctocodeEvidenceProviderConfig,
  type OctocodeSearchResponse,
  type OctocodeToolCaller,
} from "./adapters/OctocodeEvidenceProvider.js";
export {
  GitHubEvidenceProvider,
  type GitHubEvidenceProviderConfig,
} from "./adapters/GitHubEvidenceProvider.js";
export {
  DeepWikiExplainer,
  applyFreshnessPolicy,
  DEFAULT_FRESHNESS_MAX_AGE_DAYS,
  type DeepWikiExplainerConfig,
  type DeepWikiFreshness,
} from "./adapters/DeepWikiExplainer.js";
export {
  HybridRepoExplainer,
  verifyAnswerAgainstAnchors,
  type HybridRepoExplainerConfig,
} from "./adapters/HybridRepoExplainer.js";
export {
  setOctocodeToolCaller,
  getOctocodeToolCaller,
  setDeepWikiAskQuestion,
  getDeepWikiAskQuestion,
  loadOctocodeToolCallerFromEnv,
  loadDeepWikiAskQuestionFromEnv,
  resolveOctocodeProvider,
  resolveDeepWikiExplainer,
  OCTOCODE_BRIDGE_ENV,
  DEEPWIKI_BRIDGE_ENV,
  type DeepWikiAskQuestion,
  type ResolveOctocodeProviderOptions,
  type ResolveDeepWikiExplainerOptions,
} from "./adapters/bridge.js";
export { FileResearchCache } from "./cache/FileResearchCache.js";
export { createServer } from "./mcp/server.js";
export { findImplementations } from "./mcp/tools/findImplementations.js";
export { scoreRepos } from "./mcp/tools/scoreRepos.js";
export { explainRepoPattern } from "./mcp/tools/explainRepoPattern.js";
export { writePlanArtifact } from "./mcp/tools/writePlanArtifact.js";
export { runEval, completenessScore } from "./eval/runEval.js";
export { BENCHMARK_TASKS } from "./eval/benchmarkTasks.js";
