/**
 * Side Chat — Multi-turn ephemeral conversation.
 *
 * /side           — Open/resume side chat
 * /side close     — Close and save
 * /side clear     — Close and discard
 *
 * The widget renders below the editor. onTerminalInput captures keystrokes.
 * Only message_end is used for answer capture (reliable, no async race).
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
const persist = (s: SideSession) => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, "latest.json"), JSON.stringify(s), "utf-8"); } catch {} };
const restore = (): SideSession | undefined => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "latest.json"), "utf-8")); } catch {} };
const purge = () => { try { fs.unlinkSync(path.join(DIR, "latest.json")); } catch {} };

function sidePrompt(q: string, hist: SideExchange[]): string {
	const h = hist.length ? "\nPrevious exchanges:\n" + hist.map((e, i) => `Q${i+1}: ${e.question}\nA${i+1}: ${e.answer}`).join("\n\n") + "\n" : "";
	return `<side>\nEphemeral side conversation. Answer briefly from context. NO tools. NO follow-up questions.\n${h}Question: ${q}\n</side>`;
}

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let active = false;
	let unsub: (() => void) | undefined;
	let pending = false;   // waiting for message_end
	let pendingQ = "";
	const inp = new Input();

	// -------------------------------------------------------------------
	// Render widget
	// -------------------------------------------------------------------

	function render(ui: ExtensionUIContext) {
		if (!session) { ui.setWidget("side", undefined); ui.setStatus("side", undefined); return; }
		const t = ui.theme;
		const lines: string[] = [];
		const n = session.exchanges.length;
		const icon = pending ? "↔" : "💬";
		lines.push(t.fg("accent", t.bold(`${icon} Side Chat${n ? ` (${n})` : ""}`)));
		lines.push(t.fg("dim", "─".repeat(50)));
		for (let i = 0; i < session.exchanges.length; i++) {
			const e = session.exchanges[i];
			lines.push(t.fg("accent", `  ▸ ${e.question}`));
			for (const l of e.answer.split("\n")) lines.push(`    ${l}`);
			if (i < session.exchanges.length - 1) lines.push("");
		}
		if (pending) {
			if (n) lines.push("");
			lines.push(t.fg("accent", `  ▸ ${pendingQ}`));
			lines.push(t.fg("dim", "    ⋯ waiting for response"));
		}
		lines.push("");
		lines.push(t.fg("dim", pending ? "  Streaming... Esc=close" : "  Type+Enter=ask · Esc=close and save"));
		const buf = inp.getValue();
		if (buf && !pending) { lines.push(""); lines.push(t.fg("accent", `  ▸ ${buf}█`)); }
		ui.setWidget("side", lines, { placement: "belowEditor" });
		ui.setStatus("side", pending ? "↔ Side chat" : "💬 Side chat");
	}

	// -------------------------------------------------------------------
	// Capture completed answer
	// -------------------------------------------------------------------

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
		session.exchanges.push({ question: pendingQ, answer: answer.trim() || "(no answer)" });
		pending = false; pendingQ = "";
		persist(session);
		render(ctx.ui);
	});

	// -------------------------------------------------------------------
	// Open/close
	// -------------------------------------------------------------------

	function close(ui: ExtensionUIContext) {
		if (pending && session) {
			session.exchanges.push({ question: pendingQ, answer: "(cancelled)" });
			pending = false; pendingQ = "";
		}
		if (session) persist(session);
		session = undefined; active = false; inp.setValue("");
		unsub?.(); unsub = undefined;
		render(ui);
	}

	function open(ui: ExtensionUIContext) {
		if (!session) session = restore() ?? { exchanges: [], createdAt: Date.now() };
		active = true; inp.setValue("");
		unsub?.();
		unsub = ui.onTerminalInput((data: string) => {
			if (!active || !session) return;
			// Escape/Ctrl+C: close
			if (data === "\x1b" || data === "\x03") { close(ui); return { consume: true }; }
			// Forward slash: let it through (don't consume) so /side close works
			if (data === "/") return { consume: false };
			// Enter: submit
			if (data === "\n" || data === "\r") {
				const v = inp.getValue().trim();
				if (!v || pending) return { consume: true }; // block while streaming
				pendingQ = v; pending = true;
				inp.setValue(""); render(ui);
				pi.sendUserMessage(sidePrompt(pendingQ, session.exchanges));
				return { consume: true };
			}
			// All other input goes to the Input component
			inp.handleInput(data); render(ui);
			return { consume: true };
		});
		render(ui);
		ui.notify("💬 Side chat — type your question · Esc to close", "info");
	}

	// -------------------------------------------------------------------
	// Command
	// -------------------------------------------------------------------

	pi.registerCommand("side", {
		description: "Multi-turn side conversation",
		getArgumentCompletions: (pfx) => {
			const s: string[] = [];
			if (session || restore()) s.push("resume");
			if (session) s.push("close", "clear");
			return s.filter(v => !pfx || v.startsWith(pfx)).map(v => ({ label: v, value: v }));
		},
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();
			if (cmd === "close") { close(ctx.ui); ctx.ui.notify("Side chat saved", "info"); return; }
			if (cmd === "clear") {
				session = undefined; pending = false; pendingQ = ""; active = false;
				unsub?.(); unsub = undefined; purge();
				render(ctx.ui); ctx.ui.notify("Side chat cleared", "info"); return;
			}
			if (cmd === "resume") {
				if (!session) session = restore();
				if (!session) { ctx.ui.notify("No previous session", "warning"); return; }
				open(ctx.ui); return;
			}
			if (cmd) { ctx.ui.notify("Usage: /side | /side close | /side clear | /side resume", "info"); return; }
			open(ctx.ui);
		},
	});
}
