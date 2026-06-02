export type ChangeStatus = "added" | "modified" | "deleted";
export type Trigger = "event" | "interval" | "manual" | "pre_revert";
export type EditorSource = "manual" | "vscode" | "zed";

export interface MonitorRow {
  id: number;
  root_path: string;
  interval_secs: number;
  source: EditorSource;
  active: boolean;
  created_at: number;
}

export interface SnapshotRow {
  id: number;
  monitor_id: number;
  ts: number;
  trigger: Trigger;
  file_count: number;
  total_size: number;
  day_bucket: string;
  label: string | null;
}

export interface FileChange {
  path: string;
  status: ChangeStatus;
}

export interface BaseInfo {
  kind: "git" | "snapshot";
  branch: string | null;
  repo_root: string | null;
  head: string | null;
}

export interface ChangeSummary {
  id: number;
  added: number;
  modified: number;
  deleted: number;
}

export interface HunkInfo {
  index: number;
  old_start: number;
  old_len: number;
  new_start: number;
  new_len: number;
}

export interface Settings {
  max_disk_gb: number;
  retention_days: number;
  snapshots_per_past_day: number;
  default_interval_secs: number;
  event_min_gap_secs: number;
  ignore_globs: string[];
  respect_gitignore: boolean;
}

export interface CommitInfo {
  id: string;
  summary: string;
  time: number;
}

export interface RefList {
  branches: string[];
  commits: CommitInfo[];
}

export interface GitFileChange {
  path: string;
  status: ChangeStatus;
}

export interface WorkingStatus {
  branch: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
}

export interface DetectedWorkspace {
  path: string;
  source: EditorSource;
}

export interface ResourceUsage {
  cpu_percent: number;
  mem_bytes: number;
}
