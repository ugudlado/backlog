import React from "react";

export interface RowContextMenuItem {
	label: string;
	onSelect: () => void;
}

interface RowContextMenuProps {
	x: number;
	y: number;
	items: RowContextMenuItem[];
	onClose: () => void;
}

/**
 * Fixed-position right-click menu for non-ordinal list rows (flat task table,
 * milestone task rows). Closes on outside click, scroll, or Escape.
 *
 * Board columns keep their own ordinal "Move to Top/Bottom" menu in TaskColumn;
 * this menu intentionally carries only actions that make sense without an
 * ordinal sort (Edit, Copy ID).
 */
const RowContextMenu: React.FC<RowContextMenuProps> = ({ x, y, items, onClose }) => {
	React.useEffect(() => {
		const close = () => onClose();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("click", close);
		document.addEventListener("scroll", close, true);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("click", close);
			document.removeEventListener("scroll", close, true);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	return (
		<div
			role="menu"
			className="fixed z-50 min-w-[160px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1 text-sm"
			style={{ top: y, left: x }}
			onClick={(e) => e.stopPropagation()}
		>
			{items.map((item) => (
				<button
					key={item.label}
					type="button"
					role="menuitem"
					onClick={() => {
						item.onSelect();
						onClose();
					}}
					className="w-full text-left px-4 py-2 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-150"
				>
					{item.label}
				</button>
			))}
		</div>
	);
};

export default RowContextMenu;
