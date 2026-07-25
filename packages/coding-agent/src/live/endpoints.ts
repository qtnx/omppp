/** Media side of a live call: owns the WebRTC peer and the audio devices. */
export interface LiveMediaEndpoint {
	/** Create the peer and return its SDP offer. */
	createOffer(): Promise<string>;
	/** Apply the SDP answer returned by Codex signaling. */
	acceptAnswer(sdp: string): Promise<void>;
	/** Resolve once the media path (and its input device) is usable. */
	waitForOpen(timeoutMs?: number): Promise<void>;
	/** Enable or disable microphone transmission. */
	setMuted(muted: boolean): Promise<void>;
	/** Register the assistant output level, 0..1, used by the phase machine and visualizer. */
	onOutputLevel(handler: (level: number) => void): void;
	/** Register the fatal media failure handler. */
	onFailure(handler: (message: string) => void): void;
	close(): Promise<void>;
}

/** Agent side of a live call: runs delegated coding requests. */
export interface LiveAgentEndpoint {
	/** Run one delegated request; context and completion arrive through the handlers below. */
	startDelegation(id: string, request: string): void;
	/** Register the streamed agent output handler for an in-flight delegation. */
	onContext(handler: (delegationId: string, text: string, kind?: "commentary") => void): void;
	/** Register the handler fired when a delegation finishes. */
	onDelegationEnd(handler: (delegationId: string) => void): void;
	close(): Promise<void>;
}

/** Identity of the machine that runs the agent; feeds live instructions and Codex headers. */
export interface LiveAgentIdentity {
	/** Session id sent to Codex as the scoped session / thread id. */
	sessionId: string;
	/** OS account name of the agent host. */
	username: string;
	/** Conversational first name derived from the account. */
	firstName: string;
	/** Working directory of the agent host. */
	cwd: string;
}
