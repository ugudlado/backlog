import React from "react";
import ThemeToggle from "./ThemeToggle";
import ProjectSwitcher from "./ProjectSwitcher";

interface NavigationProps {
	projectName: string;
	onProjectSwitched?: () => Promise<void>;
}

const Navigation: React.FC<NavigationProps> = ({projectName, onProjectSwitched}) => {
	return (
		<nav className="px-4 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-colors duration-200">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0 flex items-center gap-2">
					<h1 className="truncate text-xl font-bold text-gray-900 dark:text-gray-100">{projectName || "Loading..."}</h1>
					<span className="hidden md:inline text-sm text-gray-500 dark:text-gray-400 shrink-0">powered by</span>
					<a
						href="https://github.com/ugudlado/backlog"
						target="_blank"
						rel="noopener noreferrer"
						className="hidden md:inline text-sm text-stone-600 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300 hover:underline transition-colors duration-200 shrink-0"
					>
						Backlog.md
					</a>
				</div>
				<div className="flex items-center gap-2 sm:gap-3 shrink-0">
					<ProjectSwitcher
						onProjectSwitched={
							onProjectSwitched ??
							(async () => {
								window.location.reload();
							})
						}
					/>
					<ThemeToggle />
				</div>
			</div>
		</nav>
	);
};

export default Navigation;