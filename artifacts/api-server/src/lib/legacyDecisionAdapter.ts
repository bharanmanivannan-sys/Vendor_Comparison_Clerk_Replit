export type CurrentDecisionStateValue =
  | "WINNER"
  | "CONDITIONAL_WINNER"
  | "NO_ELIGIBLE_WINNER"
  | "CLARIFICATION_REQUIRED"
  | "INSUFFICIENT_EVIDENCE";

export type CurrentDecisionState = {
  state: CurrentDecisionStateValue;
  /** The original field value is retained for audit; the input report is never changed. */
  rawLegacyValue: unknown;
  recognized: boolean;
};

export type MigratedLegacyDecisionState = CurrentDecisionState;

/**
 * Read-only compatibility boundary for historical reports. Consumers should
 * render `state` and retain `rawLegacyValue` only as audit data.
 */
export function migrateLegacyDecisionState(legacyReport: unknown): CurrentDecisionState {
  const report = legacyReport && typeof legacyReport === "object"
    ? legacyReport as Record<string, unknown>
    : {};
  const rawLegacyValue = report.recommendation ?? report.decisionState ?? report.status;
  const normalized = String(rawLegacyValue ?? "").trim().replace(/[.!?]+$/, "").toLowerCase();

  if (normalized === "no definitive winner" || normalized === "no exact winner") {
    return { state: "INSUFFICIENT_EVIDENCE", rawLegacyValue, recognized: true };
  }
  if (normalized === "no qualified option" || normalized === "no eligible winner" || normalized === "no_eligible_winner") {
    return { state: "NO_ELIGIBLE_WINNER", rawLegacyValue, recognized: true };
  }
  if (normalized === "conditional winner" || normalized === "conditional_winner") {
    return { state: "CONDITIONAL_WINNER", rawLegacyValue, recognized: true };
  }
  if (normalized === "winner") {
    return { state: "WINNER", rawLegacyValue, recognized: true };
  }
  if (normalized === "clarification required" || normalized === "clarification_required") {
    return { state: "CLARIFICATION_REQUIRED", rawLegacyValue, recognized: true };
  }
  if (normalized === "insufficient evidence" || normalized === "insufficient_evidence" || normalized === "insufficient_data") {
    return { state: "INSUFFICIENT_EVIDENCE", rawLegacyValue, recognized: true };
  }

  // An unrecognized label cannot establish a winner or a score.
  return { state: "INSUFFICIENT_EVIDENCE", rawLegacyValue, recognized: false };
}

/** Prevent historical wording embedded in generated prose from reaching current output. */
export function removeLegacyDecisionPhrase(value: string): string {
  return value.replace(/\bNo definitive winner\b/gi, "evidence-limited result");
}