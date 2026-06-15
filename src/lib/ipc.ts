import { invoke } from "@tauri-apps/api/core";
import type {
  BaseInfo,
  ChangeSummary,
  FileChange,
  GitFileChange,
  HunkInfo,
  MonitorRow,
  RefList,
  ReplaceMatchSpec,
  ReplaceSpec,
  ReplaceSummary,
  ResourceUsage,
  SearchOptions,
  SearchResults,
  Settings,
  SnapshotRow,
  WorkingStatus,
} from "./types";

export const WORKDIR = "WORKDIR";

export const api = {
  addMonitor: (path: string, intervalSecs: number) =>
    invoke<number>("add_monitor", { path, intervalSecs }),
  listMonitors: () => invoke<MonitorRow[]>("list_monitors"),
  startMonitor: (monitorId: number) => invoke<void>("start_monitor", { monitorId }),
  stopMonitor: (monitorId: number) => invoke<void>("stop_monitor", { monitorId }),
  removeMonitor: (monitorId: number) => invoke<void>("remove_monitor", { monitorId }),
  snapshotNow: (monitorId: number) => invoke<number | null>("snapshot_now", { monitorId }),
  deleteSnapshot: (snapshotId: number) => invoke<void>("delete_snapshot", { snapshotId }),
  setSnapshotLabel: (snapshotId: number, label: string) =>
    invoke<void>("set_snapshot_label", { snapshotId, label }),

  listSnapshots: (monitorId: number) => invoke<SnapshotRow[]>("list_snapshots", { monitorId }),
  previousSnapshot: (snapshotId: number) =>
    invoke<number | null>("previous_snapshot", { snapshotId }),
  changedFiles: (from: number, to: number) => invoke<FileChange[]>("changed_files", { from, to }),
  monitorBaseInfo: (monitorId: number) => invoke<BaseInfo>("monitor_base_info", { monitorId }),
  breakingPointChanges: (monitorId: number, snapshotId: number) =>
    invoke<FileChange[]>("breaking_point_changes", { monitorId, snapshotId }),
  snapshotWorkingChanges: (monitorId: number, snapshotId: number) =>
    invoke<FileChange[]>("snapshot_working_changes", { monitorId, snapshotId }),
  monitorFiles: (monitorId: number) => invoke<string[]>("monitor_files", { monitorId }),
  searchContent: (monitorId: number, options: SearchOptions) =>
    invoke<SearchResults>("search_content", { monitorId, options }),
  replaceMatch: (monitorId: number, spec: ReplaceMatchSpec) =>
    invoke<number>("replace_match", { monitorId, spec }),
  replaceAll: (monitorId: number, spec: ReplaceSpec) =>
    invoke<ReplaceSummary>("replace_all", { monitorId, spec }),
  terminalOpen: (cwd: string | null, cols: number, rows: number) =>
    invoke<number>("terminal_open", { cwd, cols, rows }),
  terminalWrite: (id: number, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: number, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  terminalClose: (id: number) => invoke<void>("terminal_close", { id }),
  lspStart: (root: string) => invoke<void>("lsp_start", { root }),
  lspSend: (root: string, body: string) => invoke<void>("lsp_send", { root, body }),
  lspStop: (root: string) => invoke<void>("lsp_stop", { root }),
  dapStart: (root: string) => invoke<number>("dap_start", { root }),
  dapSend: (id: number, body: string) => invoke<void>("dap_send", { id, body }),
  dapStop: (id: number) => invoke<void>("dap_stop", { id }),
  runStart: (cwd: string, program: string, args: string[], env: Record<string, string> = {}) =>
    invoke<number>("run_start", { cwd, program, args, env: Object.entries(env) }),
  runStop: (id: number) => invoke<void>("run_stop", { id }),
  openPath: (monitorId: number, path: string) => invoke<void>("open_path", { monitorId, path }),
  revealPath: (monitorId: number, path: string) => invoke<void>("reveal_path", { monitorId, path }),
  deletePath: (monitorId: number, path: string) => invoke<void>("delete_path", { monitorId, path }),
  baseFile: (monitorId: number, snapshotId: number, path: string) =>
    invoke<string | null>("base_file", { monitorId, snapshotId, path }),
  snapshotSummaries: (monitorId: number) =>
    invoke<ChangeSummary[]>("snapshot_summaries", { monitorId }),
  snapshotSummariesUnder: (monitorId: number, prefix: string) =>
    invoke<ChangeSummary[]>("snapshot_summaries_under", { monitorId, prefix }),
  gitResetFile: (monitorId: number, path: string) =>
    invoke<void>("git_reset_file", { monitorId, path }),
  gitResetFolder: (monitorId: number, prefix: string, removeExtraneous: boolean) =>
    invoke<void>("git_reset_folder", { monitorId, prefix, removeExtraneous }),
  snapshotFiles: (snapshotId: number) => invoke<string[]>("snapshot_files", { snapshotId }),
  fileAt: (snapshotId: number, path: string) =>
    invoke<string | null>("file_at", { snapshotId, path }),
  workingFile: (monitorId: number, path: string) =>
    invoke<string | null>("working_file", { monitorId, path }),
  writeWorkingFile: (monitorId: number, path: string, content: string) =>
    invoke<void>("write_working_file", { monitorId, path, content }),
  readTextFile: (path: string) => invoke<string | null>("read_text_file", { path }),
  fileHunks: (snapshotId: number, path: string) =>
    invoke<HunkInfo[]>("file_hunks", { snapshotId, path }),
  textHunks: (left: string, right: string) => invoke<HunkInfo[]>("text_hunks", { left, right }),
  applyTextRevert: (monitorId: number, path: string, left: string, right: string, selected: number[]) =>
    invoke<void>("apply_text_revert", { monitorId, path, left, right, selected }),

  revertFile: (snapshotId: number, path: string) =>
    invoke<void>("revert_file", { snapshotId, path }),
  revertFolder: (snapshotId: number, prefix: string, removeExtraneous: boolean) =>
    invoke<void>("revert_folder", { snapshotId, prefix, removeExtraneous }),
  revertHunks: (snapshotId: number, path: string, selected: number[]) =>
    invoke<void>("revert_hunks", { snapshotId, path, selected }),

  getSettings: () => invoke<Settings>("get_settings"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),

  pickFolder: () => invoke<string | null>("pick_folder"),

  gitListRefs: (repoPath: string) => invoke<RefList>("git_list_refs", { repoPath }),
  gitChangedFiles: (repoPath: string, from: string, to: string) =>
    invoke<GitFileChange[]>("git_changed_files", { repoPath, from, to }),
  gitFile: (repoPath: string, rev: string, path: string) =>
    invoke<string | null>("git_file", { repoPath, rev, path }),
  gitFileHunks: (repoPath: string, from: string, to: string, path: string) =>
    invoke<HunkInfo[]>("git_file_hunks", { repoPath, from, to, path }),
  gitRevertHunks: (repoPath: string, from: string, to: string, path: string, selected: number[]) =>
    invoke<void>("git_revert_hunks", { repoPath, from, to, path, selected }),
  gitWriteWorking: (repoPath: string, path: string, content: string) =>
    invoke<void>("git_write_working", { repoPath, path, content }),
  gitDiscardFile: (repoPath: string, path: string) =>
    invoke<void>("git_discard_file", { repoPath, path }),
  gitStatus: (repoPath: string) => invoke<WorkingStatus>("git_status", { repoPath }),
  gitStage: (repoPath: string, paths: string[]) => invoke<void>("git_stage", { repoPath, paths }),
  gitUnstage: (repoPath: string, paths: string[]) => invoke<void>("git_unstage", { repoPath, paths }),
  gitCommit: (repoPath: string, message: string) => invoke<string>("git_commit", { repoPath, message }),
  gitConflicts: (repoPath: string) => invoke<string[]>("git_conflicts", { repoPath }),
  gitResolveConflict: (repoPath: string, path: string, content: string) =>
    invoke<void>("git_resolve_conflict", { repoPath, path, content }),

  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  autostartEnabled: () => invoke<boolean>("autostart_enabled"),

  resourceUsage: () => invoke<ResourceUsage>("resource_usage"),
};
