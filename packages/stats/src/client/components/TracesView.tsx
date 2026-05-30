import { ArrowLeft, Braces, ChevronDown, ChevronRight, FileJson, GitBranch, MessageSquare, Search, X } from "lucide-react";
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import "../vendor/euphony/euphony.js";
import { getSessions, getSessionTrace } from "../api";
import type { SessionSummary, SessionTrace, TraceNode } from "../types";

interface TracesViewProps {
	onSelectRequest?: (id: number) => void;
}

type EuphonyRole = "assistant" | "developer" | "system" | "tool" | "user";

interface EuphonyTextCont