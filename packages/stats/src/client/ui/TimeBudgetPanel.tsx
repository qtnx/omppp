import { formatInteger, formatWorkDuration } from "../data/formatters";
import type { TimeBudgetDashboardStats } from "../types";
import { Card } from "./Card";
import { EmptyState } from "./States";
import { Stat, StatGrid } from "./Stat";

export interface TimeBudgetPanelProps {
	stats: TimeBudgetDashboardStats;
}

/** Compact outcome summary for `/time-budget` runs. */
export function TimeBudgetPanel({ stats }: TimeBudgetPanelProps) {
	return (
		<Card title="Time budget" description="How work sessions with a time budget finished in this range">
			{stats.totalRuns === 0 ? (
				<EmptyState title="No time budgets recorded for this range." />
			) : (
				<StatGrid min={140}>
					<Stat label="Runs" value={formatInteger(stats.totalRuns)} />
					<Stat label="Within budget" value={formatInteger(stats.withinBudgetRuns)} />
					<Stat label="Overtime" value={formatInteger(stats.overtimeRuns)} />
					<Stat label="Open" value={formatInteger(stats.openRuns)} />
					<Stat
						label="Average overtime"
						value={stats.overtimeRuns === 0 ? "None" : formatWorkDuration(stats.averageOvertimeMs)}
					/>
				</StatGrid>
			)}
		</Card>
	);
}
