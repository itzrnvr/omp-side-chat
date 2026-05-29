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
	messageId: string | undefined;
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

	lines.push(theme.fg("dim", "─── Side Chat" + (session.exchanges.length > 0 ? ` (${session.exchanges.length} exchanges)` : "") + " ───"));

	let i = 0;
	for (const ex of session.exchanges) {
		const prefix = session.exchanges.length > 1 ? `Q${i + 1}: ` : "";
		lines.push(theme.fg("accent", `${prefix}${ex.question}`));

		const answer = ex.answer.trim() || "(no answer)";
		// Truncate long answers in the widget (show first 20 lines)
		const answerLines = answer.split("\n");
		const shown = answerLines.slice(0, 20).join("\n");
		lines.push(shown);
		if (answerLines.length > 20) {
			lines.push(theme.fg("dim", `  ... +${answerLines.length - 20} more lines`));
		}

		if (i < session.exchanges.length - 1 || session.streaming) {
			lines.push("");
		}
		i++;
	}

	// Show currently streaming answer
	if (session.streaming && session.currentAnswer) {
		lines.push(session.currentAnswer.split("\n").slice(0, 20).join("\n"));
	}

	lines.push("");
	lines.push(
		theme.fg(
			"muted",
			session.streaming
				? "Streaming... · Esc to cancel"
				: "/side <question> to follow up · /side close to dismiss",
		),
	);

	return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sideExtension(pi: ExtensionAPI): void {
	pi.setLabel("Side Chat");

	let session: SideSession | undefined;

	// -----------------------------------------------------------------------
	// Event: capture streaming text from assistant responses
	// -----------------------------------------------------------------------

	pi.on("message_update", async (event, ctx) => {
		if (!session?.streaming) return;

		const msgEvent = event.assistantMessageEvent;
		if (msgEvent.type === "text_delta") {
			session.currentAnswer += msgEvent.delta;
			updateWidget(ctx, session);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!session?.streaming) return;

		// Extract text from the completed assistant message
		const msg = event.message;
		if (msg.role === "assistant") {
			const textBlocks = msg.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((b) => b.text);
			const fullText = textBlocks.join("\n");

			if (fullText) {
				session.currentAnswer = fullText;
			}
		}

		// Only finalize if we were actually tracking this as a side exchange
		session.exchanges.push({
			question: session.currentQuestion,
			answer: session.currentAnswer,
		});
		session.streaming = false;
		session.currentQuestion = "";
		session.currentAnswer = "";

		updateWidget(ctx, session);
	});

	// -----------------------------------------------------------------------
	// Command: /side
	// -----------------------------------------------------------------------

	pi.registerCommand("side", {
		description: "Multi-turn side conversation",
		getArgumentCompletions: (prefix) => {
			if (session) {
				const subs = ["close"];
				return subs.filter((s) => !prefix || s.startsWith(prefix)).map((s) => ({ label: s, value: s }));
			}
			return [];
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			if (!trimmed) {
				ctx.ui.notify("Usage: /side <question>", "info");
				return;
			}

			if (trimmed.toLowerCase() === "close") {
				session = undefined;
				ctx.ui.setWidget("side", undefined);
				ctx.ui.notify("Side chat closed", "info");
				return;
			}

			// If currently streaming, abort first
			if (session?.streaming && ctx.isIdle() === false) {
				ctx.abort();
				// Record partial
				session.exchanges.push({
					question: session.currentQuestion,
					answer: session.currentAnswer || "(cancelled)",
				});
				session.streaming = false;
			}

			// Create session if needed
			if (!session) {
				session = {
					exchanges: [],
					streaming: false,
					currentQuestion: "",
					currentAnswer: "",
					messageId: undefined,
				};
			}

			// Start new exchange
			session.currentQuestion = trimmed;
			session.currentAnswer = "";
			session.streaming = true;

			updateWidget(ctx, session);

			// Build and send the side prompt
			const sidePrompt = buildPrompt(trimmed, session.exchanges);
			pi.sendUserMessage(sidePrompt);
		},
	});

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	function updateWidget(ctx: { ui: ExtensionUIContext }, s: SideSession) {
		ctx.ui.setWidget("side", formatWidgetLines(s, ctx.ui.theme), { placement: "belowEditor" });
	}
}
