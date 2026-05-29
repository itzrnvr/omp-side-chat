/**
 * Side Chat — Multi-turn ephemeral conversation with inline TUI.
 *
 * /side           — Open/resume side chat
 * /side close     — Close and save
 * /side clear     — Close and discard
 *
 * Uses setWidget for the chat view and onTerminalInput for raw keystrokes.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { Input } from "@oh-my-pi/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface SideExchange { question: string; answer: string }
interface SideSession { exchanges: SideExchange[]; createdAt: number }

const DIR = path.join(os.homedir(), ".omp", "side-sessions");
function save(s: SideSession) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, "latest.json"), JSON.stringify(s), "utf-8"); } catch {} }
function load(): SideSession | undefined { try { return JSON.parse(fs.readFileSync(path.join(DIR, "latest.json"), "utf-8")); } catch {} }
function clearSave() { try { fs.unlinkSync(path.join(DIR, "latest.json")); } catch {} }

function makePrompt(q: string, hist: SideExchange[]): string {
	const h = hist.length === 0 ? "" :
		"\nPrevious exchanges:\n" + hist.map((e, i) => `Q${i+1}: ${e.question}\nA${i+1}: ${e.answer}`).join("\n\n") + "\n";
	return `<side>\nThis is an ephemeral side conversation. Answer briefly using existing context.\nDO NOT use any tools. DO NOT ask follow-up questions.\n${h}Question: ${q}\n</side>`;
}

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let streaming = false;
	let sq = "";
	let sa = "";
	let expecting = false;
	let active = false;
	let unsubInput: (() => void) | undefined;
	const inp = new Input();

	function render(ctx: { ui: ExtensionUIContext }) {
		if (!session) { ctx.ui.setWidget("side", undefined); ctx.ui.setStatus("side", undefined); return; }
		const t = ctx.ui.theme;
		const lines: string[] = [];
		const n = session.exchanges.length;
		lines.push(t.fg("accent", t.bold(`${streaming ? "↔" : "💬"} Side Chat${n ? ` (${n})` : ""}`)));
		lines.push(t.fg("dim", "─".repeat(50)));
		for (let i = 0; i < session.exchanges.length; i++) {
			const ex = session.exchanges[i];
			lines.push(t.fg("accent", `  ▸ ${ex.question}`));
			for (const l of ex.answer.split("\n")) lines.push(`    ${l}`);
			if (i < session.exchanges.length - 1) lines.push("");
		}
		if (streaming) {
			if (session.exchanges.length) lines.push("");
			lines.push(t.fg("accent", `  ▸ ${sq}`));
			lines.push(t.fg("dim", "    ⋯"));
		}
		lines.push("");
		const hint = streaming ? "Streaming..." : "Type + Enter to ask · Esc to close";
		lines.push(t.fg("dim", `  ${hint}`));
		const buf = inp.getValue();
		if (buf && !streaming) lines.push(t.fg("accent", `  > ${buf}█`));
		ctx.ui.setWidget("side", lines, { placement: "belowEditor" });
		ctx.ui.setStatus("side", streaming ? "↔ Side chat" : "💬 Side chat");
	}

	// Capture full answer from message_end
	pi.on("message_end", (event, ctx: ExtensionContext) => {
		if (!streaming || !expecting || !session) return;
		expecting = false;
		// Extract text from the completed message
		const msg = event.message as { role: string; content: unknown };
		let answer = "";
		if (typeof msg.content === "string") {
			answer = msg.content;
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (typeof part === "object" && part && "text" in part) answer += (part as { text: string }).text;
			}
		}
		session.exchanges.push({ question: sq, answer: answer.trim() || "(no answer)" });
		streaming = false; sq = ""; sa = "";
		save(session);
		render(ctx);
	});

	function close(ctx: { ui: ExtensionUIContext }) {
		if (streaming && session) {
			session.exchanges.push({ question: sq, answer: sa || "(cancelled)" });
			streaming = false; expecting = false; sq = ""; sa = "";
		}
		if (session) save(session);
		session = undefined; active = false; inp.setValue("");
		unsubInput?.(); unsubInput = undefined;
		render(ctx);
	}

	function openSession(ctx: ExtensionCommandContext) {
		if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };
		active = true; inp.setValue("");
		unsubInput = ctx.ui.onTerminalInput((data: string) => {
			if (!active || !session) return;
			if (data === "\x1b" || data === "\x03") { close(ctx); return { consume: true }; }
			if (data === "\n" || data === "\r") {
				const val = inp.getValue().trim();
				if (!val) return { consume: true };
				if (streaming) {
					session.exchanges.push({ question: sq, answer: sa || "(cancelled)" });
					streaming = false; expecting = false;
				}
				sq = val; sa = ""; streaming = true;
				inp.setValue(""); render(ctx);
				expecting = true;
				pi.sendUserMessage(makePrompt(sq, session.exchanges));
				return { consume: true };
			}
			inp.handleInput(data); render(ctx);
			return { consume: true };
		});
		render(ctx);
		ctx.ui.notify("💬 Side chat — type your question · Esc to close", "info");
	}

	pi.registerCommand("side", {
		description: "Multi-turn side conversation",
		getArgumentCompletions: (pfx) => {
			const s: string[] = [];
			if (session || load()) s.push("resume");
			if (session) s.push("close", "clear");
			return s.filter(v => !pfx || v.startsWith(pfx)).map(v => ({ label: v, value: v }));
		},
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();
			if (cmd === "close") { close(ctx); ctx.ui.notify("Side chat saved", "info"); return; }
			if (cmd === "clear") {
				session = undefined; streaming = false; expecting = false; active = false; sq = ""; sa = "";
				unsubInput?.(); unsubInput = undefined; clearSave();
				render(ctx); ctx.ui.notify("Side chat cleared", "info"); return;
			}
			if (cmd === "resume") {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("No previous side chat", "warning"); return; }
				openSession(ctx); return;
			}
			if (cmd) { ctx.ui.notify("Usage: /side | /side close | /side clear | /side resume", "info"); return; }
			openSession(ctx);
		},
	});
}
