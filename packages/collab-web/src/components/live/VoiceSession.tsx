import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import type { GuestClient } from "../../lib/client";
import { useGuestSnapshot } from "../../lib/use-guest";
import { Banners } from "../shell/Banners";
import { LivePanel } from "./LivePanel";
import "./live.css";

export interface VoiceSessionProps {
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
}

const PHASE_NOTE: Record<string, string> = {
	connecting: "Connecting to the session…",
	live: "Connected. Start the call when you are ready.",
	ended: "The session ended.",
};

/**
 * Voice-only view (`?voice=1`). Same relay session as the full client, but it
 * renders no transcript, tool cards, agent rail, or composer — the DOM stays a
 * few dozen nodes, which keeps a long-running call cheap on phones and laptops.
 */
export function VoiceSession({ client, onLeave, onRejoin }: VoiceSessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";

	useEffect(() => {
		document.title = `${title} · voice`;
	}, [title]);

	return (
		<div className="lv-solo">
			<header className="lv-solo-head">
				<h1 className="lv-solo-title">{title}</h1>
				<button type="button" className="lv-btn" onClick={onLeave} aria-label="Leave session">
					<LogOut size={14} />
					Leave
				</button>
			</header>
			<p className="lv-solo-note" aria-live="polite">
				{PHASE_NOTE[snap.phase] ?? snap.phase}
			</p>
			<LivePanel client={client} snapshot={snap} />
			<p className="lv-solo-hint">
				Voice only — the transcript stays in the full client. Drop <code>?voice=1</code> from the URL to open it.
			</p>
			<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
		</div>
	);
}
