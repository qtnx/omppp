import { formatInteger, formatWorkDuration } from "../data/formatters";
import type { TimeBudgetDashboardStats } from "../types";
import { EmptyState } from "./EmptyState";
import { Panel } from "./Panel";

export interface TimeBudgetPanelProps {
	stats: TimeBudgetDashboardStats;
}

/**
 * Compact outcome summary for `/time-budget` runs. Every value is stated as a
 * label plus a number so the section reads the same without color.
 */
export function TimeBudgetPanel({ stats }: TimeBudgetPanelProps) {
	return (
		<Panel title="Time budget" subtitle="How work sessions with a time budget finished in this range">
			{stats.totalRuns === 0 ? (
				<EmptyState message="No time budgets recorded for this range." />
			) : (
				<div className="stats-metric-cluster">
					<div className="stats-metric-primary-grid">
						<div className="stats-metric-card primary">
							<div className="stats-metric-label">Runs</div>
							<div className="stats-metric-value">{formatInteger(stats.totalRuns)}</div>
						</div>
						<div className="stats-metric-card primary" title="Finished with time to spare">
							<div className="stats-metric-label">Within budget</div>
							<div className="stats-metric-value">{formatInteger(stats.withinBudgetRuns)}</div>
						</div>
						<div className="stats-metric-card primary" title="Finished after the budget ran out">
							<div className="stats-metric-label">Overtime</div>
							<div className="stats-metric-value">{formatInteger(stats.overtimeRuns)}</div>
						</div>
						<div className="stats-metric-card primary" title="Still running, so the outcome is not counted yet">
							<div className="stats-metric-label">Open</div>
							<div className="stats-metric-value">{formatInteger(stats.openRuns)}</div>
						</div>
						<div className="stats-metric-card primary" title="Average extra time across runs that went over">
							<div className="stats-metric-label">Average overtime</div>
							<div className="stats-metric-value">
								{stats.overtimeRuns === 0 ? "None" : formatWorkDuration(stats.averageOvertimeMs)}
							</div>
						</div>
					</div>
				</div>
			)}
		</Panel>
	);
}
