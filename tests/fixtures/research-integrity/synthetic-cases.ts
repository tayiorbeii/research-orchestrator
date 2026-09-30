/** Synthetic regression inputs; none are recovered provider output. */
export const syntheticCases = {
  ignoreAndChangelog: {
    synthetic: true,
    goal: "Research whether a Python project enforces Ruff lint during CI.",
    files: {
      ".gitignore": "ruff_cache/",
      "CHANGELOG.md": "Mentioned Ruff in the developer tooling notes.",
    },
    expectedClaim: "Ignore-file and changelog keyword matches do not prove CI enforcement.",
  },
  questionOnlyKeyword: {
    synthetic: true,
    question: "Does this project implement strict coverage verification?",
    answer: "The answer contains no information about the asked behavior.",
    anchorSignal: "strict coverage verification",
    expectedClaim: "Keywords present only in the question cannot verify an unrelated answer.",
  },
  fallbackAnswers: {
    synthetic: true,
    question: "Is this unrelated behavior implemented?",
    answer: "No exact evidence answers this question.",
    anchorText: "Strict coverage verification is configured.",
    anchorSignal: "strict coverage verification",
    questions: [
      "Is this unrelated behavior implemented?",
      "Does this unrelated repository publish packages?",
    ],
    expectedClaim: "An unrelated proved anchor cannot mark every fallback answer verified.",
  },
  supportedAndInvented: {
    synthetic: true,
    question: "Is strict coverage verification configured?",
    answer:
      "Strict coverage verification is configured. It also blocks every unreviewed change, although the source does not say that.",
    anchorSignal: "strict coverage verification",
    expectedClaim: "A supported sentence cannot verify an additional invented sentence.",
  },
  importedProofFlags: {
    synthetic: true,
    question: "Is strict coverage verification configured?",
    answer: "Strict coverage verification is configured.",
    anchorSignal: "strict coverage verification",
    importedAnchor: {
      id: "synthetic_imported_anchor",
      provider: "mock",
      repo: "synthetic/example",
      path: "synthetic.json",
      role: "behavior_proof",
      proofLevel: "proved",
      verified: true,
      matchedSignal: "strict coverage verification",
    },
    expectedClaim: "Caller-supplied proof and verification flags cannot establish support.",
  },
} as const;
