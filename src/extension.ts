/**
 * Side Chat — Right-side overlay panel for ephemeral multi-turn conversation.
 *
 * /side <question>  — Ask a question (live-streaming answer in right panel)
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
import type { Component, TUI, OverlayHandle } from "@oh-my-pi/pi-tui";
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

function panelLines(
	s: SideSession | undefined, pending: boolean, pq: string, pa: string,
	t: ExtensionUIContext["theme"], w: number,
): string[] {
	const lines: string[] = [];
	if (!s) return [t.fg("dim", "Side chat closed")];
	const n = s.exchanges.length;
	const icon = pending ? "↔" : "💬";
	lines.push(t.fg("accent", t.bold(`╭─ ${icon} Side Chat${n ? ` (${n})` : ""}`)));
	lines.push(t.fg("accent", `│  /side <q> · /side close`));

	const MAX = 4;
	const start = Math.max(0, n - MAX);
	if (start > 0) lines.push(t.fg("dim", `│  ... (${start} earlier)`));
	const cw = Math.max(w - 4, 10);
	for (let i = start; i < n; i++) {
		const e = s.exchanges[i];
		const q = e.question.length > cw - 5 ? e.question.slice(0, cw - 8) + "..." : e.question;
		lines.push(t.fg("accent", `│ ▸ ${q}`));
		for (const l of e.answer.split("\n").slice(0, 6)) {
			lines.push(`│  ${l.length > cw ? l.slice(0, cw - 1) + "…" : l}`);
		}
	}
	if (pending) {
		if (n) lines.push(t.fg("dim", "│"));
		const q = pq.length > cw - 5 ? pq.slice(0, cw - 8) + "..." : pq;
		lines.push(t.fg("accent", `│ ▸ ${q}`));
		if (pa) {
			for (const l of pa.split("\n").slice(-6)) {
				lines.push(`│  ${l.length > cw ? l.slice(0, cw - 1) + "…" : l}`);
			}
		} else {
			lines.push(t.fg("dim", "│ ⋯"));
		}
	}
	lines.push(t.fg("accent", `╰${"─".repeat(Math.min(w - 1, cw + 2))}`));
	return lines;
}

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let pending = false;
	let pq = "";
	let pa = "";
	let tuiRef: TUI | undefined;
	let overlay: OverlayHandle | undefined;

	function showOverlay(ui: ExtensionUIContext) {
		if (!tuiRef) return;

		const panel: Component = {
			render(w: number) {
				return panelLines(session, pending, pq, pa, ui.theme, w);
			},
			invalidate() {},
		};

		overlay?.hide();
		overlay = tuiRef.showOverlay(panel, {
			anchor: "top-right",
			width: "40%",
			maxHeight: "80%",
		});

		ui.setStatus("side", pending ? "↔ Side chat" : "💬 Side chat");
	}

	pi.on("message_update", (_event, ctx: ExtensionContext) => {
		if (!pending || !session || !tuiRef) return;
		const evt = _event as { assistantMessageEvent?: { type?: string; delta?: string } };
		if (evt.assistantMessageEvent?.type === "text_delta") {
			pa += evt.assistantMessageEvent.delta ?? "";
			tuiRef.requestRender();
		}
	});

	pi.on("message_end", (event, ctx: ExtensionContext) => {
		if (!pending || !session) return;
		const msg = event.message as { role: string; content: unknown };
		if (msg.role !== "assistant") return;
		session.exchanges.push({ question: pq, answer: pa.trim() || "(no answer)" });
		pending = false; pq = ""; pa = "";
		save(session);
		tuiRef?.requestRender();
		ctx.ui.setStatus("side", "💬 Side chat");
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

			if (cmd === "close") {
				if (pending && session) {
					session.exchanges.push({ question: pq, answer: pa || "(cancelled)" });
					pending = false; pq = ""; pa = "";
				}
				if (session) save(session);
				session = undefined;
				overlay?.hide(); overlay = undefined; tuiRef = undefined;
				ctx.ui.setStatus("side", undefined);
				ctx.ui.notify("Side chat saved", "info");
				return;
			}
			if (cmd === "clear") {
				session = undefined; pending = false; pq = ""; pa = "";
				overlay?.hide(); overlay = undefined; tuiRef = undefined;
				nuke();
				ctx.ui.setStatus("side", undefined);
				ctx.ui.notify("Side chat cleared", "info");
				return;
			}
			if (cmd === "resume") {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("No previous session", "warning"); return; }
			} else if (!raw) {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("Usage: /side <question>", "info"); return; }
			} else if (cmd !== "resume") {
				if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };
				if (pending) {
					session.exchanges.push({ question: pq, answer: pa || "(superseded)" });
					pending = false;
				}
				pq = raw; pa = ""; pending = true;
				pi.sendUserMessage(prompt(pq, session.exchanges));
			}

			if (!tuiRef) {
				await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
					tuiRef = tui;
					showOverlay(ctx.ui);
					done(undefined);
					return { render() { return []; }, invalidate() {} };
				});
			} else {
				showOverlay(ctx.ui);
			}

			const msg = pending ? "💬 Side chat — asking..." :
				session?.exchanges.length ? `💬 Side chat (${session.exchanges.length} exchanges)` :
				"💬 Side chat — /side <q> to ask";
			ctx.ui.notify(msg, "info");
		},
	});
}
