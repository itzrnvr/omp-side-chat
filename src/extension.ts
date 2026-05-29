/**
 * Side Chat — Split-view side panel with ISOLATED subprocess session.
 *
 * /side [question]  — Open sidechat (right half of terminal).
 * /side close       — Close the sidechat and save session
 * /side clear       — Clear saved session
 * /close            — Shortcut to close sidechat
 *
 * When sidechat is open, all input goes to the sidechat.
 * Questions run in a SEPARATE omp subprocess (--no-session, no tools).
 * Nothing appears in the main session.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface SideExchange { question: string; answer: string }
interface SideSession { exchanges: SideExchange[]; createdAt: number }

const SESSION_DIR = path.join(os.homedir(), ".omp", "side-sessions");
const save = (s: SideSession) => { try { fs.mkdirSync(SESSION_DIR, { recursive: true }); fs.writeFileSync(path.join(SESSION_DIR, "latest.json"), JSON.stringify(s), "utf-8"); } catch {} };
const load = (): SideSession | undefined => { try { return JSON.parse(fs.readFileSync(path.join(SESSION_DIR, "latest.json"), "utf-8")); } catch {} };
const nuke = () => { try { fs.unlinkSync(path.join(SESSION_DIR, "latest.json")); } catch {} };

function buildTaskPrompt(question: string, history: SideExchange[]): string {
	const parts: string[] = [
		"This is an ephemeral side conversation. Answer briefly. DO NOT use any tools.",
	];
	if (history.length) {
		parts.push("\nPrevious exchanges:");
		for (let i = 0; i < history.length; i++) {
			const e = history[i];
			parts.push(`Q${i + 1}: ${e.question}`);
			parts.push(`A${i + 1}: ${e.answer}`);
		}
	}
	parts.push(`\nQuestion: ${question}`);
	return parts.join("\n");
}

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let pending = false;
	let pq = "";
	let pa = "";
	let sideOverlay: OverlayHandle | undefined;
	let unsubInput: (() => void) | undefined;
	let tuiRef: TUI | undefined;
	let childProcess: ChildProcess | null = null;
	let tmpDir: string | null = null;

	function cleanupTmp() {
		if (tmpDir) {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
			tmpDir = null;
		}
	}

	function closeSidechat() {
		childProcess?.kill();
		childProcess = null;
		cleanupTmp();
		if (pending && session) {
			session.exchanges.push({ question: pq, answer: pa || "(cancelled)" });
			pending = false; pq = ""; pa = "";
		}
		if (session) save(session);
		unsubInput?.();
		unsubInput = undefined;
		sideOverlay?.hide();
		sideOverlay = undefined;
		tuiRef?.requestRender(true);
		tuiRef = undefined;
	}

	function submitQuestion(question: string) {
		if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };
		if (!question.trim()) return;
		if (childProcess) {
			// Kill previous in-flight question
			childProcess.kill();
			childProcess = null;
			cleanupTmp();
			if (pending) {
				session.exchanges.push({ question: pq, answer: pa || "(cancelled)" });
				pending = false;
			}
		}
		if (question === "/close" || question === "/side close") {
			closeSidechat();
			return;
		}
		pq = question.trim();
		pa = "";
		pending = true;
		tuiRef?.requestRender(true);

		// Write prompt to temp file (avoids shell quoting issues)
		const taskPrompt = buildTaskPrompt(pq, session.exchanges);
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "side-chat-"));
		const promptPath = path.join(tmpDir, "prompt.md");
		fs.writeFileSync(promptPath, taskPrompt, { mode: 0o600 });

		// Spawn isolated omp subprocess
		const child = spawn("omp", [
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--no-title",
			`@${promptPath}`,
		], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: true,
			windowsHide: true,
		});
		childProcess = child;

		let output = "";
		child.stdout!.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			pa = output.trim();
			tuiRef?.requestRender(true);
		});

		child.stderr!.on("data", () => { /* discard */ });

		child.on("close", (code) => {
			cleanupTmp();
			if (childProcess !== child) return; // superseded
			childProcess = null;
			const answer = (code === 0 ? output.trim() : `(error: exit ${code})`) || "(no answer)";
			if (session) {
				session.exchanges.push({ question: pq, answer });
				save(session);
			}
			pending = false; pq = ""; pa = "";
			tuiRef?.requestRender(true);
		});
	}

	// /side command
	pi.registerCommand("side", {
		description: "Open isolated side chat (right half of terminal)",
		getArgumentCompletions: (pfx) => {
			const s: string[] = [];
			if (sideOverlay || session || load()) s.push("close", "clear");
			return s.filter((v) => !pfx || v.startsWith(pfx)).map((v) => ({ label: v, value: v }));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const cmd = raw.toLowerCase();

			if (cmd === "close") { closeSidechat(); ctx.ui.notify("Side chat closed", "info"); return; }
			if (cmd === "clear") {
				if (!sideOverlay) session = undefined;
				nuke();
				ctx.ui.notify("Side chat cleared", "info");
				return;
			}
			if (sideOverlay) {
				if (raw) submitQuestion(raw);
				return;
			}
			if (!session) session = load() ?? { exchanges: [], createdAt: Date.now() };

			await ctx.ui.custom<void>(async (tui, theme, _kb, done) => {
				tuiRef = tui;

				const input = new Input();
				input.onSubmit = (val: string) => {
					submitQuestion(val);
					input.setValue("");
					tui.requestRender(true);
				};
				input.onEscape = () => { closeSidechat(); };

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

						const icon = pending ? "↔" : "💬";
						const title = `${icon} Side Chat${n ? ` (${n})` : ""}`;
						lines.push(theme.fg("accent", theme.bold(`╭─ ${title}${"─".repeat(Math.max(0, w - title.length - 4))}`)));

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
						if (pending) {
							if (n) lines.push(theme.fg("dim", "│"));
							const q = pq.length > cw - 5 ? pq.slice(0, cw - 8) + "…" : pq;
							lines.push(theme.fg("accent", "│ ▸ ") + q);
							if (pa) {
								// Show last few lines of streaming output
								const answerLines = pa.split("\n");
								for (const l of answerLines.slice(-4)) {
									lines.push(theme.fg("accent", "│  ") + (l.length > cw ? l.slice(0, cw - 1) + "…" : l));
								}
							} else {
								lines.push(theme.fg("dim", "│  ⋯ starting subprocess"));
							}
						}

						lines.push(theme.fg("accent", "├" + "─".repeat(w - 2) + "┤"));
						const inputLines = input.render(w - 2).map((l) => theme.fg("accent", "│ ") + l);
						lines.push(...inputLines);
						lines.push(theme.fg("accent", "╰" + "─".repeat(w - 2) + "╯"));
						lines.push(theme.fg("dim", "  Type your question + Enter · Esc to exit"));

						return lines;
					},
					invalidate() { input.invalidate(); },
				};

				sideOverlay = tui.showOverlay(panel, {
					anchor: "right-center",
					width: "50%",
					maxHeight: "100%",
				});

				unsubInput?.();
				unsubInput = ctx.ui.onTerminalInput((data) => {
					if (!sideOverlay) return;
					input.handleInput(data);
					tui.requestRender(true);
					return { consume: true };
				});

				if (raw) submitQuestion(raw);

				done(undefined);
				return { render() { return []; }, invalidate() {} };
			}, { overlay: true });
		},
	});

	pi.registerCommand("close", {
		description: "Close the side chat panel",
		handler: async (_args, ctx) => {
			if (!sideOverlay && !session) return;
			closeSidechat();
			ctx.ui.notify("Side chat closed", "info");
		},
	});
}
