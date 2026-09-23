/**
 * Copy for the Tailscale login shortcut every OAuth surface (login dialog, MCP
 * auth prompt, setup wizard, `auth-broker login`) shows when the callback
 * server also listens on this host's tailnet address.
 */
export const TAILNET_SHORTCUT_LABEL = "Tailscale shortcut (other devices):";

/**
 * The provider still redirects to `localhost`, which on another device points
 * at that device. The callback server answers on the tailnet address too, so
 * swapping the host finishes the login.
 */
export function tailnetCallbackHint(tailnetLaunchUrl: string): string {
	const { hostname } = new URL(tailnetLaunchUrl);
	return `On another device, if sign-in ends on a localhost page that won't load, replace "localhost" with ${hostname} in the address bar and reload.`;
}
