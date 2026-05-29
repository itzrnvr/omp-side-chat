/**
 * Side Chat — Split-view side panel for ephemeral multi-turn conversation.
 *
 * /side [question]  — Open sidechat (right half of terminal). If question given, send it.
 * /close            — Close the sidechat and save session
 * /side close       — Also closes the sidechat (alias)
 * /side clear       — Clear saved session
 *
 * When sidechat is open, all input goes to the sidechat. Type question + Enter to send.
 * Type /close or press Esc to exit back to main session.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui";
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

function extractMsgContent(msg: { content: unknown }): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.map((p) => (typeof p === "object" && p && "text" in p ? (p as { text: string }).text : ""))
			.join("");
	}
	return "";
}

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let pending = false;
	let pq = "";
	let pa = "";
	let sideOverlay: OverlayHandle | undefined;
	let unsubInput: (() => void) | undefined;
	let tuiRef: TUI | undefined;

	function closeSidechat() {
		if (pending && session) {
			session.exchanges.push({ question: pq, answer: pa || "(cancelled)" });
			pending = false; pq = ""; pa = "";
		}
		if (session) save(session);
		unsubInput?.();
		unsubInput = undefined;
		sideOverlay?.hide();
		sideOverlay = undefined;
		tuiRef = undefined;
	}

	function submitQuestion(question: string) {
		if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };
		// Reject empty submissions (handles CRLF double-submit)
		if (!question.trim()) return;
		if (pending) {
			session.exchanges.push({ question: pq, answer: pa || "(cancelled)" });
			pending = false;
		}
		if (question === "/close" || question === "/side close") {
			closeSidechat();
			return;
		}
		pq = question.trim();
		pa = "";
		pending = true;
		pi.sendUserMessage(prompt(pq, session.exchanges));
		tuiRef?.requestRender(true);
	}

	// Live streaming
	pi.on("message_update", (event) => {
		if (!pending || !session) return;
		if (event.assistantMessageEvent?.type === "text_delta") {
			pa += event.assistantMessageEvent.delta ?? "";
			tuiRef?.requestRender(true);
		}
	});

	pi.on("message_end", (event) => {
		if (!pending || !session) return;
		const msg = event.message as { role: string; content: unknown };
		if (msg.role !== "assistant") return;
		const answer = pa.trim() || extractMsgContent(msg) || "(no answer)";
		session.exchanges.push({ question: pq, answer });
		pending = false; pq = ""; pa = "";
		save(session);
		tuiRef?.requestRender(true);
	});

	// /side command
	pi.registerCommand("side", {
		description: "Open side chat session (right half of terminal)",
		getArgumentCompletions: (pfx) => {
			const s: string[] = [];
			if (sideOverlay || session || load()) s.push("close", "clear");
			return s.filter((v) => !pfx || v.startsWith(pfx)).map((v) => ({ label: v, value: v }));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const cmd = raw.toLowerCase();

			if (cmd === "close") {
				closeSidechat();
				ctx.ui.notify("Side chat closed", "info");
				return;
			}
			if (cmd === "clear") {
				if (!sideOverlay) session = undefined;
				nuke();
				ctx.ui.notify("Side chat cleared", "info");
				return;
			}

			// If overlay already open, submit question via the active session
			if (sideOverlay) {
				if (raw) submitQuestion(raw);
				return;
			}

			// Initialize session
			if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };

			// Open sidechat overlay via custom()
			await ctx.ui.custom<void>(async (tui, theme, _kb, done) => {
				tuiRef = tui;

				const input = new Input();
				input.onSubmit = (val: string) => {
					submitQuestion(val);
					input.setValue("");
					tui.requestRender(true);
				};
				input.onEscape = () => {
					closeSidechat();
				};

				// Panel component: right-side chat UI with its own input
				const panel: Component = {
					handleInput(data: string) {
						input.handleInput(data);
						tui.requestRender(true);
					},
					render(w: number) {
						const lines: string[] = [];
						if (!session) return lines;
						const s = session;
						const n = s.exchanges.length;
						const cw = Math.max(w - 4, 10);

						// Header
						const icon = pending ? "↔" : "💬";
						const title = `${icon} Side Chat${n ? ` (${n})` : ""}`;
						lines.push(theme.fg("accent", theme.bold(`╭─ ${title}${"─".repeat(Math.max(0, w - title.length - 4))}`)));

						// Scrollback for long history
						const MAX = Math.max(3, Math.floor((tui.terminal.rows - 10) / 4));
						const start = Math.max(0, n - MAX);
						if (start > 0) lines.push(theme.fg("dim", `│  ... (${start} earlier)`));

						for (let i = start; i < n; i++) {
							const e = s.exchanges[i];
							const q = e.question.length > cw - 5 ? e.question.slice(0, cw - 8) + "…" : e.question;
							lines.push(theme.fg("accent", "│ ▸ ") + q);
							for (const l of e.answer.split("\n").slice(0, 4)) {
								lines.push(theme.fg("accent", "│  ") + (l.length > cw ? l.slice(0, cw - 1) + "…" : l));
							}
							if (i < n - 1) lines.push(theme.fg("dim", "│"));
						}

						// Pending exchange
						if (pending) {
							if (n) lines.push(theme.fg("dim", "│"));
							const q = pq.length > cw - 5 ? pq.slice(0, cw - 8) + "…" : pq;
							lines.push(theme.fg("accent", "│ ▸ ") + q);
							if (pa) {
								for (const l of pa.split("\n").slice(-4)) {
									lines.push(theme.fg("accent", "│  ") + (l.length > cw ? l.slice(0, cw - 1) + "…" : l));
								}
							} else {
								lines.push(theme.fg("dim", "│  ⋯"));
							}
						}

						// Separator
						lines.push(theme.fg("accent", "├" + "─".repeat(w - 2) + "┤"));

						// Input field
						const inputLines = input.render(w - 2).map((l) => theme.fg("accent", "│ ") + l);
						lines.push(...inputLines);

						// Bottom border
						lines.push(theme.fg("accent", "╰" + "─".repeat(w - 2) + "╯"));

						// Footer hint
						lines.push(theme.fg("dim", "  Type your question + Enter · Esc to exit"));

						return lines;
					},
					invalidate() {
						input.invalidate();
					},
				};

				// Create overlay on the right half
				sideOverlay = tui.showOverlay(panel, {
					anchor: "right-center",
					width: "50%",
					maxHeight: "100%",
				});

				// Capture all terminal input for the sidechat
				unsubInput?.();
				unsubInput = ctx.ui.onTerminalInput((data) => {
					// Only while overlay is active
					if (!sideOverlay) return;
					input.handleInput(data);
					tui.requestRender(true);
					return { consume: true };
				});

				// Submit initial question if provided
				if (raw) {
					submitQuestion(raw);
				}

				// Release the custom() — overlay persists via sideOverlay handle
				done(undefined);

				// Return a stub (not rendered)
				return { render() { return []; }, invalidate() {} };
			}, { overlay: true });
		},
	});

	// /close shortcut
	pi.registerCommand("close", {
		description: "Close the side chat panel",
		handler: async (_args, ctx) => {
			if (!sideOverlay && !session) return;
			closeSidechat();
			ctx.ui.notify("Side chat closed", "info");
		},
	});
}
