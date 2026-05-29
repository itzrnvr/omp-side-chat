/**
 * Side Chat — Multi-turn ephemeral side conversation.
 *
 * Registers:
 *   /side <question>  — Ask a follow-up question in the side chat
 *   /side close       — Close the side chat panel
 *
 * The side chat uses a widget to display exchanges and sends questions
 * through the normal session with strong "no tools" prompt instructions.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SideExchange {
	question: string;
	answer: string;
}

interface SideSession {
	exchanges: SideExchange[];
	streaming: boolean;
	currentQuestion: string;
	currentAnswer: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(question: string, exchanges: SideExchange[]): string {
	const historyBlock =
		exchanges.length === 0
			? ""
			: "\nPrevious exchanges in this side conversation:\n" +
				exchanges
					.map((ex, i) => `Q${i + 1}: ${ex.question}\nA${i + 1}: ${ex.answer || "(no answer)"}`)
					.join("\n\n") +
				"\n";

	return [
		"<side>",
		"This is an ephemeral side conversation for the current interactive session.",
		"Answer briefly and directly using the conversation context already provided.",
		"DO NOT use any tools — answer from your existing knowledge and context only.",
		"DO NOT ask follow-up questions.",
		historyBlock,
		`Question: ${question}`,
		"</side>",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

function formatWidgetLines(
	session: SideSession,
	theme: ExtensionUIContext["theme"],
): string[] {
	const lines: string[] = [];

	const tag = session.streaming ? "↔ Side Chat" : "Side Chat";
	const count = session.exchanges.length > 0 ? ` · ${session.exchanges.length} exchange${session.exchanges.length > 1 ? "s" : ""}` : "";
	lines.push(theme.fg("accent", `── ${tag}${count} ──`));

	for (let i = 0; i < session.exchanges.length; i++) {
		const ex = session.exchanges[i];
		lines.push(theme.fg("dim", `Q${i + 1}:`) + " " + theme.fg("accent", ex.question));
		const answer = ex.answer.trim() || "(no answer)";
		const answerLines = answer.split("\n");
		lines.push(answerLines.slice(0, 20).join("\n"));
		if (answerLines.length > 20) {
			lines.push(theme.fg("dim", `  ... +${answerLines.length - 20} more lines`));
		}
		if (i < session.exchanges.length - 1 || session.streaming) {
			lines.push("");
		}
	}

	if (session.streaming && session.currentAnswer) {
		lines.push(session.currentAnswer.split("\n").slice(0, 20).join("\n"));
	}

	lines.push("");
	lines.push(
		theme.fg(
			"muted",
			session.streaming
				? "Streaming... · Esc to cancel"
				: "/side to follow up · /side close to dismiss",
		),
	);

	return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSide(ctx: { ui: ExtensionUIContext }, session: SideSession | undefined) {
	if (!session) {
		ctx.ui.setWidget("side", undefined);
		ctx.ui.setStatus("side", undefined);
		return;
	}
	ctx.ui.setWidget("side", formatWidgetLines(session, ctx.ui.theme), { placement: "belowEditor" });
	ctx.ui.setStatus("side", session.streaming ? "↔ Side chat" : "	side chat");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sideExtension(pi: ExtensionAPI): void {
	let session: SideSession | undefined;
	let expectingResponse = false;

	// -------------------------------------------------------------------
	// Events: capture streaming responses
	// -------------------------------------------------------------------

	pi.on("message_update", (event, ctx: ExtensionContext) => {
		if (!session?.streaming || !expectingResponse) return;
		if (event.assistantMessageEvent?.type === "text_delta") {
			session.currentAnswer += event.assistantMessageEvent.delta ?? "";
			renderSide(ctx, session);
		}
	});

	pi.on("message_end", (_event, ctx: ExtensionContext) => {
		if (!session?.streaming || !expectingResponse) return;
		expectingResponse = false;
		session.exchanges.push({
			question: session.currentQuestion,
			answer: session.currentAnswer.trim() || "(no answer)",
		});
		session.streaming = false;
		session.currentQuestion = "";
		session.currentAnswer = "";
		renderSide(ctx, session);
	});

	// -------------------------------------------------------------------
	// Command: /side
	// -------------------------------------------------------------------

	pi.registerCommand("side", {
		description: "Multi-turn side conversation",
		getArgumentCompletions: (prefix) => {
			if (session) {
				return ["close"]
					.filter((s) => !prefix || s.startsWith(prefix))
					.map((s) => ({ label: s, value: s }));
			}
			return [];
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			if (trimmed === "close" || trimmed === "exit" || trimmed === "q") {
				session = undefined;
				expectingResponse = false;
				renderSide(ctx, session);
				ctx.ui.notify("Side chat closed", "info");
				return;
			}

			if (!trimmed) {
				if (session) {
					ctx.ui.notify(
						session.streaming
							? "Side chat streaming..."
							: `Side chat (${session.exchanges.length} exchanges) · /side close to dismiss`,
						"info",
					);
				} else {
					ctx.ui.notify("Usage: /side <question>", "info");
				}
				return;
			}

			// If streaming, abort first
			if (session?.streaming) {
				ctx.abort();
				session.exchanges.push({
					question: session.currentQuestion,
					answer: session.currentAnswer || "(cancelled)",
				});
				session.streaming = false;
				expectingResponse = false;
			}

			if (!session) {
				session = {
					exchanges: [],
					streaming: false,
					currentQuestion: "",
					currentAnswer: "",
				};
			}

			session.currentQuestion = trimmed;
			session.currentAnswer = "";
			session.streaming = true;

			renderSide(ctx, session);

			expectingResponse = true;
			pi.sendUserMessage(buildPrompt(trimmed, session.exchanges));
		},
	});
}
