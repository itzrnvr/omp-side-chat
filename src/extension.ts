/**
 * Side Chat — Full-screen multi-turn ephemeral conversation.
 *
 * Registers:
 *   /side           — Open side chat (resumes previous if any)
 *   /side close     — Close and save current side chat
 *   /side clear     — Close and discard current side chat
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { Container, Input } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";
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
function clear() { try { fs.unlinkSync(path.join(DIR, "latest.json")); } catch {} }

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function prompt(q: string, hist: SideExchange[]): string {
	const h = hist.length === 0 ? "" :
		"\nPrevious exchanges:\n" + hist.map((e, i) => `Q${i+1}: ${e.question}\nA${i+1}: ${e.answer}`).join("\n\n") + "\n";
	return `<side>\nThis is an ephemeral side conversation. Answer briefly using existing context.\nDO NOT use any tools. DO NOT ask follow-up questions.\n${h}Question: ${q}\n</side>`;
}

// ---------------------------------------------------------------------------
// History renderer
// ---------------------------------------------------------------------------

function historyLines(
	ex: SideExchange[], sq: string | undefined, sa: string,
	theme: ExtensionUIContext["theme"], w: number, max: number,
): string[] {
	const out: string[] = [];
	const mw = Math.max(w - 4, 40);
	const wrap = (t: string, m: number) => t.split("\n").flatMap(l => l.length <= m ? [l] : (l.match(new RegExp(`.{1,${m}}`, "g")) ?? [l]));

	for (let i = 0; i < ex.length; i++) {
		out.push(theme.fg("accent", `▸ ${ex[i].question}`));
		for (const l of wrap(ex[i].answer, mw)) out.push(`  ${l}`);
		if (i < ex.length - 1) out.push("");
	}
	if (sq !== undefined) {
		if (ex.length) out.push("");
		out.push(theme.fg("accent", `▸ ${sq}`));
		for (const l of wrap(sa || "⋯", mw)) out.push(`  ${l}`);
	}
	if (out.length > max) return out.slice(out.length - max);
	while (out.length < max) out.push("");
	return out;
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
	let kick: (() => void) | undefined;

	pi.on("message_update", (ev) => {
		if (!streaming || !expecting) return;
		if (ev.assistantMessageEvent?.type === "text_delta") { sa += ev.assistantMessageEvent.delta ?? ""; kick?.(); }
	});

	pi.on("message_end", () => {
		if (!streaming || !expecting) return;
		expecting = false;
		session!.exchanges.push({ question: sq, answer: sa.trim() || "(no answer)" });
		streaming = false; sq = ""; sa = "";
		save(session!); kick?.();
	});

	pi.registerCommand("side", {
		description: "Full-screen side conversation",
		getArgumentCompletions: (pfx) => {
			const s: string[] = [];
			if (session || load()) s.push("resume");
			if (session) s.push("close", "clear");
			return s.filter(s => !pfx || s.startsWith(pfx)).map(s => ({ label: s, value: s }));
		},
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();

			if (cmd === "close") {
				if (session) save(session);
				session = undefined; streaming = false; expecting = false;
				ctx.ui.notify("Side chat saved", "info"); return;
			}
			if (cmd === "clear") {
				session = undefined; streaming = false; expecting = false; clear();
				ctx.ui.notify("Side chat cleared", "info"); return;
			}
			if (cmd === "resume") {
				if (!session) session = load();
				if (!session) { ctx.ui.notify("No previous side chat", "warning"); return; }
			} else if (cmd) {
				ctx.ui.notify("Usage: /side | /side close | /side clear | /side resume", "info"); return;
			}

			if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const input = new Input();
				input.onSubmit = (v: string) => {
					if (!v.trim()) return;
					if (streaming) {
						session!.exchanges.push({ question: sq, answer: sa || "(cancelled)" });
						streaming = false; expecting = false;
					}
					sq = v.trim(); sa = ""; streaming = true;
					input.setValue(""); tui.requestRender();
					expecting = true;
					pi.sendUserMessage(prompt(sq, session!.exchanges));
				};
				input.onEscape = () => { save(session!); done(undefined); };

				const hdr: Component = {
					render(_w: number) {
						const n = session!.exchanges.length;
						return [theme.fg("accent", theme.bold(`── Side Chat${n ? ` (${n})` : ""} ──`)) + theme.fg("dim", "  Enter=ask · Esc=close")];
					},
					invalidate() {},
				};

				const hist: Component = {
					render(w: number) {
						const m = Math.max(tui.terminal.rows - 3, 3);
						return historyLines(session!.exchanges, streaming ? sq : undefined, sa, theme, w, m);
					},
					invalidate() {},
				};

				const box = new Container();
				box.addChild(hdr);
				box.addChild(hist);
				box.addChild(input);

				kick = () => tui.requestRender();

				return {
					render(w: number) { return box.render(w); },
					invalidate() { box.invalidate(); },
					handleInput(d: string) {
						if (d === "\x03") { save(session!); done(undefined); return; }
						input.handleInput(d); tui.requestRender();
					},
				};
			});

			kick = undefined;
		},
	});
}
