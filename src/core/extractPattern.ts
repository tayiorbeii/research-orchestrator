import type {
  EvidenceAnchor,
  FeatureSpec,
  ImplementationMap,
  ScoredCandidate,
} from "../schemas/index.js";
import { getFeatureProfileForSpec } from "./knowledge.js";

export interface ExtractedPattern {
  implementationMap: ImplementationMap;
  implementationSteps: string[];
  risks: string[];
  openQuestions: string[];
}

/**
 * Synthesize a cross-repo implementation pattern from the feature spec,
 * accepted candidates, and their exact evidence anchors.
 */
export function extractPattern(
  spec: FeatureSpec,
  scored: ScoredCandidate[],
  evidence: EvidenceAnchor[],
): ExtractedPattern {
  const isResearchSpec = spec.goalKind === "research";
  const profile = isResearchSpec ? undefined : getFeatureProfileForSpec(spec);
  const accepted = scored.filter(
    (s) => s.nextAction === "extract" || (s.score >= 0.7 && s.nextAction !== "reject"),
  );
  const acceptedRepos = new Set(accepted.map((s) => s.repo));
  const acceptedAnchors = evidence.filter((a) => a.repo && acceptedRepos.has(a.repo));

  // Files: concrete likely files, enriched with anchors proving them in the wild.
  const files: ImplementationMap["files"] = isResearchSpec
    ? []
    : spec.likelyFiles
        .filter((f) => !f.includes("*"))
        .map((path) => ({
          path,
          role: inferRole(path, spec),
          evidence: acceptedAnchors.filter((a) => normalize(a.path) === normalize(path)),
        }));
  // Research anchors prove facts about external systems; they are not files to
  // create or modify in the user's implementation map.
  if (!isResearchSpec) {
    for (const anchor of acceptedAnchors) {
      if (anchor.proofLevel !== "proved") continue;
      if (files.some((f) => normalize(f.path) === normalize(anchor.path))) continue;
      files.push({ path: anchor.path, role: anchor.role, evidence: [anchor] });
    }
  }

  const dependencies = isResearchSpec
    ? []
    : [
        ...new Set([
          ...spec.stack.map(stackPackage).filter((p): p is string => Boolean(p)),
          ...spec.libraries,
          ...spec.providers.map((p) => p.toLowerCase()),
        ]),
      ];

  const pattern = profile?.pattern;
  const implementationMap: ImplementationMap = {
    dependencies,
    files,
    serverFlow: isResearchSpec
      ? []
      : (pattern?.serverFlow ?? (accepted.length > 0 ? genericServerFlow(spec) : [])),
    clientFlow: isResearchSpec
      ? []
      : (pattern?.clientFlow ?? (accepted.length > 0 ? genericClientFlow(spec) : [])),
    environmentVariables: pattern?.environmentVariables ?? [],
    routeProtection: pattern?.routeProtection,
    tests: pattern?.tests,
    pitfalls: pattern?.pitfalls ?? [
      "Verify current library versions before copying any pattern.",
      "Confirm evidence anchors against the live repositories before implementation.",
    ],
  };

  const implementationSteps = buildSteps(spec, implementationMap, isResearchSpec);

  const risks = [
    ...(pattern?.pitfalls.slice(0, 3) ?? []),
    ...(accepted.length === 0
      ? ["No candidate reached extraction confidence; the plan is pattern-informed but unproved."]
      : []),
  ];

  const openQuestions = [
    ...new Set(
      scored
        .filter((s) => acceptedRepos.has(s.repo) || s.nextAction === "read_more")
        .flatMap((s) => s.missingProof.map((m) => `${s.repo}: ${m}`)),
    ),
  ];

  return { implementationMap, implementationSteps, risks, openQuestions };
}

function buildSteps(
  spec: FeatureSpec,
  map: ImplementationMap,
  isResearchSpec: boolean,
): string[] {
  const steps: string[] = [];
  if (map.dependencies.length > 0) {
    steps.push(`Install dependencies: ${map.dependencies.join(", ")}.`);
  }
  if (map.environmentVariables.length > 0) {
    steps.push(
      `Configure environment variables (names only, values stay in your secret store): ${map.environmentVariables.join(", ")}.`,
    );
  }
  for (const flow of map.serverFlow) steps.push(`Server: ${flow}.`.replace(/\.\.$/, "."));
  for (const flow of map.clientFlow) steps.push(`Client: ${flow}.`.replace(/\.\.$/, "."));
  for (const rp of map.routeProtection ?? []) steps.push(`Routing: ${rp}.`.replace(/\.\.$/, "."));
  for (const t of map.tests ?? []) steps.push(`Test: ${t}.`.replace(/\.\.$/, "."));
  if (steps.length === 0) {
    steps.push(
      isResearchSpec
        ? `Translate the proved ${spec.feature} research anchors into migration requirements and explicit gaps.`
        : `Implement ${spec.feature} following the evidence anchors in evidence.json.`,
    );
  }
  return steps;
}

function inferRole(path: string, spec: FeatureSpec): string {
  if (/package\.json$/.test(path)) return "dependency manifest";
  if (/middleware|proxy/i.test(path)) return "route protection";
  if (/auth\.config/i.test(path)) return "auth provider config";
  if (/convex\/http/i.test(path)) return "http route wiring";
  if (/auth/i.test(path)) return "server auth configuration";
  if (/login|signin|sign-in/i.test(path)) return "client sign-in flow";
  if (/provider/i.test(path)) return "client provider wiring";
  return `${spec.feature} implementation file`;
}

function stackPackage(stack: string): string | undefined {
  const map: Record<string, string> = {
    "Next.js": "next",
    Convex: "convex",
    Supabase: "@supabase/supabase-js",
    Hono: "hono",
    Remix: "@remix-run/node",
    SvelteKit: "@sveltejs/kit",
    Nuxt: "nuxt",
    Express: "express",
  };
  return map[stack];
}

function genericServerFlow(spec: FeatureSpec): string[] {
  return [
    `Wire the server side of ${spec.feature} using the proved files from accepted repos`,
  ];
}

function genericClientFlow(spec: FeatureSpec): string[] {
  return [`Wire the client side of ${spec.feature} following accepted repo evidence`];
}

function normalize(path: string): string {
  return path.replace(/^\.\//, "").toLowerCase();
}
