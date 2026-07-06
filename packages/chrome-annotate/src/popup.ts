interface PairStorage {
	host?: string;
}

interface PairResponse {
	ok?: boolean;
	error?: string;
	session?: string;
}

interface StatusResponse {
	ok?: boolean;
	error?: string;
	host?: string | null;
	paired?: boolean;
	session?: string;
}

const hostInput = document.getElementById("host") as HTMLInputElement | null;
const codeInput = document.getElementById("code") as HTMLInputElement | null;
const connectButton = document.getElementById("connect") as HTMLButtonElement | null;
const annotateButton = document.getElementById("annotate") as HTMLButtonElement | null;
const statusEl = document.getElementById("status") as HTMLDivElement | null;

if (!hostInput || !codeInput || !connectButton || !annotateButton || !statusEl) {
	throw new Error("popup_dom_missing");
}

const getStoredPairing = async (): Promise<PairStorage> => {
	const { promise, resolve, reject } = Promise.withResolvers<PairStorage>();
	chrome.storage.local.get(["host"], items => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve(items as PairStorage);
	});
	return promise;
};

const queryActiveTab = async (): Promise<chrome.tabs.Tab[]> => {
	const { promise, resolve, reject } = Promise.withResolvers<chrome.tabs.Tab[]>();
	chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve(tabs);
	});
	return promise;
};

const executeContentScript = async (tabId: number): Promise<void> => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
		const err = chrome.runtime.lastError;
		if (err) {
			reject(new Error(err.message));
			return;
		}
		resolve();
	});
	return promise;
};

const persistHost = async (host: string): Promise<string | null> => {
	const trimmed = host.trim();
	if (!trimmed) return null;
	try {
		const response = (await chrome.runtime.sendMessage({ type: "ompx-annotate-set-host", host: trimmed })) as
			| PairResponse
			| undefined;
		if (response && response.ok === false) return response.error ?? "host_save_failed";
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

const setStatus = (message: string, isError = false) => {
	statusEl.textContent = message;
	statusEl.classList.toggle("error", isError);
};

const setAnnotateAvailability = () => {
	annotateButton.disabled = !hostInput.value.trim();
};

const loadStoredPairing = async () => {
	try {
		const stored = await getStoredPairing();
		if (stored.host) hostInput.value = stored.host;
		setAnnotateAvailability();
		const [tab] = await queryActiveTab();
		if (!tab?.id) {
			setStatus("No active tab.", true);
			return;
		}
		const response = (await chrome.runtime.sendMessage({ type: "ompx-annotate-status", tabId: tab.id })) as
			| StatusResponse
			| undefined;
		if (response?.ok) {
			if (response.host && !hostInput.value.trim()) hostInput.value = response.host;
			setAnnotateAvailability();
			setStatus(response.paired ? `Tab paired with ${response.session ?? "session"}` : "Tab not paired");
			return;
		}
		setStatus(response?.error ?? "Could not read tab status.", true);
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), true);
	}
};

connectButton.addEventListener("click", async () => {
	const host = hostInput.value.trim();
	const code = codeInput.value.trim();
	if (!host || !code) {
		setStatus("Enter host and pairing code.", true);
		return;
	}

	connectButton.disabled = true;
	annotateButton.disabled = true;
	setStatus("Connecting...");
	try {
		const [tab] = await queryActiveTab();
		const response = (await chrome.runtime.sendMessage({ type: "ompx-annotate-pair", host, code, tabId: tab?.id })) as
			| PairResponse
			| undefined;
		if (response?.ok) {
			setAnnotateAvailability();
			setStatus(`Paired with ${response.session ?? "session"}`);
			return;
		}
		setStatus(response?.error ?? "Pairing failed.", true);
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), true);
	} finally {
		connectButton.disabled = false;
		setAnnotateAvailability();
	}
});

hostInput.addEventListener("input", setAnnotateAvailability);
hostInput.addEventListener("change", () => {
	void persistHost(hostInput.value);
});

annotateButton.addEventListener("click", async () => {
	annotateButton.disabled = true;
	setStatus("Opening annotator...");
	try {
		const [tab] = await queryActiveTab();
		if (!tab?.id) {
			setStatus("No active tab.", true);
			annotateButton.disabled = false;
			return;
		}
		const hostError = await persistHost(hostInput.value);
		if (hostError) {
			setStatus(hostError, true);
			annotateButton.disabled = false;
			return;
		}
		await executeContentScript(tab.id);
		window.close();
	} catch {
		setStatus("Could not inject annotator on this page.", true);
		annotateButton.disabled = false;
	}
});

void loadStoredPairing();
