export interface ValidationFailureAnalysis {
  category: "typescript" | "node_test" | "format" | "unknown";
  likelyCause: string;
}

export function analyzeValidationFailure(message: string): ValidationFailureAnalysis {
  const normalized = message.toLowerCase();
  if (normalized.includes("typescript") || normalized.includes("tsc")) {
    return { category: "typescript", likelyCause: "TypeScript validation failed on the generated artifact." };
  }
  if (normalized.includes("node") || normalized.includes("test")) {
    return { category: "node_test", likelyCause: "Focused node validation failed." };
  }
  if (normalized.includes("format") || normalized.includes("json")) {
    return { category: "format", likelyCause: "Model output format was malformed or incomplete." };
  }
  return { category: "unknown", likelyCause: "Validation failed with an unclassified local error." };
}
