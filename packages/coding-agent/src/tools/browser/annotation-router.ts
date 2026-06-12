import { logger } from "@oh-my-pi/pi-utils";
import type { AnnotationSubmission } from "./tab-protocol";

export type AnnotationListener = (submission: AnnotationSubmission) => void;

export interface AnnotationWaiter {
	resolve(submission: AnnotationSubmission): void;
	reject(error: unknown): void;
}

export interface AnnotationRouteState {
	annotations: AnnotationSubmission[];
	annotationWaiters: AnnotationWaiter[];
	annotationListener?: AnnotationListener;
}

const MAX_BUFFERED_ANNOTATIONS = 20;

export function routeAnnotationSubmission(state: AnnotationRouteState, submission: AnnotationSubmission): void {
	const waiter = state.annotationWaiters.shift();
	if (waiter) {
		waiter.resolve(submission);
		return;
	}
	if (deliverAnnotationToListener(state, submission)) return;
	state.annotations.push(submission);
	if (state.annotations.length > MAX_BUFFERED_ANNOTATIONS) state.annotations.shift();
}

export function drainBufferedAnnotations(state: AnnotationRouteState): void {
	if (!state.annotationListener) return;
	while (state.annotations.length > 0) {
		const submission = state.annotations.shift();
		if (!submission) return;
		deliverAnnotationToListener(state, submission);
	}
}

function deliverAnnotationToListener(state: AnnotationRouteState, submission: AnnotationSubmission): boolean {
	const listener = state.annotationListener;
	if (!listener) return false;
	try {
		listener(submission);
	} catch (error) {
		logger.warn("Annotation listener failed", { error: error instanceof Error ? error.message : String(error) });
	}
	return true;
}
