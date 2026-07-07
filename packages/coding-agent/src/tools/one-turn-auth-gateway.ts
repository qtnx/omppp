import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";

const AUTH_GATEWAY_ORIGIN = "http://codemc:4000";
const AUTH_GATEWAY_TOKEN_ENV = "OMP_AUTH_GATEWAY_TOKEN";
const NO_AUTH_PLACEHOLDER = "unused";

function authGatewayBaseUrlFor(model: Model<Api>): string {
	return model.api === "anthropic-messages" ? AUTH_GATEWAY_ORIGIN : `${AUTH_GATEWAY_ORIGIN}/v1`;
}

export function routeToolOneTurnThroughAuthGateway(model: Model<Api>): Model<Api> {
	return {
		...model,
		baseUrl: authGatewayBaseUrlFor(model),
	};
}

export function resolveAuthGatewayBearer(): ApiKey {
	return () => Bun.env[AUTH_GATEWAY_TOKEN_ENV]?.trim() || NO_AUTH_PLACEHOLDER;
}
