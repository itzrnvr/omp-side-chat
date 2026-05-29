/**
 * Side Chat — Multi-turn ephemeral conversation.
 *
 * /side <question>  — Ask a question
 * /side close       — Close and save session
 * /side clear       — Discard session
 * /side             — Resume or show status
 *
 * Questions are sent via sendUserMessage with no-tools prompt.
 * Answers captured from message_end. Session persists to disk.
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

function sidePrompt(q: string, hist: SideExchange[]): string {
	const h = hist.length ? "\nPrevious exchanges:\n" + hist.map((e, i) => `Q${i+1}: ${e.question}\nA${i+1}: ${e.answer}`).join("\n\n") + "\n" : "";
	return `<side>\nEphemeral side conversation. Answer briefly from context. NO tools. NO follow-up questions.\n${h}Question: ${q}\n</side>`;
}

function widgetLines(session: SideSession, pending: boolean, pendQ: string, theme: ExtensionUIContext["theme"]): string[] {
	const lines: string[] = [];
	const n = session.exchanges.length;
	const icon = pending ? "↔" : "💬";
	lines.push(theme.fg("accent", theme.bold(`${icon} Side Chat${n ? ` (${n})` : ""} ─ /side <q> to ask · /side close to dismiss`)));
	lines.push(theme.fg("dim", "─".repeat(60)));
	for (let i = 0; i < session.exchanges.length; i++) {
		const e = session.exchanges[i];
		lines.push(theme.fg("accent", `  ▸ ${e.question}`));
		for (const l of e.answer.split("\n").slice(0, 30)) lines.push(`    ${l}`);
		if (i < session.exchanges.length - 1) lines.push("");
	}
	if (pending) {
		if (n) lines.push("");
		lines.push(theme.fg("accent", `  ▸ ${pendQ}`));
		lines.push(theme.fg("dim", "    ⋯ streaming"));
	}
	return lines;
}

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let pending = false;
	let pendQ = "";

	function render(ui: ExtensionUIContext) {
		if (!session) { ui.setWidget("side", undefined); ui.setStatus("side", undefined); return; }
		ui.setWidget("side", widgetLines(session, pending, pendQ, ui.theme), { placement: "belowEditor" });
		ui.setStatus("side", pending ? "↔ Side chat" : "💬 Side chat");
	}

	pi.on("message_end", (event, ctx: ExtensionContext) => {
		if (!pending || !session) return;
		const msg = event.message as { role: string; content: unknown };
		let answer = "";
		if (typeof msg.content === "string") answer = msg.content;
		else if (Array.isArray(msg.content)) {
			for (const p of msg.content) {
				if (typeof p === "object" && p && "text" in p) answer += (p as { text: string }).text;
			}
		}
		session.exchanges.push({ question: pendQ, answer: answer.trim() || "(no answer)" });
		pending = false; pendQ = "";
		save(session);
		render(ctx.ui);
	});

	pi.registerCommand("side", {
		description: "Multi-turn side conversation",
		getArgumentCompletions: (pfx) => {
			const s: string[] = [];
			if (session || load()) s.push("resume");
			if (session) s.push("close", "clear");
			return s.filter(v => !pfx || v.startsWith(pfx)).map(v => ({ label: v, value: v }));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const cmd = raw.toLowerCase();

			// Close: /side close
			if (cmd === "close") {
				if (pending && session) {
					session.exchanges.push({ question: pendQ, answer: "(cancelled)" });
					pending = false; pendQ = "";
				}
				if (session) save(session);
				session = undefined;
				render(ctx.ui);
				ctx.ui.notify("Side chat saved", "info");
				return;
			}

			// Clear: /side clear
			if (cmd === "clear") {
				session = undefined; pending = false; pendQ = ""; nuke();
				render(ctx.ui);
				ctx.ui.notify("Side chat cleared", "info");
				return;
			}

			// Resume: /side resume
			if (cmd === "resume") {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("No previous session", "warning"); return; }
				render(ctx.ui);
				ctx.ui.notify(`Resumed side chat (${session.exchanges.length} exchanges)`, "info");
				return;
			}

			// No args: show status or resume
			if (!raw) {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("Usage: /side <question>", "info"); return; }
				render(ctx.ui);
				ctx.ui.notify(`Side chat active (${session.exchanges.length} exchanges)`, "info");
				return;
			}

			// Ask question: /side <question>
			if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };
			if (pending) {
				session.exchanges.push({ question: pendQ, answer: "(superseded)" });
				pending = false;
			}
			pendQ = raw;
			pending = true;
			render(ctx.ui);
			pi.sendUserMessage(sidePrompt(pendQ, session.exchanges));
		},
	});
}
