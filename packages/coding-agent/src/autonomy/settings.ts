import { register } from "../config/registry";

export const cfgAutonomyStopGate = register({
	id: "autonomy.stopGate",
	type: "boolean",
	default: true,
});
