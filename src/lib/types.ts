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
  remote_branches: string[];
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
  conflicted: GitFileChange[];
}

export interface ConflictFile {
  path: string;
  ours: string;
  theirs: string;
}

export interface MergeState {
  ours_label: string;
  theirs_label: string;
  files: ConflictFile[];
}

export interface MergeOpInfo {
  operation: string;
  theirs_sha?: string | null;
  current_sha?: string | null;
  current_author?: string | null;
  current_summary?: string | null;
}

export type MergeBlockKind = "unchanged" | "ours" | "theirs" | "both" | "conflict";

export interface MergeBlock {
  kind: MergeBlockKind;
  base: string[];
  ours: string[];
  theirs: string[];
}

export interface DetectedWorkspace {
  path: string;
  source: EditorSource;
}

export interface ResourceUsage {
  cpu_percent: number;
  mem_bytes: number;
}

export interface SearchOptions {
  query: string;
  case_sensitive: boolean;
  regex: boolean;
  whole_word: boolean;
  /** Root-relative folder to scope the search to (null = whole tree). */
  dir?: string | null;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  start: number;
  end: number;
}

export interface SearchResults {
  matches: SearchMatch[];
  truncated: boolean;
}

export interface ReplaceSpec {
  options: SearchOptions;
  replacement: string;
}

export interface ReplaceMatchSpec {
  path: string;
  line: number;
  options: SearchOptions;
  replacement: string;
}

export interface ReplaceSummary {
  files: number;
  replacements: number;
}

export interface RedisConnConfig {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  tls: boolean;
}

export interface RedisZItem {
  member: string;
  score: number;
}

export interface RedisKeyValue {
  kind: "string" | "list" | "set" | "hash" | "zset" | "none" | string;
  ttl: number;
  string?: string | null;
  list?: string[] | null;
  set?: string[] | null;
  hash?: [string, string][] | null;
  zset?: RedisZItem[] | null;
}
