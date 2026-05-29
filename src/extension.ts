/**
 * Side Chat — Multi-turn ephemeral conversation with inline TUI.
 *
 * Registers:
 *   /side           — Open/resume side chat
 *   /side close     — Close and save
 *   /side clear     — Close and discard
 *
 * Uses setWidget for the chat view and onTerminalInput for raw keystrokes
 * so the user types directly in the main editor area while the side chat
 * widget renders below. Agent turn runs normally — no blocking.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SideExchange { question: string; answer: string }
interface SideSession { exchanges: SideExchange[]; createdAt: number }

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DIR = path.join(os.homedir(), ".omp", "side-sessions");

function save(s: SideSession) {
	try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, "latest.json"), JSON.stringify(s), "utf-8"); } catch {}
}
function load(): SideSession | undefined {
	try { return JSON.parse(fs.readFileSync(path.join(DIR, "latest.json"), "utf-8")); } catch {}
}
function clearSave() { try { fs.unlinkSync(path.join(DIR, "latest.json")); } catch {} }

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function makePrompt(q: string, hist: SideExchange[]): string {
	const h = hist.length === 0 ? "" :
		"\nPrevious exchanges:\n" + hist.map((e, i) => `Q${i+1}: ${e.question}\nA${i+1}: ${e.answer}`).join("\n\n") + "\n";
	return `<side>\nThis is an ephemeral side conversation. Answer briefly using existing context.\nDO NOT use any tools. DO NOT ask follow-up questions.\n${h}Question: ${q}\n</side>`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let streaming = false;
	let sq = "";
	let sa = "";
	let expecting = false;
	let active = false;
	let unsubInput: (() => void) | undefined;
	const inp = new Input();

	// -------------------------------------------------------------------
	// Render
	// -------------------------------------------------------------------

	function render(ctx: { ui: ExtensionUIContext }) {
		if (!session) {
			ctx.ui.setWidget("side", undefined);
			ctx.ui.setStatus("side", undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const lines: string[] = [];
		const n = session.exchanges.length;
		const icon = streaming ? "↔" : "💬";

		lines.push(theme.fg("accent", theme.bold(`${icon} Side Chat${n ? ` (${n})` : ""}`)));
		lines.push(theme.fg("dim", "─".repeat(60)));
		lines.push("");

		for (let i = 0; i < session.exchanges.length; i++) {
			const ex = session.exchanges[i];
			lines.push(theme.fg("accent", `  ▸ ${ex.question}`));
			for (const l of ex.answer.split("\n")) lines.push(`    ${l}`);
			if (i < session.exchanges.length - 1) lines.push("");
		}

		if (streaming) {
			if (session.exchanges.length) lines.push("");
			lines.push(theme.fg("accent", `  ▸ ${sq}`));
			if (sa) {
				for (const l of sa.split("\n")) lines.push(`    ${l}`);
			} else {
				lines.push(theme.fg("dim", "    ⋯"));
			}
		}

		lines.push("");
		lines.push(theme.fg("dim", streaming
			? "  Streaming... · Esc to cancel and close"
			: "  Type question + Enter to ask · Esc to close and save"));

		// Show current input buffer
		const buf = inp.getValue();
		if (buf) {
			lines.push("");
			lines.push(theme.fg("accent", `  > ${buf}█`));
		}

		ctx.ui.setWidget("side", lines, { placement: "belowEditor" });
		ctx.ui.setStatus("side", streaming ? "↔ Side chat" : "💬 Side chat");
	}

	// -------------------------------------------------------------------
	// Events
	// -------------------------------------------------------------------

	pi.on("message_update", (event, ctx: ExtensionContext) => {
		if (!streaming || !expecting || !session) return;
		if (event.assistantMessageEvent?.type === "text_delta") {
			sa += event.assistantMessageEvent.delta ?? "";
			render(ctx);
		}
	});

	pi.on("message_end", (_event, ctx: ExtensionContext) => {
		if (!streaming || !expecting || !session) return;
		expecting = false;
		session.exchanges.push({ question: sq, answer: sa.trim() || "(no answer)" });
		streaming = false; sq = ""; sa = "";
		save(session);
		render(ctx);
	});

	// -------------------------------------------------------------------
	// Open/Close helpers (need ctx)
	// -------------------------------------------------------------------

	function close(ctx: { ui: ExtensionUIContext }) {
		if (streaming && session) {
			session.exchanges.push({ question: sq, answer: sa || "(cancelled)" });
			streaming = false; expecting = false; sq = ""; sa = "";
		}
		if (session) save(session);
		session = undefined;
		active = false;
		inp.setValue("");
		unsubInput?.();
		unsubInput = undefined;
		render(ctx);
	}

	function openSession(ctx: ExtensionCommandContext) {
		if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };
		active = true;
		inp.setValue("");

		// Register terminal input listener
		unsubInput = ctx.ui.onTerminalInput((data: string) => {
			if (!active || !session) return;

			// Escape — close
			if (data === "\x1b") {
				close(ctx);
				return { consume: true };
			}
			// Ctrl+C — close
			if (data === "\x03") {
				close(ctx);
				return { consume: true };
			}
			// Enter — submit
			if (data === "\n" || data === "\r") {
				const val = inp.getValue().trim();
				if (!val) return { consume: true };
				if (streaming) {
					session.exchanges.push({ question: sq, answer: sa || "(cancelled)" });
					streaming = false; expecting = false;
				}
				sq = val; sa = ""; streaming = true;
				inp.setValue("");
				render(ctx);
				expecting = true;
				pi.sendUserMessage(makePrompt(sq, session.exchanges));
				return { consume: true };
			}

			// Forward all other keys to input
			inp.handleInput(data);
			render(ctx);
			return { consume: true };
		});

		render(ctx);
		ctx.ui.notify("💬 Side chat active — type your question · Esc to close", "info");
	}

	// -------------------------------------------------------------------
	// Command: /side
	// -------------------------------------------------------------------

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

			if (cmd === "close") {
				close(ctx);
				ctx.ui.notify("Side chat saved", "info");
				return;
			}
			if (cmd === "clear") {
				session = undefined; streaming = false; expecting = false; active = false;
				sq = ""; sa = "";
				unsubInput?.(); unsubInput = undefined;
				clearSave();
				render(ctx);
				ctx.ui.notify("Side chat cleared", "info");
				return;
			}
			if (cmd === "resume") {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("No previous side chat", "warning"); return; }
				openSession(ctx);
				return;
			}
			if (cmd) {
				ctx.ui.notify("Usage: /side | /side close | /side clear | /side resume", "info");
				return;
			}

			// Default: open
			openSession(ctx);
		},
	});
}
