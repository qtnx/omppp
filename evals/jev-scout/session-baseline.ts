import { scoutSource } from "../../packages/coding-agent/src/jev/scout";
const root = new URL("../../", import.meta.url).pathname;
const cases = [
 ["entry", "How does compact tool schedule context compaction, execute it after the turn, summarize and replace history? Locate entry tool and core implementation.", "packages/coding-agent/src"],
 ["directory", "Find requestCompaction implementation and where pending tool compaction runs after agent turn ends; include summary strategy selection and session history replacement", "packages/coding-agent/src/session"],
 ["agent", "Locate requestCompaction method, pending scheduled compaction drain and compact execution methods; return exact source ranges explaining method selection and history update", "packages/coding-agent/src/session/agent-session.ts"],
 ["maintenance", "Explain compact() actual implementation: choose method, prepare summary and retained messages, append compaction record and replace agent messages. Return decisive implementation excerpts.", "packages/coding-agent/src/session/session-maintenance.ts"],
];
for (const [id, query, relative] of cases) {
 const result = await scoutSource({query: query!, path: root + relative!, maxFiles: relative!.endsWith('.ts') ? 1 : 3, signal: AbortSignal.timeout(60000)});
 console.log(JSON.stringify({id,status:result.status,requests:result.requests,inputTokens:result.inputTokens,excerpts:result.excerpts.map(e=>({path:e.path,startLine:e.startLine,endLine:e.endLine})),warnings:result.warnings}));
}
