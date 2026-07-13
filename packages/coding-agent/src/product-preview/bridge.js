// Injected inline into /mockup/<id> documents by the product-preview server.
// Templates call window.OmpxPreview; the parent app listens for postMessage.
(function () {
	"use strict";

	function post(kind, payload) {
		var message = { __ompxPreview: 1, kind: kind };
		if (payload) {
			for (var key in payload) {
				if (Object.prototype.hasOwnProperty.call(payload, key)) {
					message[key] = payload[key];
				}
			}
		}
		window.parent.postMessage(message, "*");
	}

	window.OmpxPreview = {
		sendPrompt: function (text) {
			post("prompt", { prompt: text });
		},
		submitAnswer: function (opts) {
			opts = opts || {};
			post("answer", {
				questionId: opts.questionId,
				question: opts.question,
				selection: opts.selection,
			});
		},
		ready: function () {
			post("ready", {});
		},
	};
})();
