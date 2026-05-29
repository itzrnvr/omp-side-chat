/**
 * Side Chat — Multi-turn ephemeral conversation with live streaming.
 *
 * /side <question>  — Ask a question (answer streams in widget)
 * /side close       — Close and save session
 * /side clear       — Discard session
 * /side             — Resume or show status
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface SideExchange { question: string; answer: string }
interface SideSession { exchanges: SideExchange[]; createdAt: number }

const DIR = path.join(os.homedir(), ".omp", "side-sessions");
const save = (s: SideSession) => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, "latest.json"), JSON.stringify(s), "utf-8"); } catch {} };
const load = (): SideSession | undefined => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "latest.json"), "utf-8")); } catch {} };
const nuke = () => { try { fs.unlinkSync(path.join(DIR, "latest.json")); } catch {} };

function prompt(q: string, hist: SideExchange[]): string {
	const h = hist.length ? "\nPrevious exchanges:\n" + hist.map((e, i) => `Q${i+1}: ${e.question}\nA${i+1}: ${e.answer}`).join("\n\n") + "\n" : "";
	return `<side>\nEphemeral side conversation. Answer briefly from context. NO tools. NO follow-up questions.\n${h}Question: ${q}\n</side>`;
}

function widget(
	s: SideSession, pending: boolean, pq: string, pa: string,
	t: ExtensionUIContext["theme"],
): string[] {
	const lines: string[] = [];
	const n = s.exchanges.length;
	const icon = pending ? "↔" : "💬";
	lines.push(t.fg("accent", t.bold(`${icon} Side Chat${n ? ` (${n})` : ""} ─ /side <q> · /side close`)));
	lines.push(t.fg("dim", "─".repeat(60)));

	const MAX = 5;
	const start = Math.max(0, n - MAX);
	if (start > 0) lines.push(t.fg("dim", `  ... (${start} earlier)`));
	for (let i = start; i < n; i++) {
		const e = s.exchanges[i];
		lines.push(t.fg("accent", `  ▸ ${e.question}`));
		for (const l of e.answer.split("\n").slice(0, 30)) lines.push(`    ${l}`);
		if (i < n - 1) lines.push("");
	}
	if (pending) {
		if (n) lines.push("");
		lines.push(t.fg("accent", `  ▸ ${pq}`));
		if (pa) for (const l of pa.split("\n")) lines.push(`    ${l}`);
		else lines.push(t.fg("dim", "    ⋯"));
	}
	return lines;
}

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let pending = false;
	let pq = "";
	let pa = "";

	function render(ui: ExtensionUIContext) {
		if (!session) { ui.setWidget("side", undefined); ui.setStatus("side", undefined); return; }
		ui.setWidget("side", widget(session, pending, pq, pa, ui.theme), { placement: "belowEditor" });
		ui.setStatus("side", pending ? "↔ Side chat" : "💬 Side chat");
	}

	pi.on("message_update", (event, ctx: ExtensionContext) => {
		if (!pending || !session) return;
		if (event.assistantMessageEvent?.type === "text_delta") {
			pa += event.assistantMessageEvent.delta ?? "";
			render(ctx.ui);
		}
	});

	pi.on("message_end", (event, ctx: ExtensionContext) => {
		if (!pending || !session) return;
		const msg = event.message as { role: string; content: unknown };
		if (msg.role !== "assistant") return;
		session.exchanges.push({ question: pq, answer: pa.trim() || "(no answer)" });
		pending = false; pq = ""; pa = "";
		save(session);
		render(ctx.ui);
	});

	pi.registerCommand("side", {
		description: "Multi-turn side conversation with live streaming",
		getArgumentCompletions: (pfx) => {
			const s: string[] = [];
			if (session || load()) s.push("resume");
			if (session) s.push("close", "clear");
			return s.filter(v => !pfx || v.startsWith(pfx)).map(v => ({ label: v, value: v }));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const cmd = raw.toLowerCase();

			if (cmd === "close") {
				if (pending && session) {
					session.exchanges.push({ question: pq, answer: pa || "(cancelled)" });
					pending = false; pq = ""; pa = "";
				}
				if (session) save(session);
				session = undefined;
				render(ctx.ui);
				ctx.ui.notify("Side chat saved", "info");
				return;
			}
			if (cmd === "clear") {
				session = undefined; pending = false; pq = ""; pa = ""; nuke();
				render(ctx.ui);
				ctx.ui.notify("Side chat cleared", "info");
				return;
			}
			if (cmd === "resume") {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("No previous session", "warning"); return; }
				render(ctx.ui);
				ctx.ui.notify(`Resumed side chat (${session.exchanges.length} exchanges)`, "info");
				return;
			}
			if (!raw) {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("Usage: /side <question>", "info"); return; }
				render(ctx.ui);
				ctx.ui.notify(`Side chat active (${session.exchanges.length} exchanges)`, "info");
				return;
			}

			if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };
			if (pending) {
				session.exchanges.push({ question: pq, answer: pa || "(superseded)" });
				pending = false;
			}
			pq = raw; pa = ""; pending = true;
			render(ctx.ui);
			pi.sendUserMessage(prompt(pq, session.exchanges));
		},
	});
}
