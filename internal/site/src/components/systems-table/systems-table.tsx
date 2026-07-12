import { Trans, useLingui } from "@lingui/react/macro"
import { useStore } from "@nanostores/react"
import { getPagePath } from "@nanostores/router"
import {
	type ColumnDef,
	type ColumnFiltersState,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type Row,
	type SortingState,
	type Table as TableType,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table"
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual"
import {
	ArrowDownIcon,
	ArrowUpDownIcon,
	ArrowUpIcon,
	ChevronDownIcon,
	EyeIcon,
	FilterIcon,
	FolderIcon,
	LayoutGridIcon,
	LayoutListIcon,
	Settings2Icon,
	XIcon,
} from "lucide-react"
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SystemStatus } from "@/lib/enums"
import { $downSystems, $pausedSystems, $systems, $upSystems } from "@/lib/stores"
import { cn, runOnce, useBrowserStorage } from "@/lib/utils"
import type { SystemRecord } from "@/types"
import AlertButton from "../alerts/alert-button"
import { $router, Link } from "../router"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { SystemsTableColumns, ActionsButton, IndicatorDot } from "./systems-table-columns"

type ViewMode = "table" | "grid"
type StatusFilter = "all" | SystemRecord["status"]

/** 分组视图的扁平列表项：组头 或 普通系统行 */
type GroupListItem<T> = { kind: "header"; group: string; total: number; up: number; down: number } | { kind: "row"; row: T }

/** 把排序过滤后的行按 group 字段分桶；没有任何分组时返回 null（走原始渲染） */
function buildGroupedItems<T extends Row<SystemRecord>>(
	rows: T[],
	collapsed: Record<string, boolean>
): GroupListItem<T>[] | null {
	const groups = new Map<string, T[]>()
	let hasGroup = false
	for (const row of rows) {
		const group = row.original.group || ""
		if (group) {
			hasGroup = true
		}
		const list = groups.get(group)
		if (list) {
			list.push(row)
		} else {
			groups.set(group, [row])
		}
	}
	if (!hasGroup) {
		return null
	}
	// 有名字的组按字母序，未分组排最后
	const names = [...groups.keys()].sort((a, b) => {
		if (a === "") return 1
		if (b === "") return -1
		return a.localeCompare(b)
	})
	const items: GroupListItem<T>[] = []
	for (const name of names) {
		const groupRows = groups.get(name)!
		let up = 0
		let down = 0
		for (const row of groupRows) {
			if (row.original.status === SystemStatus.Up) up++
			else if (row.original.status === SystemStatus.Down) down++
		}
		items.push({ kind: "header", group: name, total: groupRows.length, up, down })
		if (!collapsed[name || "__ungrouped__"]) {
			for (const row of groupRows) {
				items.push({ kind: "row", row })
			}
		}
	}
	return items
}

/** 组头：文件夹名 + 简要统计（在线/总数、离线数），点击折叠 */
function GroupHeaderContent({
	item,
	collapsed,
	onToggle,
}: {
	item: { group: string; total: number; up: number; down: number }
	collapsed: boolean
	onToggle: () => void
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="flex items-center gap-2 w-full text-start font-medium text-sm py-2 select-none"
		>
			<ChevronDownIcon className={cn("size-4 text-muted-foreground transition-transform", collapsed && "-rotate-90")} />
			<FolderIcon className="size-4 text-muted-foreground" />
			<span className="truncate">{item.group || <Trans>Ungrouped</Trans>}</span>
			<span className="text-muted-foreground text-xs tabular-nums ms-1">
				{item.up}/{item.total} <Trans>Up</Trans>
			</span>
			{item.down > 0 && (
				<span className="text-red-500 text-xs tabular-nums">
					{item.down} <Trans>Down</Trans>
				</span>
			)}
		</button>
	)
}


const preloadSystemDetail = runOnce(() => import("@/components/routes/system.tsx"))

export default function SystemsTable() {
	const data = useStore($systems)
	const downSystems = $downSystems.get()
	const upSystems = $upSystems.get()
	const pausedSystems = $pausedSystems.get()
	const { i18n, t } = useLingui()
	const [filter, setFilter] = useState<string>("")
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
	const [sorting, setSorting] = useBrowserStorage<SortingState>(
		"sortMode",
		[{ id: "system", desc: false }],
		sessionStorage
	)
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
	const [columnVisibility, setColumnVisibility] = useBrowserStorage<VisibilityState>("cols", {})

	const locale = i18n.locale

	// Filter data based on status filter
	const filteredData = useMemo(() => {
		if (statusFilter === "all") {
			return data
		}
		if (statusFilter === SystemStatus.Up) {
			return Object.values(upSystems) ?? []
		}
		if (statusFilter === SystemStatus.Down) {
			return Object.values(downSystems) ?? []
		}
		return Object.values(pausedSystems) ?? []
	}, [data, statusFilter])

	const [viewMode, setViewMode] = useBrowserStorage<ViewMode>(
		"viewMode",
		// show grid view on mobile if there are less than 200 systems (looks better but table is more efficient)
		window.innerWidth < 1024 && filteredData.length < 200 ? "grid" : "table"
	)

	useEffect(() => {
		if (filter !== undefined) {
			table.getColumn("system")?.setFilterValue(filter)
		}
	}, [filter])

	const columnDefs = useMemo(() => SystemsTableColumns(viewMode), [viewMode])

	const table = useReactTable({
		data: filteredData,
		columns: columnDefs,
		getCoreRowModel: getCoreRowModel(),
		onSortingChange: setSorting,
		getSortedRowModel: getSortedRowModel(),
		onColumnFiltersChange: setColumnFilters,
		getFilteredRowModel: getFilteredRowModel(),
		onColumnVisibilityChange: setColumnVisibility,
		state: {
			sorting,
			columnFilters,
			columnVisibility,
		},
		defaultColumn: {
			invertSorting: true,
			sortUndefined: "last",
			minSize: 0,
			size: 900,
			maxSize: 900,
		},
	})

	const rows = table.getRowModel().rows
	const columns = table.getAllColumns()
	const visibleColumns = table.getVisibleLeafColumns()

	// 分组折叠状态（跨会话保存）
	const [groupCollapsed, setGroupCollapsed] = useBrowserStorage<Record<string, boolean>>("groupsCollapsed", {})
	const toggleGroup = (name: string) => {
		const key = name || "__ungrouped__"
		setGroupCollapsed({ ...groupCollapsed, [key]: !groupCollapsed[key] })
	}
	const groupedItems = useMemo(() => buildGroupedItems(rows, groupCollapsed), [rows, groupCollapsed])

	const [upSystemsLength, downSystemsLength, pausedSystemsLength] = useMemo(() => {
		return [Object.values(upSystems).length, Object.values(downSystems).length, Object.values(pausedSystems).length]
	}, [upSystems, downSystems, pausedSystems])

	const CardHead = useMemo(() => {
		return (
			<CardHeader className="p-0 mb-3 sm:mb-4">
				<div className="grid md:flex gap-x-5 gap-y-3 w-full items-end">
					<div className="px-2 sm:px-1">
						<CardTitle className="mb-2">
							<Trans>All Systems</Trans>
						</CardTitle>
						<CardDescription className="flex">
							<Trans>Click on a system to view more information.</Trans>
						</CardDescription>
					</div>

					<div className="flex gap-2 ms-auto w-full md:w-80">
						<div className="relative flex-1">
							<Input
								placeholder={t`Filter...`}
								onChange={(e) => setFilter(e.target.value)}
								value={filter}
								className="ps-4 pe-10 w-full"
							/>
							{filter && (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={t`Clear`}
									className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground"
									onClick={() => setFilter("")}
								>
									<XIcon className="h-4 w-4" />
								</Button>
							)}
						</div>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline">
									<Settings2Icon className="me-1.5 size-4 opacity-80" />
									<Trans>View</Trans>
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="h-72 md:h-auto min-w-48 md:min-w-auto overflow-y-auto">
								<div className="grid grid-cols-1 md:grid-cols-4 divide-y md:divide-s md:divide-y-0">
									<div className="border-r">
										<DropdownMenuLabel className="pt-2 px-3.5 flex items-center gap-2">
											<LayoutGridIcon className="size-4" />
											<Trans>Layout</Trans>
										</DropdownMenuLabel>
										<DropdownMenuSeparator />
										<DropdownMenuRadioGroup
											className="px-1 pb-1"
											value={viewMode}
											onValueChange={(view) => setViewMode(view as ViewMode)}
										>
											<DropdownMenuRadioItem value="table" onSelect={(e) => e.preventDefault()} className="gap-2">
												<LayoutListIcon className="size-4" />
												<Trans>Table</Trans>
											</DropdownMenuRadioItem>
											<DropdownMenuRadioItem value="grid" onSelect={(e) => e.preventDefault()} className="gap-2">
												<LayoutGridIcon className="size-4" />
												<Trans>Grid</Trans>
											</DropdownMenuRadioItem>
										</DropdownMenuRadioGroup>
									</div>

									<div className="border-r">
										<DropdownMenuLabel className="pt-2 px-3.5 flex items-center gap-2">
											<FilterIcon className="size-4" />
											<Trans>Status</Trans>
										</DropdownMenuLabel>
										<DropdownMenuSeparator />
										<DropdownMenuRadioGroup
											className="px-1 pb-1"
											value={statusFilter}
											onValueChange={(value) => setStatusFilter(value as StatusFilter)}
										>
											<DropdownMenuRadioItem value="all" onSelect={(e) => e.preventDefault()}>
												<Trans>All Systems</Trans>
											</DropdownMenuRadioItem>
											<DropdownMenuRadioItem value="up" onSelect={(e) => e.preventDefault()}>
												<Trans>Up ({upSystemsLength})</Trans>
											</DropdownMenuRadioItem>
											<DropdownMenuRadioItem value="down" onSelect={(e) => e.preventDefault()}>
												<Trans>Down ({downSystemsLength})</Trans>
											</DropdownMenuRadioItem>
											<DropdownMenuRadioItem value="paused" onSelect={(e) => e.preventDefault()}>
												<Trans>Paused ({pausedSystemsLength})</Trans>
											</DropdownMenuRadioItem>
										</DropdownMenuRadioGroup>
									</div>

									<div className="border-r">
										<DropdownMenuLabel className="pt-2 px-3.5 flex items-center gap-2">
											<ArrowUpDownIcon className="size-4" />
											<Trans>Sort By</Trans>
										</DropdownMenuLabel>
										<DropdownMenuSeparator />
										<div className="px-1 pb-1">
											{columns.map((column) => {
												if (!column.getCanSort()) return null
												let Icon = <span className="w-6"></span>
												// if current sort column, show sort direction
												if (sorting[0]?.id === column.id) {
													if (sorting[0]?.desc) {
														Icon = <ArrowUpIcon className="me-2 size-4" />
													} else {
														Icon = <ArrowDownIcon className="me-2 size-4" />
													}
												}
												return (
													<DropdownMenuItem
														onSelect={(e) => {
															e.preventDefault()
															setSorting([{ id: column.id, desc: sorting[0]?.id === column.id && !sorting[0]?.desc }])
														}}
														key={column.id}
													>
														{Icon}
														{/* @ts-ignore */}
														{column.columnDef.name()}
													</DropdownMenuItem>
												)
											})}
										</div>
									</div>

									<div>
										<DropdownMenuLabel className="pt-2 px-3.5 flex items-center gap-2">
											<EyeIcon className="size-4" />
											<Trans>Visible Fields</Trans>
										</DropdownMenuLabel>
										<DropdownMenuSeparator />
										<div className="px-1.5 pb-1">
											{columns
												.filter((column) => column.getCanHide())
												.map((column) => {
													return (
														<DropdownMenuCheckboxItem
															key={column.id}
															onSelect={(e) => e.preventDefault()}
															checked={column.getIsVisible()}
															onCheckedChange={(value) => column.toggleVisibility(!!value)}
														>
															{/* @ts-ignore */}
															{column.columnDef.name()}
														</DropdownMenuCheckboxItem>
													)
												})}
										</div>
									</div>
								</div>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</CardHeader>
		)
	}, [
		visibleColumns.length,
		sorting,
		viewMode,
		locale,
		statusFilter,
		upSystemsLength,
		downSystemsLength,
		pausedSystemsLength,
		filter,
	])

	return (
		<Card className="w-full px-3 py-5 sm:py-6 sm:px-6">
			{CardHead}
			{viewMode === "table" ? (
				// table layout
				<div className="rounded-md">
					<AllSystemsTable
						table={table}
						rows={rows}
						colLength={visibleColumns.length}
						groupedItems={groupedItems}
						groupCollapsed={groupCollapsed}
						toggleGroup={toggleGroup}
					/>
				</div>
			) : groupedItems ? (
				// grid layout, grouped into folder sections
				<div className="flex flex-col gap-1">
					{(() => {
						const sections: ReactNode[] = []
						let currentHeader: Extract<GroupListItem<Row<SystemRecord>>, { kind: "header" }> | null = null
						let currentRows: Row<SystemRecord>[] = []
						const flush = () => {
							if (!currentHeader) return
							const header = currentHeader
							sections.push(
								<div key={`sec-${header.group}`} className="mb-2">
									<GroupHeaderContent
										item={header}
										collapsed={!!groupCollapsed[header.group || "__ungrouped__"]}
										onToggle={() => toggleGroup(header.group)}
									/>
									{currentRows.length > 0 && (
										<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 mt-1">
											{currentRows.map((row) => (
												<SystemCard key={row.original.id} row={row} table={table} colLength={visibleColumns.length} />
											))}
										</div>
									)}
								</div>
							)
							currentRows = []
						}
						for (const item of groupedItems) {
							if (item.kind === "header") {
								flush()
								currentHeader = item
							} else {
								currentRows.push(item.row)
							}
						}
						flush()
						return sections
					})()}
				</div>
			) : (
				// grid layout
				<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
					{rows?.length ? (
						rows.map((row) => {
							return <SystemCard key={row.original.id} row={row} table={table} colLength={visibleColumns.length} />
						})
					) : (
						<div className="col-span-full text-center py-8">
							<Trans>No systems found.</Trans>
						</div>
					)}
				</div>
			)}
		</Card>
	)
}

const AllSystemsTable = memo(
	({
		table,
		rows,
		colLength,
		groupedItems,
		groupCollapsed,
		toggleGroup,
	}: {
		table: TableType<SystemRecord>
		rows: Row<SystemRecord>[]
		colLength: number
		groupedItems: GroupListItem<Row<SystemRecord>>[] | null
		groupCollapsed: Record<string, boolean>
		toggleGroup: (name: string) => void
	}) => {
		// The virtualizer will need a reference to the scrollable container element
		const scrollRef = useRef<HTMLDivElement>(null)

		// 分组时对"组头+行"的扁平列表做虚拟化，未分组时保持原始行为
		const items: GroupListItem<Row<SystemRecord>>[] = groupedItems ?? rows.map((row) => ({ kind: "row", row }))

		const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
			count: items.length,
			estimateSize: (index) => (items[index]?.kind === "header" ? 44 : items.length > 10 ? 56 : 60),
			getScrollElement: () => scrollRef.current,
			overscan: 5,
		})
		const virtualRows = virtualizer.getVirtualItems()

		const paddingTop = Math.max(0, virtualRows[0]?.start ?? 0 - virtualizer.options.scrollMargin)
		const paddingBottom = Math.max(0, virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0))

		return (
			<div
				className={cn(
					"h-min max-h-[calc(100dvh-17rem)] max-w-full relative overflow-auto border rounded-md",
					// don't set min height if there are less than 2 rows, do set if we need to display the empty state
					(!items.length || items.length > 2) && "min-h-50"
				)}
				ref={scrollRef}
			>
				{/* add header height to table size */}
				<div style={{ height: `${virtualizer.getTotalSize() + 50}px`, paddingTop, paddingBottom }}>
					<table className="text-sm w-full h-full">
						<SystemsTableHead table={table} />
						<TableBody onMouseEnter={preloadSystemDetail}>
							{items.length ? (
								virtualRows.map((virtualRow) => {
									const item = items[virtualRow.index]
									if (item.kind === "header") {
										return (
											<TableRow key={`h-${item.group}`} className="bg-muted/40 hover:bg-muted/60">
												<TableCell colSpan={colLength} className="py-0 px-3" style={{ height: virtualRow.size }}>
													<GroupHeaderContent
														item={item}
														collapsed={!!groupCollapsed[item.group || "__ungrouped__"]}
														onToggle={() => toggleGroup(item.group)}
													/>
												</TableCell>
											</TableRow>
										)
									}
									const row = item.row
									return (
										<SystemTableRow
											key={row.id}
											row={row}
											virtualRow={virtualRow}
											length={items.length}
											colLength={colLength}
										/>
									)
								})
							) : (
								<TableRow>
									<TableCell colSpan={colLength} className="h-37 text-center pointer-events-none">
										<Trans>No systems found.</Trans>
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</table>
				</div>
			</div>
		)
	}
)

function SystemsTableHead({ table }: { table: TableType<SystemRecord> }) {
	const { t } = useLingui()
	return (
		<TableHeader className="sticky top-0 z-50 w-full border-b-2">
			{table.getHeaderGroups().map((headerGroup) => (
				<tr key={headerGroup.id}>
					{headerGroup.headers.map((header) => {
						return (
							<TableHead className="px-1.5" key={header.id}>
								{flexRender(header.column.columnDef.header, header.getContext())}
							</TableHead>
						)
					})}
				</tr>
			))}
		</TableHeader>
	)
}

const SystemTableRow = memo(
	({
		row,
		virtualRow,
		colLength,
	}: {
		row: Row<SystemRecord>
		virtualRow: VirtualItem
		length: number
		colLength: number
	}) => {
		const system = row.original
		const { t } = useLingui()
		return useMemo(() => {
			return (
				<TableRow
					// data-state={row.getIsSelected() && "selected"}
					className={cn("cursor-pointer transition-opacity relative safari:transform-3d", {
						"opacity-50": system.status === SystemStatus.Paused,
					})}
				>
					{row.getVisibleCells().map((cell) => (
						<TableCell
							key={cell.id}
							style={{
								width: cell.column.getSize(),
								height: virtualRow.size,
							}}
							className="py-0 ps-4.5"
						>
							{flexRender(cell.column.columnDef.cell, cell.getContext())}
						</TableCell>
					))}
				</TableRow>
			)
		}, [system, system.status, colLength, t])
	}
)

const SystemCard = memo(
	({ row, table, colLength }: { row: Row<SystemRecord>; table: TableType<SystemRecord>; colLength: number }) => {
		const system = row.original
		const { t } = useLingui()

		return useMemo(() => {
			return (
				<Card
					onMouseEnter={preloadSystemDetail}
					key={system.id}
					className={cn(
						"cursor-pointer hover:shadow-md transition-all bg-transparent w-full dark:border-border duration-200 relative",
						{
							"opacity-50": system.status === SystemStatus.Paused,
						}
					)}
				>
					<CardHeader className="py-1 ps-4 pe-2 bg-muted/30 border-b border-border/60">
						<div className="flex items-center gap-1 w-full overflow-hidden">
							<h3 className="text-primary/90 min-w-0 flex-1 gap-2.5 font-semibold">
								<div className="flex items-center gap-2.5 min-w-0 flex-1">
									<IndicatorDot system={system} />
									<span className="text-[.95em]/normal tracking-normal text-primary/90 truncate">{system.name}</span>
								</div>
							</h3>
							{table.getColumn("actions")?.getIsVisible() && (
								<div className="flex gap-1 shrink-0 relative z-10">
									<AlertButton system={system} />
									<ActionsButton system={system} />
								</div>
							)}
						</div>
					</CardHeader>
					<CardContent className="text-sm px-5 pt-3.5 pb-4">
						<div className="grid gap-2.5" style={{ gridTemplateColumns: "24px minmax(80px, max-content) 1fr" }}>
							{table.getAllColumns().map((column) => {
								if (!column.getIsVisible() || column.id === "system" || column.id === "actions") return null
								const cell = row.getAllCells().find((cell) => cell.column.id === column.id)
								if (!cell) return null
								// @ts-expect-error
								const { Icon, name } = column.columnDef as ColumnDef<SystemRecord, unknown>
								return (
									<>
										<div key={`${column.id}-icon`} className="flex items-center">
											{column.id === "lastSeen" ? (
												<EyeIcon className="size-4 text-muted-foreground" />
											) : (
												Icon && <Icon className="size-4 text-muted-foreground" />
											)}
										</div>
										<div key={`${column.id}-label`} className="flex items-center text-muted-foreground pr-3">
											{name()}:
										</div>
										<div key={`${column.id}-value`} className="flex items-center">
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</div>
									</>
								)
							})}
						</div>
					</CardContent>
					<Link
						href={getPagePath($router, "system", { id: row.original.id })}
						className="inset-0 absolute w-full h-full"
					>
						<span className="sr-only">{row.original.name}</span>
					</Link>
				</Card>
			)
		}, [system, colLength, t])
	}
)
