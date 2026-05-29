/**
 * Side Chat — Right-aligned panel for ephemeral multi-turn conversation.
 *
 * /side <question>  — Ask a question (live-streaming in right panel)
 * /side close       — Close and save
 * /side clear       — Discard
 * /side             — Resume / status
 * /close            — Shortcut to close
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
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

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let pending = false;
	let pq = "";
	let pa = "";

	function extractMsgContent(msg: any): string { if(typeof msg.content==="string")return msg.content; if(Array.isArray(msg.content))return msg.content.map((p:any)=>typeof p==="object"&&p&&"text"in p?p.text:"").join("");return"";} function render(ui: ExtensionUIContext) {
		if (!session) { ui.setWidget("side", undefined); ui.setStatus("side", undefined); return; }

		ui.setWidget("side", (_tui: TUI, theme) => {
			const s = session!;
			const icon = pending ? "↔" : "💬";
			const n = s.exchanges.length;

			return {
				render(w: number) {
					const pw = Math.min(Math.floor(w * 0.40), 60);
					const pad = Math.max(w - pw - 1, 0);
					const cw = Math.max(pw - 4, 10);
					const sp = " ".repeat(pad);
					const lines: string[] = [];

					lines.push(sp + theme.fg("accent", theme.bold(`╭─ ${icon} Side Chat${n ? ` (${n})` : ""}`)));
					lines.push(sp + theme.fg("accent", "│ ") + theme.fg("dim", "/side <q> · /close"));

					const MAX = 5;
					const start = Math.max(0, n - MAX);
					if (start > 0) lines.push(sp + theme.fg("dim", `│  ... (${start} earlier)`));
					for (let i = start; i < n; i++) {
						const e = s.exchanges[i];
						const q = e.question.length > cw - 5 ? e.question.slice(0, cw - 8) + "…" : e.question;
						lines.push(sp + theme.fg("accent", "│ ▸ ") + theme.fg("accent", q));
						for (const l of e.answer.split("\n").slice(0, 4)) {
							lines.push(sp + theme.fg("accent", "│  ") + (l.length > cw ? l.slice(0, cw - 1) + "…" : l));
						}
					}
					if (pending) {
						if (n) lines.push(sp + theme.fg("accent", "│"));
						const q = pq.length > cw - 5 ? pq.slice(0, cw - 8) + "…" : pq;
						lines.push(sp + theme.fg("accent", "│ ▸ ") + theme.fg("accent", q));
						if (pa) {
							for (const l of pa.split("\n").slice(-4)) {
								lines.push(sp + theme.fg("accent", "│  ") + (l.length > cw ? l.slice(0, cw - 1) + "…" : l));
							}
						} else {
							lines.push(sp + theme.fg("dim", "│ ⋯"));
						}
					}
					lines.push(sp + theme.fg("accent", `╰${"─".repeat(Math.min(pw - 1, cw + 2))}`));
					return lines;
				},
				invalidate() {},
			} satisfies Component;
		}, { placement: "aboveEditor" });

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
		session.exchanges.push({ question: pq, answer: pa.trim() || extractMsgContent(msg) || "(no answer)" });
		pending = false; pq = ""; pa = "";
		save(session);
		render(ctx.ui);
	});

	pi.registerCommand("side", {
		description: "Multi-turn side conversation (right panel)",
		getArgumentCompletions: (pfx) => {
			const s: string[] = [];
			if (session || load()) s.push("resume");
			if (session) s.push("close", "clear");
			return s.filter(v => !pfx || v.startsWith(pfx)).map(v => ({ label: v, value: v }));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const cmd = raw.toLowerCase();

			if (cmd === "close") { close(ctx.ui); ctx.ui.notify("Side chat saved", "info"); return; }
			if (cmd === "clear") {
				session = undefined; pending = false; pq = ""; pa = ""; nuke();
				render(ctx.ui); ctx.ui.notify("Side chat cleared", "info"); return;
			}
			if (cmd === "resume") {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("No previous session", "warning"); return; }
				render(ctx.ui);
				ctx.ui.notify(`💬 Side chat (${session.exchanges.length} exchanges)`, "info");
				return;
			}
			if (!raw) {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("Usage: /side <question>", "info"); return; }
				render(ctx.ui);
				ctx.ui.notify(`💬 Side chat (${session.exchanges.length} exchanges)`, "info");
				return;
			}

			if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };
			if (pending) { session.exchanges.push({ question: pq, answer: pa || "(superseded)" }); pending = false; }
			pq = raw; pa = ""; pending = true;
			render(ctx.ui);
			pi.sendUserMessage(prompt(pq, session.exchanges));
		},
	});

	pi.registerCommand("close", {
		description: "Close the side chat panel",
		handler: async (_args, ctx) => {
			if (!session) return;
			close(ctx.ui);
			ctx.ui.notify("Side chat closed", "info");
		},
	});

	function close(ui: ExtensionUIContext) {
		if (pending && session) {
			session.exchanges.push({ question: pq, answer: pa || "(cancelled)" });
			pending = false; pq = ""; pa = "";
		}
		if (session) save(session);
		session = undefined;
		render(ui);
	}
}
