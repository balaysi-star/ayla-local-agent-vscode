import { StructuredResult } from "./types";

export function formatStructuredResult(result: StructuredResult): string {
  const sections: string[] = [`## ${result.title}`];

  sections.push("### Facts");
  sections.push(...result.facts.map((line) => `- ${line}`));

  if (result.inference?.length) {
    sections.push("### Inference");
    sections.push(...result.inference.map((line) => `- ${line}`));
  }

  if (result.unknown?.length) {
    sections.push("### Unknown");
    sections.push(...result.unknown.map((line) => `- ${line}`));
  }

  if (result.nextAction) {
    sections.push("### Next Action");
    sections.push(result.nextAction);
  }

  return sections.join("\n");
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}
