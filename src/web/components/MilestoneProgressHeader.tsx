import React from "react";
import type { Milestone, Task } from "../../types";
import { buildMilestoneBuckets, milestoneKey } from "../utils/milestones";
import { collectArchivedMilestoneKeys } from "../utils/milestones";

interface MilestoneProgressHeaderProps {
	/** The `?milestone=` filter value currently applied to the page. */
	milestoneFilter: string;
	tasks: Task[];
	statuses: string[];
	milestoneEntities: Milestone[];
	archivedMilestones: Milestone[];
}

/**
 * Compact progress summary shown above the task list / board when the page is
 * filtered to a single milestone (e.g. opened via a milestone card's
 * List / Board link). Reuses buildMilestoneBuckets so the completion math and
 * milestone resolution match the Milestones page exactly. The time-elapsed
 * cycle bar mirrors the one rendered on the milestone card.
 */
const MilestoneProgressHeader: React.FC<MilestoneProgressHeaderProps> = ({
	milestoneFilter,
	tasks,
	statuses,
	milestoneEntities,
	archivedMilestones,
}) => {
	const filterKey = milestoneKey(milestoneFilter);
	if (!filterKey || filterKey === "__none") return null;

	const archivedMilestoneIds = collectArchivedMilestoneKeys(archivedMilestones, milestoneEntities);
	const buckets = buildMilestoneBuckets(tasks, milestoneEntities, statuses, {
		archivedMilestoneIds,
		archivedMilestones,
	});
	const bucket = buckets.find(
		(b) => !b.isNoMilestone && b.milestone && milestoneKey(b.milestone) === filterKey,
	);
	if (!bucket) return null;

	const entity = milestoneEntities.find(
		(m) => milestoneKey(m.id) === filterKey || milestoneKey(m.title) === filterKey,
	);

	const timeCycle = (() => {
		if (!entity?.startDate || !entity?.endDate) return null;
		const start = new Date(`${entity.startDate}T00:00:00`).getTime();
		const end = new Date(`${entity.endDate}T23:59:59`).getTime();
		if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
		const now = Date.now();
		const pct = Math.min(100, Math.max(0, Math.round(((now - start) / (end - start)) * 100)));
		const msLeft = end - now;
		const daysLeft = Math.ceil(msLeft / 86_400_000);
		const label =
			now < start
				? `Starts in ${Math.ceil((start - now) / 86_400_000)}d`
				: msLeft <= 0
					? "Overdue"
					: `${daysLeft}d left`;
		return { pct, label, overdue: msLeft <= 0 && now >= start };
	})();

	return (
		<div className="mx-4 mt-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-4">
			<div className="flex items-center justify-between gap-4">
				<h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">{bucket.label}</h2>
				<div className="flex items-center gap-3">
					<span className="text-sm text-gray-500 dark:text-gray-400">
						{bucket.total} task{bucket.total === 1 ? "" : "s"}
					</span>
					<span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{bucket.progress}%</span>
				</div>
			</div>

			<div className="mt-3">
				<div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
					<span>{bucket.doneCount} done</span>
					<span>
						{bucket.total - bucket.doneCount} ticket{bucket.total - bucket.doneCount === 1 ? "" : "s"} remaining
					</span>
				</div>
				<div className="w-full h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
					<div
						className="h-full bg-emerald-500 transition-all duration-300"
						style={{ width: `${bucket.progress}%` }}
					/>
				</div>
			</div>

			{timeCycle && (
				<div className="mt-3">
					<div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
						<span>{timeCycle.pct}% time elapsed</span>
						<span className={timeCycle.overdue ? "text-red-600 dark:text-red-400 font-medium" : ""}>
							{timeCycle.label}
						</span>
					</div>
					<div className="w-full h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
						<div
							className={`h-full transition-all duration-300 ${timeCycle.overdue ? "bg-red-500" : "bg-blue-500"}`}
							style={{ width: `${timeCycle.pct}%` }}
						/>
					</div>
				</div>
			)}
		</div>
	);
};

export default MilestoneProgressHeader;
