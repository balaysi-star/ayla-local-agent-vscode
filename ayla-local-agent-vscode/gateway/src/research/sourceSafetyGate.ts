import { classifyLicense } from "./licenseClassifier";

export function evaluateSourceSafety(licenseText: string): {
  classification: ReturnType<typeof classifyLicense>;
  copyCodeAllowed: boolean;
  reason: string;
} {
  const classification = classifyLicense(licenseText);
  if (classification === "permissive") {
    return { classification, copyCodeAllowed: true, reason: "Permissive license detected." };
  }
  if (classification === "unknown") {
    return { classification, copyCodeAllowed: false, reason: "License unknown; conceptual patterns only." };
  }
  return { classification, copyCodeAllowed: false, reason: "Copying code is blocked for this source classification." };
}
