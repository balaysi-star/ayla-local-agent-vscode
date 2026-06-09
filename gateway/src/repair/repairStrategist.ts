import { analyzeValidationFailure } from "./validationFailureAnalyzer";

export function buildRepairStrategy(validationFailure: string): {
  category: string;
  likelyCause: string;
  suggestedRepair: string;
} {
  const analysis = analyzeValidationFailure(validationFailure);
  return {
    category: analysis.category,
    likelyCause: analysis.likelyCause,
    suggestedRepair: "Perform the smallest surgical repair for the failing case, then rerun the focused validation first."
  };
}
