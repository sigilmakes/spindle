export const EPISODE_PROMPT = `
## Subagent result contract

When you are done (or blocked), emit a single <episode> block as the LAST thing
in your response. Put all important information inside it.

<episode>
status: success | failure | blocked
summary: |
  What you did, what you found, and the conclusion.
findings:
- Specific actionable finding with details
artifacts:
- path/to/file — what changed and why
blockers:
- Specific blocker, only if blocked
</episode>

Do not emit prose after the closing </episode> tag.
`.trim();

export interface Episode {
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
}

function parseSummary(block: string): string {
    const summaryMatch = block.match(/summary:\s*(.+?)(?=\nfindings:|\nartifacts:|\nblockers:|\n*$)/is);
    if (!summaryMatch) return "";
    let raw = summaryMatch[1].trim();
    if (raw.startsWith("|")) raw = raw.slice(1).trim();
    return raw.replace(/\n\s*/g, " ").trim();
}

function parseList(block: string, field: string): string[] {
    const match = block.match(new RegExp(`${field}:\\s*\\n((?:\\s*-\\s*.+\\n?)*)`, "i"));
    if (!match) return [];
    return match[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
}

export function parseEpisodeBlock(text: string): Episode | null {
    const matches = [...text.matchAll(/<episode>([\s\S]*?)<\/episode>/g)];
    if (matches.length === 0) return null;

    const block = matches[matches.length - 1][1];
    const statusMatch = block.match(/status:\s*(success|failure|blocked)/i);

    return {
        status: (statusMatch?.[1]?.toLowerCase() as Episode["status"]) || "success",
        summary: parseSummary(block),
        findings: parseList(block, "findings"),
        artifacts: parseList(block, "artifacts"),
        blockers: parseList(block, "blockers"),
    };
}
