/* ============================================================
   Simple Todo AI — 前端专用类型定义
   ============================================================ */

import type { TaskPriority, TaskCategory } from "../../types/index";

export type { TaskPriority, TaskCategory };

export type TaskStatus = "pending" | "completed" | "parsing";

/* Task — 反映后端 API 实际返回的字段 */
export interface Task {
  id: string;
  title: string;
  due_date: string | null;       // ISO 8601，如 "2026-04-09T14:00:00Z"
  priority: TaskPriority;
  category: TaskCategory;
  is_completed: boolean;         // 后端字段，UI 层派生 status
  sort_order: number;
  created_at: string;
}

/* POST /api/tasks/parse 中的 parsed 字段 */
export interface ParsedTask {
  title: string;
  due_date: string | null;
  priority: TaskPriority;
  category: TaskCategory;
}

/* POST /api/tasks/parse 完整响应 */
export interface ParseResponse {
  request_id: string;
  parsed: ParsedTask;
  raw_input: string;
  usage: {
    used_today: number | null;
    limit_today: number | null;
    remaining_today: number | null;
    plan: string;
  };
}

/* POST /api/tasks/confirm 请求体 */
export interface ConfirmTaskRequest {
  request_id: string;
  task: {
    title: string;
    due_date?: string | null;
    priority: TaskPriority;
    category: TaskCategory;
    raw_input?: string;
  };
}

/* GET /api/tasks/week 响应 */
export interface WeekTasksResponse {
  tasks: Task[];
  week_start: string;
  week_end: string;
}

/* AI 使用量 */
export interface UsageInfo {
  used_today: number | null;
  limit_today: number | null;
  remaining_today: number | null;
  plan: string;
}

/* GET /api/users/me 响应 */
export interface UserMeResponse {
  user: {
    id: string;
    email: string | null;
    tier: string;
    created_at: string;
  };
  usage: UsageInfo;
}

/* GET /api/tasks/today 响应 */
export interface TodayTasksResponse {
  tasks: Task[];
  total: number;
  completed: number;
  date: string;
}

/* PATCH /api/tasks/:id/complete 响应 */
export interface CompleteTaskResponse {
  task: {
    id: string;
    is_completed: boolean;
    completed_at: string | null;
  };
}

/* 成就卡片数据（供 AchievementCard 组件使用，后端暂不返回） */
export interface AchievementData {
  type: "single" | "all_done";
  message: string;
  completed_count: number;
}

/* UI 专用 — 带乐观更新状态和派生 status 的任务 */
export interface UITask extends Task {
  status: TaskStatus;   // 派生字段：由 is_completed + 乐观状态计算，不来自 API
  isOptimistic?: boolean;
}

/* InputPanel 展开状态 */
export type InputPanelState = "closed" | "input" | "parsing" | "result";

/* 新手引导步骤 */
export type OnboardingStep =
  | "idle"
  | "highlight_input"
  | "highlight_swipe"
  | "complete";
