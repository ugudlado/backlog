import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { NavLink } from 'react-router-dom';
import { Tooltip } from 'react-tooltip';
import {
	type SearchResult,
	type SearchResultType,
	type Task,
	type TaskSearchResult,
} from '../../types';
import ErrorBoundary from './ErrorBoundary';
import { SidebarSkeleton } from './LoadingSpinner';
import { getWebVersion } from '../utils/version';
import { apiClient } from '../lib/api';
import { parseSearchCommandQuery } from '../utils/search-command-query';

const hasTaskSearchFilters = (parsedQuery: ReturnType<typeof parseSearchCommandQuery>): boolean => {
	return Boolean(
		parsedQuery.status ||
			parsedQuery.priority ||
			parsedQuery.assignee ||
			(parsedQuery.labels && parsedQuery.labels.length > 0) ||
			(parsedQuery.modifiedFiles && parsedQuery.modifiedFiles.length > 0),
	);
};

// Icon components for better semantics and performance
const Icons = {
	Tasks: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
		</svg>
	),
	Board: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
		</svg>
	),
	List: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
		</svg>
	),
	Search: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
		</svg>
	),
	ChevronLeft: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
		</svg>
	),
	ChevronRight: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
		</svg>
	),
	Statistics: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
		</svg>
	),
	Milestone: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<circle cx="12" cy="12" r="9" strokeWidth={2} />
			<circle cx="12" cy="12" r="5" strokeWidth={2} />
			<circle cx="12" cy="12" r="1" strokeWidth={2} />
		</svg>
	),
	DocumentSettings: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
		</svg>
	),
};

interface SideNavigationProps {
	tasks: Task[];
	isLoading: boolean;
	error?: Error | null;
	onRetry?: () => void;
	onRefreshData: () => Promise<void>;
}

const SideNavigation = memo(function SideNavigation({
	tasks,
	isLoading,
	error,
	onRetry
}: SideNavigationProps) {
	const [isCollapsed, setIsCollapsed] = useState(() => {
		const saved = localStorage.getItem('sideNavCollapsed');
		return saved ? JSON.parse(saved) : false;
	});
	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [searchInputRef, setSearchInputRef] = useState<HTMLInputElement | null>(null);
	const [version, setVersion] = useState<string>('');

	useEffect(() => {
		localStorage.setItem('sideNavCollapsed', JSON.stringify(isCollapsed));
	}, [isCollapsed]);

	// Fetch version on mount
	useEffect(() => {
		getWebVersion().then(setVersion).catch(() => setVersion(''));
	}, []);

	// Add keyboard shortcut for search
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault();
				if (isCollapsed) {
					setIsCollapsed(false);
				} else if (searchInputRef) {
					searchInputRef.focus();
				}
			}
		};

		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [searchInputRef, isCollapsed]);

	// Auto-focus search input when sidebar expands
	useEffect(() => {
		if (!isCollapsed && searchInputRef) {
			const timer = setTimeout(() => {
				searchInputRef.focus();
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [isCollapsed, searchInputRef]);

	// Perform unified search via centralized API (debounced)
	useEffect(() => {
		const query = searchQuery.trim();
		if (query === '') {
			setSearchResults([]);
			setSearchError(null);
			setIsSearching(false);
			return;
		}

		let cancelled = false;
		setIsSearching(true);
		setSearchError(null);
		const timeout = setTimeout(async () => {
			try {
				const parsedQuery = parseSearchCommandQuery(query);
				const types: SearchResultType[] | undefined =
					parsedQuery.types ?? (hasTaskSearchFilters(parsedQuery) ? ['task'] : undefined);
				const results = await apiClient.search({ ...parsedQuery, types, limit: 15 });
				if (!cancelled) {
					setSearchResults(results);
				}
			} catch (err) {
				console.error('Sidebar search failed:', err);
				if (!cancelled) {
					setSearchResults([]);
					setSearchError('Search failed');
				}
			} finally {
				if (!cancelled) {
					setIsSearching(false);
				}
			}
		}, 200);

		return () => {
			cancelled = true;
			clearTimeout(timeout);
		};
	}, [searchQuery]);

	const unifiedSearchResults = useMemo(() => {
		if (!searchQuery.trim()) {
			return [];
		}
		const filtered = searchResults
			.filter((result) => result.score === null || result.score <= 0.45)
			.sort((a, b) => {
				const scoreA = a.score ?? Number.POSITIVE_INFINITY;
				const scoreB = b.score ?? Number.POSITIVE_INFINITY;
				return scoreA - scoreB;
			});

		return filtered.slice(0, 5);
	}, [searchQuery, searchResults]);

	const toggleCollapse = useCallback(() => {
		setIsCollapsed((prev: any) => !prev);
	}, []);

	return (
		<ErrorBoundary>
			<div className={`relative bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 transition-all duration-300 flex flex-col min-h-full z-10 ${isCollapsed ? 'w-16' : 'w-80 min-w-80'}`}>
			{/* Search Bar */}
			<div className={`${isCollapsed ? 'px-2' : 'px-4'} border-b border-gray-200 dark:border-gray-700 h-18 flex items-center relative`}>
				{/* Collapse Toggle Button - Always positioned on the border */}
				<button
					onClick={toggleCollapse}
					className="absolute -right-3 top-1/2 transform -translate-y-1/2 z-10 flex items-center justify-center w-6 h-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-circle shadow-sm hover:shadow-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-all duration-200"
					aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
					title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				>
					{isCollapsed ? <Icons.ChevronRight /> : <Icons.ChevronLeft />}
				</button>

				{!isCollapsed ? (
					<div className="flex items-center w-full">
						<div className="relative flex-1">
							<div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400 dark:text-gray-500">
								<Icons.Search />
							</div>
							<input
								ref={setSearchInputRef}
								type="text"
								placeholder="Search (⌘K)..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="w-full pl-10 pr-8 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-stone-500 dark:focus:ring-stone-400 focus:border-transparent transition-colors duration-200"
							/>
								{searchQuery && (
									<button
										onClick={() => setSearchQuery('')}
										className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors duration-200"
									>
										<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							)}
						</div>
					</div>
				) : (
						<div className="flex items-center justify-center">
							<button
								onClick={() => setIsCollapsed(false)}
								className="flex items-center justify-center p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors duration-200"
								title="Search (⌘K)"
							>
								<Icons.Search />
						</button>
					</div>
				)}
			</div>

			{/* Unified Search Results */}
			{!isCollapsed && searchQuery.trim() && unifiedSearchResults.length > 0 && (
				<div className="p-4 border-b border-gray-200 dark:border-gray-700">
					<div className="flex items-center justify-between mb-3">
						<h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Search Results</h3>
						{isSearching && (
							<span className="text-xs text-gray-500 dark:text-gray-400">Searching…</span>
						)}
					</div>
					<div className="space-y-1">
						{unifiedSearchResults.map((result, index) => {
							const item = (result as TaskSearchResult).task;
							const getResultLink = () => `/?highlight=${encodeURIComponent(item.id)}`;

							return (
								<NavLink
									key={`${result.type}-${item.id}-${index}`}
									to={getResultLink()}
									className="flex items-center space-x-3 px-3 py-2 text-sm rounded-lg transition-colors duration-200 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100"
								>
									<span className="text-purple-500"><Icons.Tasks /></span>
									<div className="flex-1 min-w-0">
										<div className="font-medium truncate">
											{item.title}
										</div>
										<div className="text-xs text-gray-500 dark:text-gray-400 truncate">
											Task • {item.id}
										</div>
									</div>
									{result.score !== null && (
										<div className="text-xs text-gray-400 dark:text-gray-500">
											{`${Math.round((1 - result.score) * 100)}%`}
										</div>
									)}
								</NavLink>
							);
						})}
					</div>
				</div>
			)}

			{!isCollapsed && searchQuery.trim() && unifiedSearchResults.length === 0 && !isSearching && !searchError && (
				<div className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
					No matching results
				</div>
			)}

			{!isCollapsed && searchQuery.trim() && searchError && (
				<div className="px-4 py-2 text-sm text-red-600 dark:text-red-400 border-b border-gray-200 dark:border-gray-700">
					{searchError}
				</div>
			)}


			<nav className="flex-1 overflow-y-auto">
				{/* Loading Indicator - only show when expanded since collapsed nav is static */}
				{isLoading && !isCollapsed && (
					<SidebarSkeleton isCollapsed={false} />
				)}

				{/* Error State */}
				{error && !isLoading && !isCollapsed && (
					<div className="px-4 py-4">
						<div className="text-center p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
							<p className="text-sm text-red-700 dark:text-red-400 mb-2">Failed to load navigation</p>
								{onRetry && (
									<button
										onClick={onRetry}
										className="text-xs px-3 py-1 bg-red-600 dark:bg-red-700 text-white rounded hover:bg-red-700 dark:hover:bg-red-600 transition-colors duration-200"
									>
										Retry
									</button>
							)}
						</div>
					</div>
				)}

				{/* Tasks Section - Hidden in collapsed state and when loading */}
				{!isCollapsed && !isLoading && (
					<div className="px-4 py-4">
						<div className="flex items-center space-x-3 text-gray-700 dark:text-gray-300">
							<span className="text-gray-500 dark:text-gray-400"><Icons.Tasks /></span>
							<span className="text-sm font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 whitespace-nowrap">Tasks ({tasks.length})</span>
						</div>
					</div>
				)}

				{/* Navigation items only show when expanded and not loading */}
				{!isCollapsed && !isLoading && (
					<div className="px-4 space-y-1">
						{/* Board Navigation */}
						<NavLink
							to="/"
							className={({ isActive }) =>
								`flex items-center px-3 py-2 rounded-lg transition-colors duration-200 ${
									isActive
										? 'bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 font-medium'
										: 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
								}`
							}
						>
							<Icons.Board />
							<span className="ml-3 text-sm font-medium">Kanban Board</span>
						</NavLink>

						{/* Tasks Navigation */}
						<NavLink
							to="/tasks"
							className={({ isActive }) =>
								`flex items-center px-3 py-2 rounded-lg transition-colors duration-200 ${
									isActive
										? 'bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 font-medium'
										: 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
								}`
							}
						>
							<Icons.List />
							<span className="ml-3 text-sm font-medium">All Tasks</span>
						</NavLink>

						{/* Milestones Navigation */}
						<NavLink
							to="/milestones"
							className={({ isActive }) =>
								`flex items-center px-3 py-2 rounded-lg transition-colors duration-200 ${
									isActive
										? 'bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 font-medium'
										: 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
								}`
							}
						>
							<Icons.Milestone />
							<span className="ml-3 text-sm font-medium">Milestones</span>
						</NavLink>

						{/* Statistics Navigation */}
						<NavLink
							to="/statistics"
							className={({ isActive }) =>
								`flex items-center px-3 py-2 rounded-lg transition-colors duration-200 ${
									isActive
										? 'bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 font-medium'
										: 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
								}`
							}
						>
							<Icons.Statistics />
							<span className="ml-3 text-sm font-medium">Statistics</span>
						</NavLink>
					</div>
				)}

				{isCollapsed && (
					<div className="px-2 py-2 space-y-2">
						<NavLink
							to="/"
							data-tooltip-id="sidebar-tooltip"
							data-tooltip-content="Kanban Board"
							className={({ isActive }) =>
								`flex items-center justify-center p-3 rounded-md transition-colors duration-200 ${
									isActive
										? 'bg-blue-50 dark:bg-blue-600/20 text-blue-700 dark:text-blue-400'
										: 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
								}`
							}
						>
							<div className="w-6 h-6 flex items-center justify-center">
								<Icons.Board />
							</div>
						</NavLink>
						<NavLink
							to="/tasks"
							data-tooltip-id="sidebar-tooltip"
							data-tooltip-content="All Tasks"
							className={({ isActive }) =>
								`flex items-center justify-center p-3 rounded-md transition-colors duration-200 ${
									isActive
										? 'bg-blue-50 dark:bg-blue-600/20 text-blue-700 dark:text-blue-400'
										: 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
								}`
							}
						>
							<div className="w-6 h-6 flex items-center justify-center">
								<Icons.List />
							</div>
						</NavLink>
						{/* Milestones Navigation */}
						<NavLink
							to="/milestones"
							data-tooltip-id="sidebar-tooltip"
							data-tooltip-content="Milestones"
							className={({ isActive }) =>
								`flex items-center justify-center p-3 rounded-md transition-colors duration-200 ${
									isActive
										? 'bg-blue-50 dark:bg-blue-600/20 text-blue-700 dark:text-blue-400'
										: 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
								}`
							}
						>
							<div className="w-6 h-6 flex items-center justify-center">
								<Icons.Milestone />
							</div>
						</NavLink>
						{/* Statistics Navigation */}
						<NavLink
							to="/statistics"
							data-tooltip-id="sidebar-tooltip"
							data-tooltip-content="Statistics"
							className={({ isActive }) =>
								`flex items-center justify-center p-3 rounded-md transition-colors duration-200 ${
									isActive
										? 'bg-blue-50 dark:bg-blue-600/20 text-blue-700 dark:text-blue-400'
										: 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
								}`
							}
						>
							<div className="w-6 h-6 flex items-center justify-center">
								<Icons.Statistics />
							</div>
						</NavLink>
					</div>
				)}
			</nav>

			{/* Settings Button - Bottom Left */}
			<div className={`border-t border-gray-200 dark:border-gray-700 ${isCollapsed ? 'px-2 py-2' : 'px-4 py-4'}`}>
				{!isCollapsed ? (
					<NavLink
						to="/settings"
						className={({ isActive }) =>
							`flex items-center px-3 py-2 rounded-lg transition-colors duration-200 ${
								isActive
									? 'bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 font-medium'
									: 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
							}`
						}
					>
						<Icons.DocumentSettings />
						<span className="ml-3 text-sm font-medium">Settings</span>
						{version && (
							<span className="ml-auto text-xs text-gray-500 dark:text-gray-400">Backlog.md - v{version}</span>
						)}
					</NavLink>
				) : (
					<NavLink
						to="/settings"
						data-tooltip-id="sidebar-tooltip"
						data-tooltip-content="Settings"
						className={({ isActive }) =>
							`flex items-center justify-center p-3 rounded-md transition-colors duration-200 ${
								isActive
									? 'bg-stone-50 dark:bg-stone-900/30 text-stone-700 dark:text-stone-400'
									: 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
							}`
						}
					>
						<div className="w-6 h-6 flex items-center justify-center">
							<Icons.DocumentSettings />
						</div>
					</NavLink>
				)}
			</div>

			<Tooltip id="sidebar-tooltip" place="right" />
			</div>
		</ErrorBoundary>
	);
});

export default SideNavigation;
