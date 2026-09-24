export type ResearchErrorCode =
  | "provider_not_configured"
  | "rate_limited"
  | "no_results"
  | "incomplete_results"
  | "deepwiki_unavailable"
  | "invalid_feature_spec"
  | "artifact_write_failed";

/** Structured error model from docs/08_mcp_tool_spec.md. */
export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  readonly recoverable: boolean;
  readonly suggestedAction?: string;

  constructor(
    code: ResearchErrorCode,
    message: string,
    options: { recoverable?: boolean; suggestedAction?: string } = {},
  ) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
    this.recoverable = options.recoverable ?? true;
    this.suggestedAction = options.suggestedAction;
  }

  toJSON(): {
    code: ResearchErrorCode;
    message: string;
    recoverable: boolean;
    suggestedAction?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.suggestedAction ? { suggestedAction: this.suggestedAction } : {}),
    };
  }
}

export function providerNotConfigured(provider: string, hint: string): ResearchError {
  return new ResearchError(
    "provider_not_configured",
    `${provider} is not configured in this environment.`,
    { recoverable: true, suggestedAction: hint },
  );
}
