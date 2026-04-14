"use client";

import { useRef, useState, useCallback, useId, useEffect } from "react";
import {
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "framer-motion";
import type { UITask } from "../../app/types/frontend";

/* ============================================================
   手势常量
   ============================================================ */
const SWIPE_LOCK_RATIO = 2;
const SWIPE_DEAD_ZONE = 20;
const SWIPE_THRESHOLD_RATIO = 0.4; // 右滑 40% → 完成；左滑 40% → 删除

/* ============================================================
   优先级样式映射
   ============================================================ */
const PRIORITY_CONFIG = {
  high:   { dot: "bg-red-500",   label: "高优", textColor: "text-red-600",   bgColor: "bg-red-50" },
  medium: { dot: "bg-amber-400", label: "中",   textColor: "text-amber-600", bgColor: "bg-amber-50" },
  low:    { dot: "bg-slate-300", label: "低",   textColor: "text-slate-500", bgColor: "bg-slate-50" },
} as const;

const CATEGORY_ICON: Record<string, string> = {
  work: "💼",
  life: "🏠",
  study: "📚",
};

function formatDueDate(due_date: string | null): string | null {
  if (!due_date) return null;
  const date = new Date(due_date);
  if (isNaN(date.getTime())) return null;

  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (isToday) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

/* ============================================================
   骨架屏
   ============================================================ */
function TaskCardSkeleton() {
  return (
    <div className="card-surface mx-4 mb-3 flex items-center gap-3 p-4" role="status" aria-label="AI 解析中">
      <div className="shimmer h-5 w-5 rounded-full" />
      <div className="flex-1 space-y-2">
        <div className="shimmer h-4 w-3/4 rounded" />
        <div className="shimmer h-3 w-1/3 rounded" />
      </div>
      <div className="shimmer h-6 w-12 rounded-full" />
    </div>
  );
}

/* ============================================================
   Props
   ============================================================ */
export interface TaskCardProps {
  task: UITask;
  onComplete: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  containerWidth?: number;
}

/* ============================================================
   TaskCard 主组件
   ============================================================ */
export function TaskCard({ task, onComplete, onDelete, containerWidth = 375 }: TaskCardProps) {
  const labelId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isDirectionLocked, setIsDirectionLocked] = useState(false);

  const x = useMotionValue(0);

  // 右侧：绿色完成背景
  const rightBgOpacity = useTransform(x, [0, 80], [0, 1]);
  const checkOpacity    = useTransform(x, [40, 100], [0, 1]);
  // 左侧：红色删除背景（x 为负值）
  const leftBgOpacity   = useTransform(x, [-80, 0], [1, 0]);
  const trashOpacity    = useTransform(x, [-100, -40], [1, 0]);
  // 内容透明度
  const contentOpacity  = useTransform(x, [-120, 0, 120], [0.6, 1, 0.6]);

  /*
   * triggerComplete / triggerDelete 必须在所有 early return 之前声明，
   * 否则违反 React Rules of Hooks（useCallback 在条件分支后调用导致 hook 顺序不一致）。
   */
  const triggerComplete = useCallback(() => {
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.log("[TaskCard] triggerComplete fired, taskId:", task.id, "onComplete:", typeof onComplete);
    }
    onComplete(task.id);
  }, [task.id, onComplete]);

  const triggerDelete = useCallback(() => {
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.log("[TaskCard] triggerDelete fired, taskId:", task.id);
    }
    onDelete(task.id);
  }, [task.id, onDelete]);

  /* --- 右键上下文菜单状态 --- */
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Escape 键关闭上下文菜单
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [contextMenu]);

  /* --- 骨架屏 / 已完成状态 --- */
  if (task.status === "parsing" || task.isOptimistic) return <TaskCardSkeleton />;

  if (task.status === "completed") {
    return (
      <motion.div
        className="card-surface mx-4 mb-3 flex items-center gap-3 p-4 opacity-50"
        initial={{ opacity: 1 }}
        animate={{ opacity: 0.5 }}
        transition={{ duration: 0.25 }}
        aria-label={`已完成: ${task.title}`}
      >
        <CheckCircleIcon className="h-5 w-5 flex-shrink-0 text-green-500" />
        <span className="flex-1 truncate text-sm text-slate-400 line-through">{task.title}</span>
      </motion.div>
    );
  }

  /* --- 拖拽处理 --- */
  const handleDragStart = () => { setIsDragging(true); setIsDirectionLocked(false); };

  const handleDrag = (_: unknown, info: PanInfo) => {
    const { offset } = info;
    const absX = Math.abs(offset.x);
    const absY = Math.abs(offset.y);

    if (absX < SWIPE_DEAD_ZONE && !isDirectionLocked) return;

    if (!isDirectionLocked) {
      if (absX > absY * SWIPE_LOCK_RATIO) {
        setIsDirectionLocked(true);
      } else {
        x.set(0);
        return;
      }
    }
  };

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    setIsDragging(false);
    setIsDirectionLocked(false);

    const threshold = containerWidth * SWIPE_THRESHOLD_RATIO;

    if (info.offset.x >= threshold) {
      // 右滑 → 完成
      triggerComplete();
    } else if (info.offset.x <= -threshold) {
      // 左滑 → 删除
      triggerDelete();
    } else {
      x.set(0);
    }
  };

  const priorityConfig = PRIORITY_CONFIG[task.priority];
  const categoryIcon   = CATEGORY_ICON[task.category] ?? "📌";
  const formattedDate  = formatDueDate(task.due_date);

  return (
    <div
      className="relative mx-4 mb-3 overflow-hidden rounded-xl"
      onContextMenu={(e) => {
        e.preventDefault();
        // 防止菜单溢出屏幕边缘：向左/向上偏移
        const menuWidth = 160;
        const menuHeight = 100;
        const posX = Math.min(e.clientX, window.innerWidth - menuWidth);
        const posY = Math.min(e.clientY, window.innerHeight - menuHeight);
        setContextMenu({ x: posX, y: posY });
      }}
    >
      {/* 右滑：绿色完成背景 */}
      <motion.div
        className="absolute inset-0 flex items-center gap-2 rounded-xl bg-green-500 pl-5"
        style={{ opacity: rightBgOpacity }}
        aria-hidden="true"
      >
        <motion.span className="text-xl font-bold text-white" style={{ opacity: checkOpacity }}>✓</motion.span>
        <motion.span className="text-sm font-semibold text-white" style={{ opacity: checkOpacity }}>完成</motion.span>
      </motion.div>

      {/* 左滑：红色删除背景 */}
      <motion.div
        className="absolute inset-0 flex items-center justify-end gap-2 rounded-xl bg-red-500 pr-5"
        style={{ opacity: leftBgOpacity }}
        aria-hidden="true"
      >
        <motion.span className="text-sm font-semibold text-white" style={{ opacity: trashOpacity }}>删除</motion.span>
        <motion.span className="text-xl text-white" style={{ opacity: trashOpacity }}>🗑</motion.span>
      </motion.div>

      {/* 完成按钮 — 放在 motion.div 外部，绝对定位，彻底避免 Framer Motion drag/whileTap 事件冲突 */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={triggerComplete}
        className="group absolute left-4 top-1/2 z-10 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full border-2 border-slate-300 bg-white transition-colors hover:border-green-500 hover:bg-green-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        title="标记为完成"
        aria-label={`标记"${task.title}"为已完成`}
      >
        <span className="hidden text-xs text-green-500 group-hover:block" aria-hidden="true">✓</span>
        <span className="sr-only">标记完成</span>
      </button>

      {/* 卡片主体 */}
      <motion.div
        ref={cardRef}
        className="card-surface flex items-center gap-3 p-4 pl-12"
        style={{ x, opacity: contentOpacity, touchAction: "pan-y" }}
        drag="x"
        dragConstraints={{ left: -containerWidth, right: containerWidth }}
        dragElastic={{ left: 0.15, right: 0.15 }}
        dragMomentum={false}
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        aria-labelledby={labelId}
        role="listitem"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            triggerComplete();
          }
          if (e.key === "Delete") {
            e.preventDefault();
            triggerDelete();
          }
        }}
        tabIndex={0}
        whileTap={!isDragging ? { scale: 0.98 } : undefined}
      >
        {/* 任务内容 */}
        <div className="min-w-0 flex-1">
          <p id={labelId} className="truncate text-sm font-medium text-gray-800" title={task.title}>
            {categoryIcon} {task.title}
          </p>
          {formattedDate && (
            <p className="mt-0.5 text-xs text-slate-400">
              {task.due_date && new Date(task.due_date) < new Date() ? "⚠️ 已逾期 · " : "🕐 "}
              {formattedDate}
            </p>
          )}
        </div>

        {/* 优先级标签 */}
        <span
          className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${priorityConfig.textColor} ${priorityConfig.bgColor}`}
          aria-label={`优先级: ${priorityConfig.label}`}
        >
          <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${priorityConfig.dot}`} aria-hidden="true" />
          {priorityConfig.label}
        </span>
      </motion.div>

      {/* 右键上下文菜单 */}
      {contextMenu && (
        <>
          {/* 透明遮罩层：点击或右键关闭菜单 */}
          <div
            className="fixed inset-0 z-50"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          {/* 菜单浮层 */}
          <div
            className="fixed z-50 min-w-[140px] rounded-xl bg-white py-1 shadow-xl ring-1 ring-black/5"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            role="menu"
            aria-label="任务操作菜单"
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              onClick={() => { triggerComplete(); setContextMenu(null); }}
            >
              <span aria-hidden="true">✓</span> 标记完成
            </button>
            <div className="my-1 h-px bg-gray-100" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
              onClick={() => { triggerDelete(); setContextMenu(null); }}
            >
              <span aria-hidden="true">🗑</span> 删除任务
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================
   内联 SVG 图标
   ============================================================ */
function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
    </svg>
  );
}
