export type LicenseClassification = "permissive" | "copyleft" | "unknown" | "proprietary/unsafe";

export function classifyLicense(licenseText: string): LicenseClassification {
  const normalized = licenseText.toLowerCase();
  if (normalized.includes("mit") || normalized.includes("apache") || normalized.includes("bsd")) {
    return "permissive";
  }
  if (normalized.includes("gpl") || normalized.includes("agpl") || normalized.includes("lgpl")) {
    return "copyleft";
  }
  if (normalized.includes("all rights reserved") || normalized.includes("proprietary")) {
    return "proprietary/unsafe";
  }
  return "unknown";
}
