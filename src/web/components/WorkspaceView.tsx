import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type Milestone, type Task } from '../../types';
import BoardPage from './BoardPage';
import MilestoneProgressHeader from './MilestoneProgressHeader';
import TaskList from './TaskList';

type ViewMode = 'board' | 'list';

interface WorkspaceViewProps {
	projectName: string;
	onEditTask: (task: Task) => void;
	onNewTask: () => void;
	tasks: Task[];
	onRefreshData?: () => Promise<void>;
	statuses: string[];
	milestones: string[];
	availableLabels: string[];
	milestoneEntities: Milestone[];
	archivedMilestones: Milestone[];
	isLoading: boolean;
}

/** localStorage key is project-scoped so different projects remember different views. */
function viewStorageKey(projectName: string): string {
	return `backlog.view.${projectName || 'default'}`;
}

function parseView(value: string | null): ViewMode | null {
	return value === 'board' || value === 'list' ? value : null;
}

/**
 * Resolve the initial view. Precedence (mirrors BoardPage's `?lane=` handling):
 * `?view=` param wins and is persisted as the new per-project default; otherwise
 * the stored per-project preference; otherwise Board.
 */
function resolveInitialView(paramView: string | null, projectName: string): ViewMode {
	const fromParam = parseView(paramView);
	if (fromParam) {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(viewStorageKey(projectName), fromParam);
		}
		return fromParam;
	}
	const stored = typeof window !== 'undefined' ? window.localStorage.getItem(viewStorageKey(projectName)) : null;
	return parseView(stored) ?? 'board';
}

export default function WorkspaceView({ projectName, onEditTask, onNewTask, tasks, onRefreshData, statuses, milestones, availableLabels, milestoneEntities, archivedMilestones, isLoading }: WorkspaceViewProps) {
	const [searchParams, setSearchParams] = useSearchParams();
	const [view, setView] = useState<ViewMode>(() => resolveInitialView(searchParams.get('view'), projectName));

	// Keep view in sync if the `?view=` param changes (e.g. via a shared link).
	useEffect(() => {
		const fromParam = parseView(searchParams.get('view'));
		if (fromParam && fromParam !== view) {
			setView(fromParam);
			window.localStorage.setItem(viewStorageKey(projectName), fromParam);
		}
	}, [searchParams, view, projectName]);

	const handleViewChange = (next: ViewMode) => {
		setView(next);
		window.localStorage.setItem(viewStorageKey(projectName), next);
		setSearchParams(params => {
			params.set('view', next);
			return params;
		}, { replace: true });
	};

	const milestoneFilter = searchParams.get('milestone') ?? '';

	return (
		<div>
			{milestoneFilter && (
				<MilestoneProgressHeader
					milestoneFilter={milestoneFilter}
					tasks={tasks}
					statuses={statuses}
					milestoneEntities={milestoneEntities}
					archivedMilestones={archivedMilestones}
				/>
			)}
			<div className="flex justify-end px-4 pt-4">
				<div className="flex rounded-md border border-gray-300 dark:border-gray-700 overflow-hidden text-sm">
				{(['list', 'board'] as const).map(mode => (
					<button
						key={mode}
						type="button"
						onClick={() => handleViewChange(mode)}
						aria-pressed={view === mode}
						className={`px-3 py-1.5 capitalize transition-colors ${
							view === mode
								? 'bg-blue-600 text-white'
								: 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
						}`}
					>
						{mode}
					</button>
				))}
				</div>
			</div>

			{view === 'board' ? (
				<BoardPage
					onEditTask={onEditTask}
					onNewTask={onNewTask}
					tasks={tasks}
					onRefreshData={onRefreshData}
					statuses={statuses}
					milestones={milestones}
					availableLabels={availableLabels}
					milestoneEntities={milestoneEntities}
					archivedMilestones={archivedMilestones}
					isLoading={isLoading}
				/>
			) : (
				<TaskList
					onEditTask={onEditTask}
					onNewTask={onNewTask}
					tasks={tasks}
					availableStatuses={statuses}
					availableLabels={availableLabels}
					availableMilestones={milestones}
					milestoneEntities={milestoneEntities}
					archivedMilestones={archivedMilestones}
					onRefreshData={onRefreshData}
				/>
			)}
		</div>
	);
}
